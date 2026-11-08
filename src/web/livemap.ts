/// The live map: every tram, bus and regional train, as a dot colored by how late it is, with the stretch of
// track it is on in the same color (like a traffic layer). Positions are estimates, not GPS.
// Data (livedata.ts): Bonn, Köln and Düsseldorf each come as one /api/city answer, all three every minute
// while the page is visible, so switching cities is instant. Map views outside the city boxes add
// /api/vehicles tiles, for drawing only. The overview shows the chosen cities (one or more, each toggled on its
// own button): everything inside their official limits, from each city's own answer, whatever the map shows. Regional trains are drawn but not counted.
// Without a map (no WebGL), the overview still works.

import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type * as maplibregl from "maplibre-gl";
import { CITY_WINDOW_MS, VEHICLES_WINDOW_MS } from "../worker/transitous";
import { isLive, onResume } from "./activity";
import { collectNotices } from "./alerts";
import { badgeTextColor } from "./departures";
import { type Mode, fetchCity, fetchTrip, fetchVehicles, isStale } from "./api";
import {
  ALL_GROUPS,
  DELAY_COLORS,
  FILTER_GROUPS,
  type DelayClass,
  type Filters,
  type ModeGroup,
  classCounts,
  delayHistogram,
  lateMedian,
  liveByGroup,
  delayClass,
  destinationsNeeded,
  type FailedLookup,
  isCounted,
  isUnusual,
  lookupFailed,
  retryDue,
  MIN_LIVE_FOR_SHARE,
  lineDetail,
  lineKeyOf,
  modeGroup,
  passes,
  roundedClass,
  wholeMinutes,
  positionsAt,
  trackAhead,
  trackRank,
  withSbahn,
  worstTramLines,
} from "./fleet";
import { CITIES, CITY_BOXES, CITY_IDS, type CityId, cityOf, coveredByCities } from "./cities";
import { type LiveRef, liveHash } from "./endpoints";
import { stopName } from "./names";
import { onLiveLinkPasted, setLive } from "./nav";
import { type RichText, onLangChange, t } from "./i18n";
import { type CityAnalysis, combineAnalyses, createLiveData, hasNumbers } from "./livedata";
import { type LineSample, newSample, noticeView, planSample, sampleDone } from "./linesample";
import { button, el, noticeList, requestClose, shareLink } from "./panel";
import { tripRoute } from "./trip";
import { type Box, MAX_TILES, tileBox, tileKey, tilesToFetch } from "./tiles";
import type { TripRef } from "./tripcard";
import type { PreparedTrip, VehiclePosition } from "./vehicles";

export const FLEET_LAYER = "fleet-dot";
const FLEET_SOURCE = "fleet";
const TRACK_SOURCE = "fleet-track";
const STOPS_FIRST_LAYER = "stop-dot"; // the colored track goes under the stops

const FETCH_TIMEOUT_MS = 20_000;
const FRAME_MS = 1_000; // dots move once a second
const TRACK_MS = 5_000; // the colored track and the overview follow every 5 seconds
const CHECK_MS = 5_000; // how often to look for cities and tiles that are due
const STALE_AFTER_S = 180; // older data is called old
const MAX_NOTICES = 3;
const MAX_DETAIL_ROWS = 8; // vehicles listed for a picked line
const DIRECTION_FETCHES = 3; // destination lookups at once
const DIRECTION_CACHE = 3000; // destinations kept (a trip never changes it); more: start over
const CLASS_ORDER: DelayClass[] = ["ontime", "slight", "late", "verylate", "unknown"];
const LIVE_ORDER: DelayClass[] = ["ontime", "slight", "late", "verylate"]; // the classes with live data

const cityName = (id: CityId): string => t().cityNames[id]; // "Köln" in German, "Cologne" in English
const cityNames = (ids: CityId[]): string => t().cityList(ids.map(cityName)); // "Bonn and Cologne"

// The part of `a` inside `b` (empty boxes come out inverted, which no city box contains).
const overlap = (a: Box, b: Box): Box => ({
  south: Math.max(a.south, b.south),
  north: Math.min(a.north, b.north),
  west: Math.max(a.west, b.west),
  east: Math.min(a.east, b.east),
});

// `map`: null when the map could not start; the overview works without it.
// `link`: a shared live overview link (endpoints.ts) to open: its city, kinds and picked line.
export function startLiveMap(map: maplibregl.Map | null, onVehicleTap: (ref: TripRef) => void, link: LiveRef | null = null): void {
  const data = createLiveData({
    fetchCity,
    fetchTile: fetchVehicles,
    cityWindowMs: CITY_WINDOW_MS,
    tileWindowMs: VEHICLES_WINDOW_MS,
    onChange: () => frame(true),
  });
  let fleet: PreparedTrip[] = []; // what the map draws (cities and tiles); never used for the numbers
  // Each city's numbers, from its own answer (livedata.ts), redone with the overview.
  let analyses = {} as Record<CityId, CityAnalysis>;
  let current = {} as Omit<CityAnalysis, "id">; // the chosen city's, or the chosen ones together
  let counted: VehiclePosition[] = []; // the chosen cities' counted vehicles of the chosen kinds
  let shown: VehiclePosition[] = []; // what the map draws: every vehicle of the chosen kinds
  let ready = false;
  let lastTrackMs = 0;

  // The cities the numbers describe (at least one, in CITY_IDS order): a shared link's, else the one where the
  // map starts, else Köln. Moving the map does not change them.
  const start = map?.getCenter();
  const startCity = (start ? cityOf(start.lng, start.lat) : null) ?? "koeln";
  let selected: CityId[] = link?.cities ?? [startCity];

  const filters: Filters = { groups: withSbahn(link?.groups ?? ALL_GROUPS) };
  let highlight: string | null = link?.line ?? null; // a line key ("TRAM|16") from the line list
  // The highlighted line's notices, from one sample trip in the city (linesample.ts).
  let lineInfo: LineSample | null = highlight ? newSample(highlight, highlight.slice(highlight.indexOf("|") + 1)) : null;
  let noticesDrawn = ""; // what the notice section shows, so it is only redrawn (and read out) when it changes
  let lastStatus = ""; // what the screen reader was last told (only changes are announced)
  let folded = !wideLayout(); // phones: the bar starts folded
  // The info tab open at the top, if any. Kept in memory only, so a language switch keeps it; a new visit starts
  // with all of them closed (nothing stored).
  let infoTab: string | null = null;
  let published = ""; // the overview state last given to nav.ts (publish); set before the first publish()
  // Each trip's destination (map/trips does not send it), from one /api/trip per trip, for the most delayed
  // list's directions. null: the trip has none, or the lookup failed (tried again later, failedLookups).
  const destinations = new Map<string, string | null>();
  const failedLookups = new Map<string, FailedLookup>();
  const asking = new Set<string>();
  let destTimer = 0;

  const box = document.querySelector<HTMLElement>("#live")!;
  analyze();
  let ui = buildBox();
  render(); // "loading..." until the first city answer is in
  sync(); // the city answers do not wait for the map
  publish(); // the address shows the overview (nav.ts writes it once it starts)

  // Crossing between the column and the bar (rotating a tablet, resizing a window): the map's box changed.
  window.matchMedia(RAIL_QUERY).addEventListener("change", () => {
    map?.resize();
    render();
  });
  // Phones: the map's scale and credits sit above the bar, not under it (style.css reads --live-bar-h).
  new ResizeObserver(() => {
    const h = wideLayout() || box.hidden ? 0 : box.offsetHeight;
    document.documentElement.style.setProperty("--live-bar-h", `${h}px`);
  }).observe(box);

  if (map) {
    map.on("load", () => {
      addLayers(map);
      ready = true;
      if (link) showCity(selected); // a shared link: show its city
      sync();
    });
    map.on("moveend", sync);
  }
  setInterval(sync, CHECK_MS);
  setInterval(() => frame(false), FRAME_MS);
  onResume(sync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
  onLangChange(() => {
    ui = buildBox();
    render();
  });

  // Pick a line in the list (or none): highlight it and show its detail instead of the list; its notices
  // follow (sampleNotices).
  function setHighlight(key: string | null, line = ""): void {
    highlight = key;
    lineInfo = key ? newSample(key, line) : null;
    changed();
  }

  // A city button switches that city in or out of the numbers; its numbers show at once (all three are kept
  // loaded). The last city left cannot be switched off: no city would be no numbers. A picked line belongs to
  // the old choice. The map shows the chosen cities.
  function toggleCity(id: CityId): void {
    const on = selected.includes(id);
    if (on && selected.length === 1) return;
    selected = CITY_IDS.filter((c) => (c === id ? !on : selected.includes(c)));
    highlight = null;
    lineInfo = null;
    changed();
    if (ready) showCity(selected);
  }

  // A highlighted line needs (another) sample trip for its notices: take one of its vehicles in the city.
  // Only while the page is live (visible and not idle; render() also runs from the timers of a hidden tab).
  function sampleNotices(inCityNow: VehiclePosition[]): void {
    if (!lineInfo || lineInfo.key !== highlight) return;
    const plan = planSample(lineInfo, inCityNow, Date.now(), isLive());
    lineInfo = plan.sample;
    const attempt = plan.fetch;
    if (!attempt) return;
    const key = lineInfo.key;
    const done = (answer: Parameters<typeof sampleDone>[2]) => {
      if (lineInfo?.key !== key) return; // another line was picked meanwhile
      lineInfo = sampleDone(lineInfo, attempt, answer, Date.now());
      render();
    };
    fetchTrip(attempt.tripId, AbortSignal.timeout(FETCH_TIMEOUT_MS))
      .then((res) => {
        const route = tripRoute(res.data);
        const notices = route ? collectNotices([route.alerts, ...route.stops.map((s) => s.alerts)], Date.now()) : [];
        done({ notices, to: route?.headsign ? stopName(route.headsign) : null, stale: isStale(res) });
      })
      .catch(() => done(null));
  }

  // Only the trips that can change the most delayed list need their destination (destinationsNeeded): a few
  // lookups at a time, each trip once (a failed one again later, if the list still needs it), only while the page
  // is visible. The list redraws once a batch is in.
  function askDestinations(inCityNow: VehiclePosition[]): void {
    if (!isLive()) return;
    if (destinations.size > DIRECTION_CACHE) {
      destinations.clear();
      failedLookups.clear();
    }
    for (const [id, failed] of failedLookups) if (retryDue(failed, Date.now())) destinations.delete(id);
    for (const id of destinationsNeeded(inCityNow, (tripId) => destinations.get(tripId), Date.now())) {
      if (asking.size >= DIRECTION_FETCHES) return;
      if (asking.has(id)) continue;
      asking.add(id);
      fetchTrip(id, AbortSignal.timeout(FETCH_TIMEOUT_MS))
        .then((res) => {
          const to = tripRoute(res.data)?.headsign;
          destinations.set(id, to ? stopName(to) : null);
          failedLookups.delete(id);
        })
        .catch(() => {
          destinations.set(id, null);
          failedLookups.set(id, lookupFailed(failedLookups.get(id), Date.now()));
        })
        .finally(() => {
          asking.delete(id);
          clearTimeout(destTimer);
          destTimer = window.setTimeout(() => {
            askDestinations(counted);
            render();
          }, 300);
        });
    }
  }

  map?.on("click", FLEET_LAYER, (e) => {
    // The trip card's own vehicle is drawn on top: a tap there is for it.
    if (map.getLayer("vehicle-dot") && map.queryRenderedFeatures(e.point, { layers: ["vehicle-dot"] }).length) return;
    const props = e.features?.[0]?.properties;
    if (typeof props?.["tripId"] !== "string") return;
    onVehicleTap({ tripId: props["tripId"], line: String(props["line"] ?? ""), color: String(props["color"]), focus: null });
  });
  map?.on("mouseenter", FLEET_LAYER, () => (map.getCanvas().style.cursor = "pointer"));
  map?.on("mouseleave", FLEET_LAYER, () => (map.getCanvas().style.cursor = ""));

  // Fetch what is due: all three cities every minute (the selected one first), and the tiles of the part of
  // the view outside the city boxes (none when the view is inside one, or zoomed out too far).
  function sync(): void {
    if (map && ready) {
      const b = map.getBounds();
      const v: Box = { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
      const wanted = tilesToFetch(v, map.getZoom(), MAX_TILES).tiles.filter((tile) => !coveredByCities(overlap(tileBox(tile), v)));
      data.setWanted(wanted.map(tileKey));
    }
    data.sync(selected[0]!, isLive());
    frame(true);
  }

  // Each city's numbers for the chosen kinds, from its own answer only (tiles never change them).
  function analyze(): void {
    const next = {} as Record<CityId, CityAnalysis>;
    for (const id of CITY_IDS) next[id] = data.analysis(id, filters.groups);
    analyses = next;
    current = selected.length === 1 ? next[selected[0]!] : combineAnalyses(selected.map((id) => next[id]));
    counted = current.vehicles;
  }

  function frame(force: boolean): void {
    if (!force && document.visibilityState !== "visible") return;
    const now = Date.now();
    if (map) {
      fleet = data.drawnFleet();
      shown = positionsAt(fleet, now).filter((v) => passes(v, filters));
      if (ready) setSource(map, FLEET_SOURCE, dots(shown, highlight));
    }
    if (force || now - lastTrackMs >= TRACK_MS) {
      lastTrackMs = now;
      if (map && ready) setSource(map, TRACK_SOURCE, tracks(fleet, shown, now, highlight));
      analyze();
      render();
    }
  }

  // A filter, the city or the highlighted line changed: draw again right away, and the address follows
  // (nav.ts: no history entry, so a reload or a copied address keeps the overview).
  function changed(): void {
    frame(true);
    publish();
  }

  function liveRef(): LiveRef {
    return { cities: selected, groups: ALL_GROUPS.filter((g) => filters.groups.has(g)), line: highlight };
  }
  function publish(): void {
    const ref = liveRef();
    const text = liveHash(ref);
    if (text === published) return;
    published = text;
    setLive(ref);
  }

  // An overview link pasted into this tab's address bar: its cities, kinds and line, at once.
  onLiveLinkPasted((ref) => {
    selected = ref.cities;
    filters.groups = withSbahn(ref.groups);
    highlight = ref.line;
    lineInfo = highlight ? newSample(highlight, highlight.slice(highlight.indexOf("|") + 1)) : null;
    changed();
    if (ready) showCity(selected);
  });

  // Show the chosen cities whole (their boxes). On phones the bar covers the bottom of the map: the cities go
  // above it.
  function showCity(ids: CityId[]): void {
    if (!map) return;
    const boxes = ids.map((c) => CITY_BOXES[c]);
    const b: Box = {
      south: Math.min(...boxes.map((x) => x.south)),
      north: Math.max(...boxes.map((x) => x.north)),
      west: Math.min(...boxes.map((x) => x.west)),
      east: Math.max(...boxes.map((x) => x.east)),
    };
    const cover = wideLayout() ? 0 : box.offsetHeight;
    map.fitBounds(
      [
        [b.west, b.south],
        [b.east, b.north],
      ],
      { padding: { top: 20, right: 20, left: 20, bottom: cover + 20 }, duration: 800 },
    );
  }

  // The parts of the overview that stay; render() fills in what changes. Top to bottom: what the numbers
  // cover, the headline share ("80 % on time") and how complete it is, then the details: the bar (one per city
  // when several are chosen), the table by status, the filters, on time per kind as bars, then "Delays" (how late
  // the late ones are, by minutes, and the most delayed lines), the share link and about these numbers.
  // Folded (phones): up to the headline plus a one-line legend.
  function buildBox() {
    const tx = t();
    const head = el("div", "live-head");
    const title = el("h2", "live-title", tx.liveTitle);
    const fold = button("live-fold", "");
    fold.setAttribute("aria-controls", "live-body");
    fold.addEventListener("click", () => {
      folded = !folded;
      render();
    });

    // The city buttons switch each city in or out of the numbers (and the map shows the chosen ones).
    const cityGroup = el("div", "live-cities");
    cityGroup.setAttribute("role", "group");
    cityGroup.setAttribute("aria-label", tx.cityLabel);
    const cityButtons = CITIES.map((city) => {
      const btn = button("live-city live-toggle", cityName(city.id));
      btn.addEventListener("click", () => toggleCity(city.id));
      return [city.id, btn] as const;
    });
    cityGroup.append(...cityButtons.map(([, b]) => b));
    head.append(el("span", "live-pulse"), title, cityGroup, fold);

    const scope = el("p", "live-scope");
    const headline = el("h3", "live-headline");
    const pct = el("strong", "live-pct");
    const caption = el("span", "live-caption");
    headline.append(pct, caption);
    // The health line changes every few seconds (the data's age): not read out. Screen readers hear only
    // when the state changes (loaded, partly loaded, failed), from the hidden line next to it.
    const health = el("p", "live-health");
    const status = el("p", "sr-only");
    status.setAttribute("aria-live", "polite");
    // A link to this overview.
    const share = button("live-share-link", tx.shareLiveButton);
    share.addEventListener("click", () => {
      void shareLink(`${location.origin}${location.pathname}#${liveHash(liveRef())}`, t().pageTitle, t().shareLiveNote);
    });
    // Phones with a stop, trip or route open: only this one line stays, at the top of the map, with the
    // city's data warning. Tapping it closes the panel: the full overview is back.
    const strip = button("live-strip", "");
    strip.addEventListener("click", () => requestClose());

    // Folded on a phone: the colors in one line, and that positions are estimates.
    const mini = el("p", "live-mini");
    for (const cls of CLASS_ORDER) {
      const swatch = el("span", "live-swatch");
      swatch.style.background = DELAY_COLORS[cls];
      mini.append(el("span", "live-mini-item"));
      mini.lastElementChild!.append(swatch, miniText(cls));
    }
    mini.append(el("span", "live-mini-note", tx.liveEstimated));

    const body = el("div", "live-body");
    body.id = "live-body";

    // The bar is the picture of the vehicles with live data (the headline's base); with several cities, one bar
    // per city instead. The table under it says the same in numbers (all chosen cities together) and is the
    // legend. Timetable-only vehicles get a row of their own, outside the shares.
    const bar = el("div", "live-bar");
    bar.setAttribute("aria-hidden", "true");
    const cityBars = el("div", "live-rows");
    const dist = document.createElement("table");
    dist.className = "live-dist";
    dist.setAttribute("aria-label", tx.legendLabel);
    const distHead = document.createElement("tr");
    for (const text of [tx.tableStatus, tx.tableVehicles, tx.tableShare]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = text;
      distHead.append(th);
    }
    const distRow = (key: DelayClass | "total", label: string) => {
      const row = document.createElement("tr");
      const name = document.createElement("th");
      name.scope = "row";
      if (key !== "total") {
        const swatch = el("span", "live-swatch");
        swatch.style.background = DELAY_COLORS[key];
        name.append(swatch);
      }
      name.append(label);
      const count = document.createElement("td");
      const pctCell = document.createElement("td");
      row.append(name, count, pctCell);
      return { key, row, count, pct: pctCell };
    };
    const distRows = [
      ...LIVE_ORDER.map((cls) => distRow(cls, legendText(cls))),
      distRow("total", tx.tableLiveTotal),
      distRow("unknown", tx.tableUnknown),
    ];
    distRows.at(-2)!.row.className = "live-dist-total";
    const distBody = document.createElement("tbody");
    distBody.append(...distRows.map((r) => r.row));
    dist.append(distHead, distBody);

    const chips = el("div", "live-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", tx.filterLabel);
    const groupText: Record<ModeGroup, string> = { tram: tx.filterTram, bus: tx.filterBus, sbahn: tx.filterSbahn };
    const groupChips = FILTER_GROUPS.map((g) => {
      const chip = button("live-chip live-toggle", "");
      chip.append(kindIcon(g), groupText[g]);
      chip.addEventListener("click", () => {
        // The last chip left cannot be switched off: an empty map would look broken.
        if (filters.groups.has(g) && FILTER_GROUPS.every((x) => x === g || !filters.groups.has(x))) return;
        if (filters.groups.has(g)) filters.groups.delete(g);
        else filters.groups.add(g);
        changed();
      });
      return [g, chip] as const;
    });
    chips.append(...groupChips.map(([, c]) => c));

    // How many vehicles of each kind have live data, then a tile per kind: its share on time over the chosen
    // cities, and a small bar per city. Kind against kind, never one city's mix against another's.
    const liveShare = el("p", "live-share");
    const kindTitle = el("h3", "live-sub", tx.kindTitle);
    const kindBars = el("div", "live-tiles");
    const kindNote = el("p", "live-compare-note", tx.kindNote);
    // Only when every city is too quiet for a percentage (usually at night).
    const findings = el("p", "live-finding");

    // Second part, how late the late ones are, said in words first: their median, then the median per city on
    // one minute ruler (a dot for the whole city, the kind icons on the same row), then the late vehicles by
    // minutes late as a bar chart (its numbers are its label, for screen readers).
    const delays = el("section", "live-delays");
    const lead = el("p", "live-delay-lead");
    const leadNote = el("p", "live-delay-note");
    const rulerTitle = el("h4", "live-hist-title", tx.rulerTitle);
    const ruler = el("div", "live-ruler");
    const rulerAxis = el("div", "live-ruler-axis");
    const rulerLegend = el("p", "live-ruler-legend");
    const histTitle = el("h4", "live-hist-title", tx.histTitle);
    const hist = el("div", "live-hist");
    hist.setAttribute("role", "img");
    const histAxis = el("p", "live-hist-axis", tx.histAxis);
    delays.append(el("h3", "live-section", tx.delaysTitle), lead, leadNote, rulerTitle, ruler, rulerAxis, rulerLegend, histTitle, hist, histAxis);

    const worstTitle = el("h3", "live-sub", tx.worstTitle);
    worstTitle.tabIndex = -1; // focus lands here when the focused line drops out of the list
    const worst = el("ul", "live-worst live-worst-table");
    // Vehicles reporting 60+ min: left out of every number, said here.
    const stuck = el("p", "live-stuck");

    // A picked line, in place of the list: its vehicles on screen (each opens its trip), how many have live
    // data, the range of their delays, then the notices of one sample trip.
    const detail = el("section", "live-detail");
    const detailHead = el("div", "live-detail-head");
    const detailTitle = el("h3", "live-detail-title");
    detailTitle.tabIndex = -1; // focus lands here when a line is picked
    const back = button("live-showall", tx.detailBack);
    back.addEventListener("click", () => {
      setHighlight(null);
      ui.worstTitle.focus();
    });
    detailHead.append(detailTitle, back);
    const detailStats = el("p", "live-detail-stats");
    const detailRange = el("p", "live-detail-range");
    const detailRows = el("ul", "live-veh-list");
    const detailMore = el("p", "live-none");
    // Without the map a vehicle opens nothing (its trip needs the map): plain rows, and said so.
    detail.append(detailHead, detailStats, detailRange, detailRows, detailMore, el("p", "live-detail-note", map ? tx.detailNote : tx.detailNoteNoMap));

    const notices = el("div", "live-notices");
    notices.setAttribute("aria-live", "polite");

    // At the top: who made this, how it works (short, the full method folded inside), and the credits, as one
    // row of three equal tabs (user decision 2026-11-04). One opens at a time; its own tab closes it again.
    const howPoints = el("ul", "");
    for (const text of tx.infoHowPoints) howPoints.append(el("li", "", text));
    const details = document.createElement("details");
    details.className = "live-info-more";
    const allPoints = el("ul", "");
    for (const text of tx.aboutPoints) allPoints.append(el("li", "", text));
    details.append(el("summary", "", tx.infoHowMore), allPoints);
    const infoSections: { id: string; tab: string; title: string; content: Node[] }[] = [
      { id: "about", tab: tx.infoAboutTab, title: tx.infoAboutTitle, content: [richText(tx.infoAbout)] },
      { id: "how", tab: tx.infoHowTab, title: tx.infoHowTitle, content: [howPoints, details] },
      { id: "credits", tab: tx.infoCreditsTab, title: tx.infoCreditsTitle, content: [richText(tx.infoCredits)] },
    ];
    const infoTabs = el("div", "live-info-tabs");
    const info = el("div", "live-info");
    const infoParts = infoSections.map(({ id, tab, title, content }) => {
      const panel = el("div", "live-info-panel");
      panel.id = `live-info-${id}`;
      panel.append(el("h3", "live-info-title", title), ...content);
      const btn = button("live-info-tab", tab);
      btn.setAttribute("aria-controls", panel.id);
      btn.addEventListener("click", () => {
        infoTab = infoTab === id ? null : id;
        showInfoTab();
      });
      infoTabs.append(btn);
      return { id, btn, panel };
    });
    const showInfoTab = () => {
      for (const { id, btn, panel } of infoParts) {
        btn.setAttribute("aria-expanded", String(infoTab === id));
        panel.hidden = infoTab !== id;
      }
    };
    showInfoTab();
    info.append(infoTabs, ...infoParts.map((part) => part.panel));

    // Hovering a part of a bar (or tapping it) says what it is: "6-10 min: 19 vehicles (12 %)".
    const tip = el("div", "live-tip");
    tip.setAttribute("aria-hidden", "true");
    tip.hidden = true;
    const showTip = (e: PointerEvent) => {
      const part = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
      if (!part) {
        tip.hidden = true;
        return;
      }
      tip.textContent = part.dataset["tip"]!;
      tip.hidden = false;
      const at = body.getBoundingClientRect();
      const x = Math.min(e.clientX - at.left, body.clientWidth - tip.offsetWidth);
      tip.style.left = `${Math.max(0, x)}px`;
      tip.style.top = `${e.clientY - at.top - tip.offsetHeight - 10}px`;
    };
    body.addEventListener("pointermove", showTip);
    body.addEventListener("pointerdown", showTip);
    body.addEventListener("pointerleave", () => (tip.hidden = true));

    body.append(
      bar, cityBars, dist, liveShare, findings, chips, kindTitle, kindBars, kindNote,
      delays, worstTitle, worst, stuck, detail, notices, share, tip,
    );
    box.replaceChildren(strip, info, head, scope, headline, health, status, mini, body);
    box.hidden = false;
    lastStatus = "";
    noticesDrawn = ""; // new, empty section (language switch)
    return {
      fold, info, cityButtons, scope, pct, caption, health, status, body, bar, cityBars, distRows,
      groupChips, worstTitle, worst, detail, detailTitle, detailStats, detailRange, detailRows, detailMore,
      notices, findings, liveShare, kindTitle, kindBars, kindNote,
      strip, delays, lead, leadNote, rulerTitle, ruler, rulerAxis, rulerLegend, hist, histTitle, histAxis,
      stuck, share,
    };
  }

  function render(): void {
    const tx = t();
    const rail = wideLayout();
    const isFolded = folded && !rail;
    ui.fold.hidden = rail;
    ui.fold.setAttribute("aria-expanded", String(!isFolded));
    ui.fold.setAttribute("aria-label", isFolded ? tx.liveUnfold : tx.liveFold);
    ui.fold.textContent = isFolded ? "▴" : "▾";
    ui.body.hidden = ui.info.hidden = isFolded;
    box.classList.toggle("folded", isFolded);

    for (const [id, btn] of ui.cityButtons) btn.setAttribute("aria-pressed", String(selected.includes(id)));
    const kinds = ALL_GROUPS.filter((g) => filters.groups.has(g)).map((g) => scopeText(g));
    const where = selected.length === 1 ? tx.cityScope(cityName(selected[0]!)) : cityNames(selected);
    ui.scope.textContent = [where, kinds.join(", ")].join(" · ");

    const health = healthText(counted);
    ui.pct.textContent = health.pct ?? "";
    ui.pct.hidden = health.pct === null;
    ui.caption.textContent = health.caption;
    ui.health.textContent = health.detail;
    ui.health.hidden = health.detail === "";
    ui.health.classList.toggle("warn", health.warn);
    if (health.status !== lastStatus) {
      lastStatus = health.status;
      ui.status.textContent = health.status;
    }
    renderDist(counted);
    renderDelays(counted);
    const hasData = health.pct !== null || counted.length > 0;
    // Nothing to share yet; shown once the numbers are in, so it does not jump down as they fill the column.
    ui.share.hidden = !hasData;
    ui.strip.classList.toggle("warn", health.warn);
    // The warning first: on a narrow phone the line is cut at the end, and the numbers may go, the warning not.
    ui.strip.textContent = [
      health.warning ? `⚠ ${health.warning}` : null,
      selected.map(cityName).join(", "),
      health.pct ? `${health.pct} ${tx.miniOnTime}` : health.caption,
    ]
      .filter(Boolean)
      .join(" · ");
    ui.strip.setAttribute("aria-label", tx.stripLabel(ui.strip.textContent));
    renderFindings();
    renderLiveShare(hasData);
    renderKinds();

    for (const [g, chip] of ui.groupChips) chip.setAttribute("aria-pressed", String(filters.groups.has(g)));

    // No vehicles (loading, all filtered away): no verdict on lines either. A picked line shows its detail
    // instead of the list.
    const picked = highlight !== null;
    ui.worstTitle.hidden = ui.worst.hidden = picked || counted.length === 0;
    ui.stuck.hidden = picked || !current.unusual;
    ui.stuck.textContent = current.unusual ? tx.stuckNote(current.unusual) : "";
    ui.detail.hidden = !picked;
    if (picked) renderDetail(counted);
    else renderWorst(counted);
    sampleNotices(counted);
    renderNotices();
  }

  // The notice section is a live region: it is only redrawn when what it says changes, not with every
  // overview update, so screen readers hear it once.
  function renderNotices(): void {
    const tx = t();
    const nv = lineInfo && lineInfo.key === highlight ? noticeView(lineInfo) : null;
    const drawn = JSON.stringify(nv);
    if (drawn === noticesDrawn) return;
    noticesDrawn = drawn;
    if (!nv) {
      ui.notices.replaceChildren();
      return;
    }
    const parts: Node[] = [el("h3", "live-sub", tx.lineNoticesTitle(nv.line, nv.kind === "list" ? nv.to : null))];
    if (nv.kind !== "list") {
      const text = { loading: tx.lineNoticesLoading, failed: tx.lineNoticesFailed, none: tx.lineNoticesNoVehicle }[nv.kind];
      parts.push(el("p", "live-none", text));
    } else {
      if (nv.previous) parts.push(el("p", "live-none warn", tx.lineNoticesPrevious));
      parts.push(noticeList(nv.notices, MAX_NOTICES) ?? el("p", "live-none", tx.lineNoticesNone));
      if (nv.stale) parts.push(el("p", "live-none", tx.dataOld));
    }
    ui.notices.replaceChildren(...parts);
  }

  // The headline (share punctual, or what is going on instead), the line under it (of how many vehicles with
  // live data, how many timetable only, how old, and a warning when the city's answer failed or is old), and
  // the short state for screen readers. A failed answer never looks like a full picture.
  function healthText(inCityNow: VehiclePosition[]): {
    pct: string | null;
    caption: string;
    detail: string;
    warn: boolean;
    status: string;
    warning: string | null; // the city's data is old or its refresh failed
  } {
    const tx = t();
    const note = (text: string, warn = false) => ({ pct: null, caption: text, detail: "", warn, status: text, warning: null });
    const now = Date.now();
    const a = current;
    if (!hasNumbers(a.state)) {
      // Failed only when the try failed and no new one is on its way.
      const failed = a.state === "failed" || a.state === "expired";
      return note(failed ? tx.liveFailed : tx.liveLoading, failed);
    }

    const sum = a.summary;
    const ageS = Math.max(0, Math.round((now - a.fetchedAtMs!) / 1000));
    let warning: string | null = null;
    if (ageS > STALE_AFTER_S) warning = tx.dataOld;
    else if (a.state === "partial") warning = tx.partialData;
    else if (a.state !== "ok") warning = tx.refreshFailed;
    // Too few live vehicles: no share, only the counts (one vehicle would swing it).
    const enough = sum.live >= MIN_LIVE_FOR_SHARE;
    const dropped = a.dropped ? tx.droppedEntries(a.dropped) : null; // always said, also under the threshold
    const unknown = sum.vehicles - sum.live;
    const detail = [
      enough ? tx.liveBase(sum.live) : tx.liveCoverage(sum.live, sum.vehicles),
      enough && unknown ? tx.liveTimetableOnly(unknown) : null,
      dropped,
      tx.updated(ageS),
      warning,
    ]
      .filter(Boolean)
      .join(" · ");
    const share = enough ? Math.round((sum.onTime / sum.live) * 100) : null;
    return {
      pct: share !== null ? tx.livePct(share) : null,
      caption: enough ? tx.liveHeadlineCaption : sum.live ? tx.liveTooFew(sum.live) : tx.liveNoLiveData,
      detail,
      warn: warning !== null,
      status: warning ?? tx.liveLoaded,
      warning,
    };
  }

  // The bar by color over the vehicles with live data (one per city when several are chosen), and the table:
  // each status's count and its share of the vehicles with live data (the same base as the headline), their
  // total, and the timetable-only ones (count only, no share). Without vehicles the table is just the legend.
  function renderDist(inView: VehiclePosition[]): void {
    const counts = classCounts(inView);
    const total = inView.length;
    const live = total - counts.unknown;
    const several = selected.length > 1;
    ui.bar.hidden = several || live === 0;
    ui.bar.replaceChildren(...barParts(counts));
    ui.cityBars.hidden = !several;
    if (several) ui.cityBars.replaceChildren(...selected.map((id) => cityRow(id, analyses[id].vehicles, cityName(id))));
    for (const r of ui.distRows) {
      const n = r.key === "total" ? live : counts[r.key];
      r.count.textContent = total ? String(n) : "";
      r.pct.textContent = !total ? "" : r.key === "unknown" || !live ? "-" : t().livePct(Math.round((n / live) * 100));
    }
  }

  // One row of a bar chart: a label (or none), the bar by color with the share on time after it. Under 10 live
  // vehicles no bar and no share, only why; a city without numbers says it is loading or failed. `id`: the
  // city the vehicles come from, for its state.
  function cityRow(id: CityId, vehicles: VehiclePosition[], label: string | null, icon: Node | null = null): HTMLElement {
    const tx = t();
    const row = el("div", "live-row");
    const name = el("span", "live-row-name");
    if (icon) name.append(icon);
    if (label) name.append(label);
    const state = analyses[id].state;
    if (state === "stale" || state === "refreshFailed" || state === "partial") {
      const warn = el("span", "live-compare-warn", `⚠ ${state === "partial" ? tx.comparePartial : tx.compareStale}`);
      warn.title = state === "partial" ? tx.comparePartialLabel : tx.compareStaleLabel;
      name.append(warn);
    }
    row.append(name);
    const counts = classCounts(vehicles);
    const live = vehicles.length - counts.unknown;
    if (!hasNumbers(state) || live < MIN_LIVE_FOR_SHARE) {
      const why = !hasNumbers(state)
        ? state === "failed" || state === "expired"
          ? tx.compareFailed
          : tx.compareLoading
        : `${tx.compareTooFew} (${tx.kindLive(live)})`;
      row.append(el("span", "live-row-why", why));
      return row;
    }
    const pct = tx.livePct(Math.round((counts.ontime / live) * 100));
    const bar = el("div", "live-bar live-row-bar");
    bar.append(...barParts(counts));
    const value = el("span", "live-row-val", pct);
    value.append(el("span", "live-row-sub", tx.kindLive(live)));
    row.append(bar, value);
    if (label) row.setAttribute("aria-label", tx.cityRowLabel(label, pct));
    return row;
  }

  // "Delays": how late the late vehicles (2+ min) are, in words first. Their median from 10 of them on (else
  // their count and why there is no median), then each chosen city on one minute ruler (renderRuler). Then the
  // late ones by minutes late. Hidden while the cities have no numbers.
  function renderDelays(inCityNow: VehiclePosition[]): void {
    const tx = t();
    ui.delays.hidden = !hasNumbers(current.state) || inCityNow.length === 0;
    if (ui.delays.hidden) return;
    const lm = lateMedian(inCityNow);
    const enough = lm.medianSec !== null;
    ui.lead.textContent = enough ? tx.lateTypical(wholeMinutes(lm.medianSec!)) : `${lm.late} ${tx.lateTooFew(lm.late)}`;
    if (lm.late === 0) ui.lead.textContent = tx.lateTooFew(0);
    ui.leadNote.textContent = enough ? tx.lateMedianLabel(lm.late) : "";
    ui.leadNote.hidden = !enough;
    renderRuler();

    const bins = delayHistogram(inCityNow);
    const max = Math.max(...bins.map((b) => b.count));
    ui.hist.hidden = ui.histTitle.hidden = ui.histAxis.hidden = max === 0;
    const name = (b: { from: number; to: number | null }) => (b.to === null ? `${b.from}+` : `${b.from}-${b.to}`);
    ui.hist.setAttribute("aria-label", tx.histLabel(bins.map((b) => tx.histItem(name(b), b.count)).join(", ")));
    ui.hist.replaceChildren(
      ...bins.map((b, i) => {
        const col = el("div", "live-hist-col");
        const area = el("div", "live-hist-area");
        const barEl = el("span", "live-hist-bar");
        barEl.style.height = `${Math.round((b.count / max) * HIST_BAR_PX)}px`; // max > 0: the chart is hidden otherwise
        barEl.style.background = HIST_COLORS[i]!;
        area.append(el("span", "live-hist-count", b.count ? String(b.count) : ""), barEl);
        col.append(area, el("span", "live-hist-min", name(b)));
        return col;
      }),
    );
  }

  // The ruler: a row per chosen city (with numbers), its late vehicles' median as a dot and the median of each
  // kind with a chip (while it is on) as its icon, on one scale from 0 to 10 min (further in steps of 5 when a
  // median is later). A median from too few is left off. Hidden when no city has a median of its own.
  function renderRuler(): void {
    const tx = t();
    const kinds = FILTER_GROUPS.filter((g) => filters.groups.has(g));
    const rows = selected
      .filter((id) => hasNumbers(analyses[id].state))
      .map((id) => {
        const vs = analyses[id].vehicles;
        const minutes = (g?: ModeGroup) => {
          const m = lateMedian(vs, g).medianSec;
          return m === null ? null : wholeMinutes(m);
        };
        return { id, city: minutes(), kinds: kinds.map((g) => ({ g, min: minutes(g) })) };
      });
    const all = rows.flatMap((r) => [r.city, ...r.kinds.map((k) => k.min)]).filter((m): m is number => m !== null);
    const hidden = !rows.some((r) => r.city !== null);
    ui.rulerTitle.hidden = ui.ruler.hidden = ui.rulerAxis.hidden = ui.rulerLegend.hidden = hidden;
    if (hidden) return;
    const max = Math.max(10, Math.ceil(Math.max(...all) / 5) * 5);
    const at = (m: number) => `${(Math.min(m, max) / max) * 100}%`;
    ui.ruler.replaceChildren(
      ...rows.map((r) => {
        const row = el("div", "live-ruler-row");
        const name = el("span", "live-ruler-name", cityName(r.id));
        name.append(el("span", "live-ruler-val", r.city === null ? tx.lateByTooFew : tx.detailDelay(r.city)));
        const track = el("div", "live-ruler-track");
        for (const k of r.kinds) {
          if (k.min === null) continue;
          const mark = el("span", `live-ruler-kind live-ruler-${k.g}`);
          mark.style.left = at(k.min);
          mark.append(kindIcon(k.g));
          mark.dataset["tip"] = `${groupName(k.g)} ${tx.detailDelay(k.min)}`;
          track.append(mark);
        }
        if (r.city !== null) {
          const dot = el("span", "live-ruler-dot");
          dot.style.left = at(r.city);
          dot.dataset["tip"] = `${tx.rulerCity} ${tx.detailDelay(r.city)}`;
          track.append(dot);
        }
        const parts = [tx.rulerPart(tx.rulerCity, r.city), ...r.kinds.map((k) => tx.rulerPart(groupName(k.g), k.min))];
        row.setAttribute("role", "img");
        row.setAttribute("aria-label", tx.rulerLabel(cityName(r.id), parts.join(", ")));
        row.append(name, track);
        return row;
      }),
    );
    ui.rulerAxis.replaceChildren(el("span", "", "0"), el("span", "", String(max / 2)), el("span", "", tx.rulerAxis(max)));
    const legend: (string | Node)[] = [el("span", "live-ruler-dot live-ruler-dot-key"), tx.rulerCity];
    for (const g of kinds) legend.push(" · ", kindIcon(g), groupName(g));
    ui.rulerLegend.replaceChildren(...legend);
  }

  // Every chosen city has numbers but too few live vehicles for any percentage (usually night): one plain
  // sentence instead of empty-looking cities (live data only, no example picture).
  function renderFindings(): void {
    const quiet = selected.every((id) => hasNumbers(analyses[id].state) && analyses[id].summary.live < MIN_LIVE_FOR_SHARE);
    ui.findings.textContent = quiet ? t().quietHours : "";
    ui.findings.hidden = !quiet;
  }

  // "Live data available: Bus 74 % · Bahn 95 % · S-Bahn 8 of 9" for the chosen kinds in the city. A share
  // from 10 vehicles on, like the headline; below that the counts (8 of 8 is no "100 %").
  function renderLiveShare(ready: boolean): void {
    const tx = t();
    const by = liveByGroup(counted);
    const items = ALL_GROUPS.filter((g) => filters.groups.has(g) && by[g].vehicles > 0).map((g) =>
      by[g].vehicles >= MIN_LIVE_FOR_SHARE
        ? tx.liveShareItem(groupName(g), Math.round((by[g].live / by[g].vehicles) * 100))
        : tx.liveShareCount(groupName(g), by[g].live, by[g].vehicles),
    );
    ui.liveShare.textContent = ready && items.length ? `${tx.liveShareTitle}: ${items.join(" · ")}` : "";
    ui.liveShare.hidden = ui.liveShare.textContent === "";
  }

  // A tile per kind with a chip (bus, tram; the S-Bahn rarely has 10 live, so it gets none): its share on
  // time over the chosen cities, big, then a small bar per city (or the one bar with one city), each comparing
  // like with like, so a city's mix of buses and trains cannot move it. A city with none of a kind on the road
  // gets no bar for it; one still loading does. With several cities, buses and another kind chosen, the note
  // says that mix still moves the totals above.
  function renderKinds(): void {
    const tx = t();
    const kinds = FILTER_GROUPS.filter((g) => filters.groups.has(g) && selected.some((id) => analyses[id].vehicles.some((v) => modeGroup(v.mode) === g)));
    ui.kindTitle.hidden = ui.kindBars.hidden = kinds.length === 0;
    const several = selected.length > 1;
    ui.kindBars.replaceChildren(
      ...kinds.map((g) => {
        const tile = el("div", "live-tile");
        const head = el("div", "live-tile-head");
        head.append(kindIcon(g), groupName(g));
        const mine = counted.filter((v) => modeGroup(v.mode) === g);
        const counts = classCounts(mine);
        const live = mine.length - counts.unknown;
        const ok = hasNumbers(current.state) && live >= MIN_LIVE_FOR_SHARE;
        const pct = ok ? tx.livePct(Math.round((counts.ontime / live) * 100)) : "-";
        const big = el("p", "live-tile-pct", pct);
        const sub = el("p", "live-tile-sub", ok ? `${tx.kindOnTime} · ${tx.kindLive(live)}` : `${tx.compareTooFew} (${tx.kindLive(live)})`);
        if (ok) tile.setAttribute("aria-label", tx.kindTileLabel(groupName(g), pct));
        const rows = selected.flatMap((id) => {
          const own = analyses[id].vehicles.filter((v) => modeGroup(v.mode) === g);
          if (!own.length && hasNumbers(analyses[id].state)) return [];
          return [cityRow(id, own, several ? cityName(id) : null)];
        });
        const bars = el("div", "live-tile-rows");
        bars.append(...rows);
        tile.append(head, big, sub, bars);
        return tile;
      }),
    );
    ui.kindNote.hidden = !(several && filters.groups.has("bus") && kinds.length > 1);
  }

  // The most delayed tram lines in the city; a tap highlights that line's vehicles and shows its detail (its
  // back link returns here).
  function renderWorst(inCityNow: VehiclePosition[]): void {
    // The list is redrawn every few seconds: keep the keyboard focus on the same line.
    const focusedKey = (document.activeElement as HTMLElement | null)?.dataset?.["line"] ?? null;
    renderTramTable(inCityNow);
    if (!focusedKey) return;
    // The focused line dropped out of the list: focus goes to the list's title instead of getting lost.
    const again = ui.worst.querySelector<HTMLElement>(`[data-line="${CSS.escape(focusedKey)}"]`);
    (again ?? ui.worstTitle).focus();
  }

  // The list as a table (user decisions 2026-11-03 and 2026-11-04): the 5 most delayed tram lines, 2+ min late,
  // each told by the next vehicle of its most delayed direction. Columns: the line, where it goes and its next
  // stop, the delay.
  function renderTramTable(inCityNow: VehiclePosition[]): void {
    const tx = t();
    askDestinations(inCityNow);
    const rows = worstTramLines(inCityNow, (id) => destinations.get(id), Date.now());
    if (!rows.length) {
      // Say why it is empty: trams switched off, none on the road, none with live data, or none late (and how
      // many say nothing because they are timetable only).
      const trams = inCityNow.filter((v) => modeGroup(v.mode) === "tram" && isCounted(v));
      const live = trams.filter((v) => v.realTime).length;
      const none = !filters.groups.has("tram")
        ? tx.worstTramOff
        : !trams.length
          ? tx.worstNoTram
          : !live
            ? tx.worstNoLive
            : live < trams.length
              ? tx.worstNoneSome(live, trams.length - live)
              : tx.worstNone;
      ui.worst.replaceChildren(el("li", "live-none", none));
      return;
    }
    // The column heads are for the eye; each row's button says it all to screen readers.
    const head = el("li", "live-worst-head");
    head.setAttribute("aria-hidden", "true");
    head.append(el("span", "", tx.worstHeadLine), el("span", "", tx.worstHeadWhere), el("span", "", tx.worstHeadDelay));
    ui.worst.replaceChildren(
      head,
      ...rows.map((s) => {
        const item = el("li", "");
        const btn = button("live-line live-worst-row", "");
        btn.dataset["line"] = s.key;
        btn.setAttribute("aria-pressed", String(highlight === s.key));
        const min = wholeMinutes(s.medianDelaySec ?? 0);
        const cls = roundedClass(s.medianDelaySec ?? 0, true);
        const badge = el("span", "live-badge", s.line);
        paintBadge(badge, cls);
        // Where it goes and (several cities chosen) in which city it mostly runs, unless the destination
        // already starts with that city ("Köln Breslauer Platz/Hbf").
        const home = selected.length > 1 ? (mainCity([s.next]) ?? selected[0]!) : null;
        const named = home && s.to?.startsWith(CITIES.find((c) => c.id === home)!.name);
        const city = home && !named ? cityName(home) : null;
        const text = el("span", "live-line-main");
        if (s.to || city) {
          const where = el("span", "live-line-dest", s.to ? tx.worstTo(s.to) : "");
          if (city) where.append(el("span", "live-line-city", s.to ? ` (${city})` : city));
          text.append(where);
        }
        const nextStop = stopName(s.next.nextStop);
        text.append(el("span", "live-line-text", tx.worstNextStop(nextStop)));
        const delay = el("strong", "live-worst-delay", tx.detailDelay(min));
        delay.style.color = DELAY_COLORS[cls];
        btn.setAttribute("aria-label", tx.worstDirLabel(s.line, s.to, city, min, nextStop));
        btn.append(badge, text, delay);
        btn.addEventListener("click", () => pickLine(s.key, s.line));
        item.append(btn);
        return item;
      }),
    );
  }

  // A line picked in the list: the detail takes the list's place; bring its title to the top (phones: the
  // sheet scrolls).
  function pickLine(key: string, line: string): void {
    setHighlight(key, line);
    ui.detailTitle.focus({ preventScroll: true });
    ui.detailTitle.scrollIntoView({ block: "start" });
  }

  // The picked line's vehicles on screen. Redrawn with the overview (every few seconds): the keyboard focus
  // stays on the same vehicle, or goes to the title when it left the screen.
  function renderDetail(inView: VehiclePosition[]): void {
    const tx = t();
    const key = highlight!;
    const line = lineInfo?.line ?? key.slice(key.indexOf("|") + 1);
    const mode = key.slice(0, key.indexOf("|")) as Mode;
    const d = lineDetail(inView, key, MAX_DETAIL_ROWS);
    const focusedTrip = (document.activeElement as HTMLElement | null)?.dataset?.["veh"] ?? null;

    const badge = el("span", "live-badge", line);
    paintBadge(badge, roundedClass(d.maxDelaySec ?? 0, d.live > 0));
    ui.detailTitle.replaceChildren(badge, document.createTextNode(tx.detailTitle(line, groupName(modeGroup(mode)))));
    ui.detailStats.textContent = d.vehicles ? tx.detailStats(d.vehicles, d.live, d.timetableOnly) : tx.lineNoticesNoVehicle;
    ui.detailRange.textContent =
      d.minDelaySec !== null && d.maxDelaySec !== null
        ? tx.detailRange(wholeMinutes(d.minDelaySec), wholeMinutes(d.maxDelaySec))
        : d.vehicles
          ? tx.detailNoLive
          : "";
    ui.detailRange.hidden = ui.detailRange.textContent === "";
    ui.detailRows.replaceChildren(
      ...d.rows.map((v) => {
        const cls = delayClass(v.delaySec, v.realTime);
        const delay = delayLabel(v);
        const row = map ? button("live-veh", "") : el("div", "live-veh static");
        row.dataset["veh"] = v.tripId;
        const swatch = el("span", "live-swatch");
        swatch.style.background = DELAY_COLORS[cls];
        const nextStop = stopName(v.nextStop);
        row.append(swatch, el("strong", "live-veh-delay", delay), el("span", "live-veh-next", tx.detailNext(nextStop)));
        if (isUnusual(v)) row.append(unusualMark());
        if (map) {
          row.setAttribute("aria-label", tx.detailOpenLabel(line, delay, nextStop));
          row.addEventListener("click", () => {
            onVehicleTap({ tripId: v.tripId, line: v.line, color: DELAY_COLORS[cls], focus: null });
          });
        }
        const item = el("li", "");
        item.append(row);
        return item;
      }),
    );
    ui.detailMore.textContent = d.more ? tx.detailMore(d.more) : "";
    ui.detailMore.hidden = d.more === 0;
    if (focusedTrip) {
      const again = ui.detailRows.querySelector<HTMLElement>(`[data-veh="${CSS.escape(focusedTrip)}"]`);
      (again ?? ui.detailTitle).focus();
    }
  }
}

// Wide screens: the overview is a column next to the map (style.css, same query). Otherwise a bar over the
// bottom of the map that folds.
const RAIL_QUERY = "(min-width: 900px) and (min-height: 501px)";
const wideLayout = (): boolean => window.matchMedia(RAIL_QUERY).matches;

function scopeText(g: ModeGroup): string {
  const tx = t();
  return { tram: tx.scopeTram, bus: tx.scopeBus, sbahn: tx.scopeSbahn }[g];
}

function groupName(g: ModeGroup): string {
  const tx = t();
  return { tram: tx.filterTram, bus: tx.filterBus, sbahn: tx.filterSbahn }[g];
}

const HIST_BAR_PX = 80; // the tallest column of the delay chart (the count above it fits the 112 px box)
// The delay chart's bins (DELAY_BINS) in their band's color; the red band's three bins get darker with the
// delay, so the long tail reads as worse at a glance.
const HIST_COLORS = [DELAY_COLORS.slight, DELAY_COLORS.late, DELAY_COLORS.verylate, "#a82020", "#7c1616"];

// The parts of a bar by color, for the classes with live data, each sized by its count and saying on hover
// what it is ("6-10 min: 19 vehicles (12 %)", its share of the vehicles with live data).
function barParts(counts: Record<DelayClass, number>): HTMLElement[] {
  const live = LIVE_ORDER.reduce((n, cls) => n + counts[cls], 0);
  return LIVE_ORDER.filter((cls) => counts[cls] > 0).map((cls) => {
    const part = el("span", "");
    part.style.background = DELAY_COLORS[cls];
    part.style.flexGrow = String(counts[cls]);
    part.dataset["tip"] = t().barTip(legendText(cls), counts[cls], Math.round((counts[cls] / live) * 100));
    return part;
  });
}

// Small line icons for the kinds of vehicles, in the text color: a bus, a tram with its pantograph, an
// S-Bahn train front.
const KIND_ICONS: Record<ModeGroup, string> = {
  bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 14.5h.01M16 14.5h.01M7 18v2.5M17 18v2.5"/>',
  tram: '<path d="M8 2h8M12 2v3"/><rect x="5" y="5" width="14" height="13" rx="3"/><path d="M5 11h14M9 14.5h.01M15 14.5h.01M8 18l-2 3M16 18l2 3"/>',
  sbahn: '<path d="M6 15V8a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v7a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z"/><path d="M6 10h12M9 14.5h.01M15 14.5h.01M8 18l-2 3M16 18l2 3"/>',
};

function kindIcon(g: ModeGroup): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "live-kind-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = KIND_ICONS[g];
  return svg;
}

// A paragraph with links in it (i18n RichText); links open in a new tab.
function richText(parts: RichText): HTMLElement {
  const p = el("p", "");
  for (const part of parts) {
    if (typeof part === "string") {
      p.append(part);
      continue;
    }
    const a = document.createElement("a");
    a.textContent = part[0];
    a.href = part[1];
    a.target = "_blank";
    a.rel = "noopener";
    p.append(a);
  }
  return p;
}

// The city most of these vehicles are in (a line can run through two).
function mainCity(vehicles: VehiclePosition[]): CityId | null {
  const n = new Map<CityId, number>();
  for (const v of vehicles) {
    const id = cityOf(v.lon, v.lat);
    if (id) n.set(id, (n.get(id) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function paintBadge(badge: HTMLElement, cls: DelayClass): void {
  badge.style.background = DELAY_COLORS[cls];
  badge.style.color = badgeTextColor(DELAY_COLORS[cls], null);
}

// "ungewöhnlich" next to a 60+ min delay (rare now: such vehicles are left out of the numbers, livedata.ts).
function unusualMark(): HTMLElement {
  const mark = el("span", "live-unusual", t().unusual);
  mark.title = t().unusualLabel;
  return mark;
}

// Regional trains: drawn hollow and pale, never in the delay colors (they are not counted).
const REGIONAL_COLOR = "#a3abb8";

// A vehicle's delay in words, so the list does not rely on color: "+7 min", "on time", "timetable only".
function delayLabel(v: VehiclePosition): string {
  const tx = t();
  const cls = delayClass(v.delaySec, v.realTime);
  if (cls === "unknown") return tx.legendUnknown;
  if (cls === "ontime") return tx.miniOnTime;
  return tx.detailDelay(wholeMinutes(v.delaySec));
}

function miniText(cls: DelayClass): string {
  const tx = t();
  return { ontime: tx.miniOnTime, slight: tx.legendSlight, late: tx.legendLate, verylate: tx.legendVeryLate, unknown: tx.legendUnknown }[cls];
}

function legendText(cls: DelayClass): string {
  const tx = t();
  return { ontime: tx.legendOnTime, slight: tx.legendSlight, late: tx.legendLate, verylate: tx.legendVeryLate, unknown: tx.legendUnknown }[cls];
}

const isRail = (v: VehiclePosition) => v.mode !== "BUS";

// `highlight`: a line key; the other vehicles are faded.
function dots(positions: VehiclePosition[], highlight: string | null): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: positions.map((v) => {
      const cls = delayClass(v.delaySec, v.realTime);
      const regional = !isCounted(v); // regional trains and replacement buses
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [v.lon, v.lat] },
        properties: {
          tripId: v.tripId,
          line: v.line,
          cls: regional ? "regional" : cls,
          color: regional ? REGIONAL_COLOR : DELAY_COLORS[cls],
          rail: isRail(v),
          regional,
          dim: highlight !== null && lineKeyOf(v) !== highlight,
        },
      };
    }),
  };
}

function tracks(
  fleet: PreparedTrip[],
  positions: VehiclePosition[],
  nowMs: number,
  highlight: string | null,
): FeatureCollection<LineString> {
  const byTrip = new Map(fleet.map((trip) => [trip.tripId, trip]));
  const features: Feature<LineString>[] = [];
  for (const v of positions) {
    const trip = byTrip.get(v.tripId);
    const line = trip ? trackAhead(trip, nowMs) : null;
    if (!line) continue;
    const cls = delayClass(v.delaySec, v.realTime);
    const dim = highlight !== null && lineKeyOf(v) !== highlight;
    const regional = !isCounted(v); // regional trains and replacement buses
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: line },
      // Grey first, late ones last: red is never hidden under green or grey on a shared street. Regional
      // trains go below everything, pale (rank -1).
      properties: {
        color: regional ? REGIONAL_COLOR : DELAY_COLORS[cls],
        rank: regional ? -1 : trackRank(cls, dim),
        dim,
        regional,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function setSource(map: maplibregl.Map, id: string, data: FeatureCollection): void {
  map.getSource<maplibregl.GeoJSONSource>(id)?.setData(data);
}

function addLayers(map: maplibregl.Map): void {
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
  map.addSource(TRACK_SOURCE, { type: "geojson", data: empty });
  map.addSource(FLEET_SOURCE, { type: "geojson", data: empty });
  const underStops = map.getLayer(STOPS_FIRST_LAYER) ? STOPS_FIRST_LAYER : undefined;

  map.addLayer(
    {
      id: "fleet-track",
      type: "line",
      source: TRACK_SOURCE,
      layout: { "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "rank"] },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["get", "regional"], 1, 2], 16, ["case", ["get", "regional"], 2.5, 5]],
        "line-opacity": ["case", ["get", "dim"], 0.15, ["get", "regional"], 0.35, 0.75],
      },
    },
    underStops,
  );

  // Trams and trains a bit larger than buses. White ring so yellow still shows on the light map. Regional
  // trains: smaller hollow pale rings under everything else (shown, not counted).
  map.addLayer({
    id: FLEET_LAYER,
    type: "circle",
    source: FLEET_SOURCE,
    layout: {
      "circle-sort-key": [
        "case",
        ["get", "regional"],
        -1,
        ["+", ["case", ["get", "dim"], 0, 10], ["match", ["get", "cls"], "verylate", 3, "late", 2, 1]],
      ],
    },
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        12,
        ["case", ["get", "regional"], 2.5, ["get", "rail"], 4, 3],
        14,
        ["case", ["get", "regional"], 4, ["get", "rail"], 7, 5.5],
        17,
        ["case", ["get", "regional"], 6.5, ["get", "rail"], 11, 9],
      ],
      "circle-color": ["get", "color"],
      "circle-opacity": ["case", ["get", "regional"], 0, ["get", "dim"], 0.3, 1],
      "circle-stroke-color": ["case", ["get", "regional"], REGIONAL_COLOR, "#ffffff"],
      "circle-stroke-opacity": ["case", ["get", "dim"], 0.3, ["get", "regional"], 0.8, 1],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["get", "regional"], 1.5, 1], 15, 2],
    },
  });
  map.addLayer({
    id: "fleet-label",
    type: "symbol",
    source: FLEET_SOURCE,
    minzoom: 14.5,
    filter: ["!", ["get", "dim"]],
    layout: {
      "text-field": ["get", "line"],
      "text-font": ["Noto Sans Bold"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 14.5, 9, 17, 12],
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0, 0, 0, 0.65)", "text-halo-width": 1.2 },
  });
}
