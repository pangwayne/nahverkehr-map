// Stops on the map plus the departure board: tap a stop, or press "My location".
// While a board is open, the lines on it are drawn faintly on the map (stoplines.ts).
// Tapping a departure opens its trip card (route and vehicle on the map).
// The user's location stays on the phone here: only stop IDs are ever sent to the Worker. (The route panel's
// "My location as start" is the one place a position is sent, and only with a search.)

import type { FeatureCollection } from "geojson";
import * as maplibregl from "maplibre-gl";
import { collectNotices } from "./alerts";
import { fetchDepartures, fetchStops, isStale } from "./api";
import {
  type DepartureRow,
  badgeTextColor,
  delayState,
  formatClock,
  formatCountdown,
  lineKey,
  mergeRows,
  modeLabel,
  rowColor,
  toRows,
  upcoming,
} from "./departures";
import { linkTo, pushView } from "./nav";
import {
  type PanelUser,
  ageLine,
  button,
  clock,
  el,
  focusKey,
  focusPanel,
  noticeList,
  offsetClearOfPanel,
  openPanel,
  ownsPanel,
  panelChanges,
  renderPanel,
  shareLink,
} from "./panel";
import { t, onLangChange } from "./i18n";
import { setStationNames, shortName } from "./names";
import { isStopSaved, onSavedChange, toggleStop } from "./saved";
import { ageText, resetStatus, setStatus, setStatusNote } from "./status";
import { startStopLines } from "./stoplines";
import { type Station, groupStations, matchStation, nearestStations, stationIds } from "./stops";
import type { TripRef } from "./tripcard";
import { isBoardStopId } from "../worker/transitous";

const POLL_MS = 60_000;
const TICK_MS = 10_000; // countdowns re-render, and the poll timer is checked
const FETCH_TIMEOUT_MS = 15_000;
const STOPS_RETRY_MS = [5_000, 15_000, 60_000]; // then every 60 s, only while the page is visible
const STALE_AFTER_S = 120;
const ROWS_PER_STATION = 8;
const ROWS_NEARBY = 12;
const MAX_LATER_PAGES = 3; // "later departures" a few times; past that, the route search is the better tool
// Later pages are not refreshed by the minute (only the first page is). Their age counts for the board's age
// line, and after this long they are dropped: "Later departures" fetches them fresh again.
const LATER_KEEP_MS = 5 * 60_000;
const FILTER_MIN_LINES = 4; // fewer lines than this need no filter
const MAX_NOTICES = 3;
// Back on the same board within this time (from a trip card, say): keep what was fetched.
const KEEP_RESULTS_MS = 10 * 60_000;

// "My location": stations within ~6 minutes' walk; if none, the single nearest one up to 2 km away.
const NEAR_RADIUS_M = 500;
const NEAR_LIMIT = 3;
const NEAR_FALLBACK_M = 2000;

const SOURCE_ID = "stops";
const VEHICLE_LAYER = "vehicle-dot";
const STOPS_MIN_ZOOM = 13; // the start zoom: with no vehicles drawn, stops are what you see first
const SEARCH_ZOOM = 15;

interface Shown {
  station: Station;
  distanceM: number | null;
}

// One station's departures: the first page (refreshed every minute) and any later pages asked for.
interface Result {
  rows: DepartureRow[];
  laterRows: DepartureRow[];
  cursor: string | null; // the next page after everything loaded so far
  pages: number; // later pages loaded
  fetchedAtMs: number | null;
  laterFetchedAtMs: number | null; // the oldest later page; null without any
  laterStale: boolean; // a later page came as a stale copy
  error: string | null;
}

// A stop known from elsewhere (a stop on a vehicle's route), to be shown on the board.
export interface StopRef {
  stopId: string | null;
  name: string;
  lon: number;
  lat: number;
}

export interface Board {
  showStop(stop: StopRef): void;
  showStation(station: Station, zoomIn?: boolean): void;
  showStationId(id: string): Promise<boolean>; // false: no such station (an old link)
  showNear(): boolean; // the last "near you" board again; false if there is none
  stations(): Station[]; // empty until the stop list has arrived
  stationsReady: Promise<void>;
  stationsFailed(): boolean; // the last try to load the stop list failed (another one is on the way)
  onStationsChange(listener: () => void): void; // the list arrived, or a try failed
}

// `onTripTap`: a departure row was tapped (opens that trip's card).
// `onRoute`: "Route from here" / "Route to here" on a stop's board; null hides both buttons.
export function startBoard(
  map: maplibregl.Map,
  onTripTap: (trip: TripRef) => void,
  onRoute: ((station: Station, end: "from" | "to") => void) | null = null,
): Board {
  const nearBtn = document.querySelector<HTMLButtonElement>("#near-me")!;
  const user: PanelUser = { onClose: cleanUp };

  let stations: Station[] = [];
  const byId = new Map<string, Station>();
  let stationsFailed = false;
  const stationsListeners: (() => void)[] = [];
  const stationsReady = loadStations();

  // Functions, so a language switch redraws them in the new language.
  let title = () => "";
  let message: (() => string) | null = null;
  let messageBusy: () => boolean = () => false; // still waiting for something ("finding you")
  let shown: Shown[] = [];
  let results = new Map<string, Result>();
  let showAll = false; // "Weitere Abfahrten": every fetched row, not just the first few
  let filter = new Set<string>(); // lineKeys picked in the line filter; empty: all lines
  let loadingLater = false;
  let generation = 0; // bumps whenever the board changes, so late answers are ignored
  let lastPollMs = 0;
  let hereMarker: maplibregl.Marker | null = null;
  let glowMarkers: maplibregl.Marker[] = [];
  let lastNear: Shown[] | null = null; // the last "near you" list, for Back
  // The last board and when it was left, so coming back (Back from a trip card) shows it at once.
  let lastKey = "";
  let leftAtMs = 0;
  let lastTapped: string | null = null; // the row that opened a trip card, for focus on the way back
  const stopLines = startStopLines(map);

  map.on("load", () => {
    stopLines.addLayer();
    addLayers(map);
    updateSource();
  });

  map.on("click", "stop-hit", (e) => {
    // A tap on the shown vehicle is not meant for the stop underneath.
    if (map.getLayer(VEHICLE_LAYER) && map.queryRenderedFeatures(e.point, { layers: [VEHICLE_LAYER] }).length) return;
    const id = e.features?.[0]?.properties?.["id"];
    const station = typeof id === "string" ? byId.get(id) : undefined;
    if (station) showStation(station);
  });
  map.on("mouseenter", "stop-hit", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "stop-hit", () => (map.getCanvas().style.cursor = ""));

  nearBtn.addEventListener("click", nearMe);
  onLangChange(() => {
    if (hereMarker) hereMarker.getElement().title = t().youAreHere;
    if (ownsPanel(user) && (shown.length || message)) render();
  });
  onSavedChange(() => {
    if (ownsPanel(user) && shown.length) render();
  });

  // One timer: tick the countdowns, and fetch again once the poll interval has passed.
  setInterval(() => {
    if (shown.length === 0 || !ownsPanel(user)) return;
    if (document.visibilityState === "visible" && Date.now() - lastPollMs >= POLL_MS) void refresh();
    else render();
  }, TICK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && shown.length && Date.now() - lastPollMs >= POLL_MS) {
      void refresh();
    }
  });

  async function loadStations(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { data } = await fetchStops(AbortSignal.timeout(FETCH_TIMEOUT_MS));
        stations = groupStations(data);
        setStationNames(stations);
        // Old links and saved stops may name a station by an ID merged into it (stops.ts aliases).
        for (const s of stations) for (const id of stationIds(s)) byId.set(id, s);
        stationsFailed = false;
        updateSource();
        stationsChanged();
        return;
      } catch {
        stationsFailed = true;
        stationsChanged();
        await new Promise((r) => setTimeout(r, STOPS_RETRY_MS[Math.min(attempt, STOPS_RETRY_MS.length - 1)]));
        await whenVisible(); // no retries from a hidden tab
      }
    }
  }

  function stationsChanged(): void {
    for (const listener of stationsListeners) listener();
    if (ownsPanel(user) && message) render(); // e.g. "My location" waiting for the stop list
  }

  function updateSource(): void {
    map.getSource<maplibregl.GeoJSONSource>(SOURCE_ID)?.setData(toGeoJSON(stations));
  }

  // `zoomIn`: also zoom in far enough to see the stop (used by the search, where the map may be far off).
  // `push`: a new browser history entry (not when Back / Forward / a link brings the board back).
  function showStation(station: Station, zoomIn = false, push = true): void {
    if (push) pushView({ kind: "stop", id: station.id });
    open([{ station, distanceM: null }], () => shortName(station.name));
    const zoom = zoomIn ? Math.max(map.getZoom(), SEARCH_ZOOM) : map.getZoom();
    map.easeTo({ center: [station.lon, station.lat], zoom, offset: offsetClearOfPanel() });
  }

  // The same stops as last time, shortly after leaving them (Back from a trip card): keep the rows already
  // fetched and the "more" choice, so the board shows at once and the row that was opened gets focus again.
  function open(list: Shown[], heading: () => string): void {
    const key = list.map((s) => s.station.id).join("|");
    const again = key === lastKey && Date.now() - leftAtMs < KEEP_RESULTS_MS;
    openPanel(user);
    generation++;
    shown = list;
    title = heading;
    message = null;
    lastKey = key;
    loadingLater = false;
    if (!again) {
      results = new Map();
      showAll = false;
      filter = new Set();
      lastTapped = null;
    }
    stopLines.clear();
    highlight(list.map((s) => s.station));
    render();
    if (again && lastTapped) {
      const row = document.querySelector<HTMLElement>(`#board-body [data-focus="${CSS.escape(lastTapped)}"]`);
      if (row) row.focus({ preventScroll: false });
      else focusPanel();
    }
    void refresh();
  }

  // Shows the rest of the fetched departures (no extra request: the Worker already asks for that many).
  function moreButton(hidden: number): HTMLElement {
    const btn = button("link-button board-more", showAll ? t().fewerDepartures : t().moreDepartures(hidden), "more");
    btn.setAttribute("aria-expanded", String(showAll));
    btn.addEventListener("click", () => {
      showAll = !showAll;
      render();
    });
    return btn;
  }

  // The next page of departures, for every shown station that has one.
  async function loadLater(): Promise<void> {
    if (loadingLater) return;
    const gen = generation;
    loadingLater = true;
    showAll = true;
    render();
    await Promise.all(
      shown.map(async ({ station }) => {
        const r = results.get(station.id);
        if (!r?.cursor || r.pages >= MAX_LATER_PAGES) return;
        try {
          const res = await fetchDepartures(station.stopIds[0]!, AbortSignal.timeout(FETCH_TIMEOUT_MS), r.cursor);
          if (gen !== generation) return;
          r.laterRows = mergeRows([r.laterRows, toRows(res.data.stopTimes)]);
          r.cursor = res.data.nextPageCursor ?? null;
          r.pages++;
          r.laterFetchedAtMs = Math.min(r.laterFetchedAtMs ?? Infinity, res.fetchedAtMs);
          r.laterStale ||= isStale(res);
        } catch {
          // The button stays; another tap tries again.
        }
      }),
    );
    if (gen !== generation) return;
    loadingLater = false;
    render();
    document.querySelector<HTMLElement>('#board-body [data-focus="later"]')?.focus({ preventScroll: true });
  }

  // `busy`: the status line says "loading" while true; otherwise the message is the final answer.
  function showMessage(heading: () => string, text: () => string, busy: () => boolean = () => false): void {
    openPanel(user);
    generation++;
    shown = [];
    title = heading;
    message = text;
    messageBusy = busy;
    stopLines.clear();
    highlight([]);
    render();
  }

  // Called by the panel when it closes or another user (the vehicle card) takes it over.
  function cleanUp(): void {
    generation++;
    shown = [];
    message = null;
    loadingLater = false;
    leftAtMs = Date.now();
    stopLines.clear();
    highlight([]);
    resetStatus(); // the "you are here" dot stays until the next press or a reload
  }

  // Highlighted stops: a glowing green dot on top of each (a CSS animation: no map redraws).
  function highlight(list: Station[]): void {
    for (const m of glowMarkers) m.remove();
    glowMarkers = list.map((s) =>
      new maplibregl.Marker({ element: el("div", "stop-glow") }).setLngLat([s.lon, s.lat]).addTo(map),
    );
  }

  async function refresh(): Promise<void> {
    const gen = generation;
    lastPollMs = Date.now();
    await Promise.all(
      shown.map(async ({ station }) => {
        const prev = results.get(station.id);
        try {
          const res = await fetchDepartures(station.stopIds[0]!, AbortSignal.timeout(FETCH_TIMEOUT_MS));
          if (gen !== generation) return;
          // Later pages stay a while (see LATER_KEEP_MS); the first page's cursor counts only until a later
          // page has been loaded.
          const later = prev?.pages && prev.laterFetchedAtMs !== null && Date.now() - prev.laterFetchedAtMs < LATER_KEEP_MS ? prev : null;
          results.set(station.id, {
            rows: toRows(res.data.stopTimes),
            laterRows: later?.laterRows ?? [],
            cursor: later ? later.cursor : (res.data.nextPageCursor ?? null),
            pages: later?.pages ?? 0,
            fetchedAtMs: res.fetchedAtMs,
            laterFetchedAtMs: later?.laterFetchedAtMs ?? null,
            laterStale: later?.laterStale ?? false,
            error: isStale(res) ? "stale copy from the Worker" : null,
          });
        } catch (err) {
          if (gen !== generation) return;
          results.set(station.id, {
            rows: prev?.rows ?? [],
            laterRows: prev?.laterRows ?? [],
            cursor: prev?.cursor ?? null,
            pages: prev?.pages ?? 0,
            fetchedAtMs: prev?.fetchedAtMs ?? null,
            laterFetchedAtMs: prev?.laterFetchedAtMs ?? null,
            laterStale: prev?.laterStale ?? false,
            error: String(err),
          });
        }
        render();
      }),
    );
  }

  function nearMe(): void {
    pushView({ kind: "near" });
    if (!window.isSecureContext || !("geolocation" in navigator)) {
      showMessage(nearYou, () => t().needsHttps);
      return;
    }
    showMessage(nearYou, () => t().findingYou, () => true);
    let gen = generation;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        if (gen !== generation) return; // the user did something else meanwhile
        if (!stations.length) {
          // Located, but the stop list is not here yet: say so instead of "finding you".
          showMessage(
            nearYou,
            () => (stationsFailed ? t().stopsFailed : t().searchLoading),
            () => !stationsFailed,
          );
          gen = generation;
          await stationsReady;
          if (gen !== generation) return;
        }
        const { longitude: lon, latitude: lat } = pos.coords;
        let near = nearestStations(stations, lon, lat, NEAR_RADIUS_M, NEAR_LIMIT);
        if (near.length === 0) near = nearestStations(stations, lon, lat, NEAR_FALLBACK_M, 1);
        if (near.length === 0) {
          showMessage(nearYou, () => t().noStopsNear);
          return;
        }
        showHere(lon, lat);
        lastNear = near;
        open(near, nearYou);
      },
      (err) => {
        if (gen !== generation) return;
        const denied = err.code === err.PERMISSION_DENIED;
        showMessage(nearYou, () => (denied ? t().locationDenied : t().locationFailed));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  }

  function showHere(lon: number, lat: number): void {
    if (!hereMarker) {
      const dot = el("div", "here");
      dot.title = t().youAreHere;
      hereMarker = new maplibregl.Marker({ element: dot });
    }
    hereMarker.setLngLat([lon, lat]).addTo(map);
    map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 16), offset: offsetClearOfPanel() });
  }

  // "Route von hier", "Route hierher", save and share, for a single stop's board.
  function stopActions(station: Station): HTMLElement {
    const box = el("div", "board-route");
    if (onRoute) {
      for (const [end, text] of [
        ["from", t().routeFromHere],
        ["to", t().routeToHere],
      ] as const) {
        const btn = button("board-route-btn", text, `route-${end}`);
        btn.addEventListener("click", () => onRoute(station, end));
        box.append(btn);
      }
    }
    const saved = isStopSaved(stationIds(station));
    const save = button("board-route-btn", saved ? `★ ${t().saved}` : t().save, "save");
    save.setAttribute("aria-pressed", String(saved));
    save.addEventListener("click", () =>
      toggleStop({ id: station.id, name: shortName(station.name) }, station.aliases),
    );
    const share = button("board-route-btn", t().share, "share");
    share.addEventListener("click", () => void shareLink(linkTo({ kind: "stop", id: station.id }), shortName(station.name)));
    box.append(save, share);
    return box;
  }

  // The line filter: one badge per line on the board; picked ones narrow the list.
  function lineFilter(rows: DepartureRow[]): HTMLElement | null {
    const lines = new Map<string, DepartureRow>();
    for (const r of rows) if (!r.extra && !lines.has(lineKey(r))) lines.set(lineKey(r), r);
    if (lines.size < FILTER_MIN_LINES) return null;
    const box = el("div", filter.size ? "line-filter active" : "line-filter");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", t().filterLines);
    const sorted = [...lines.entries()].sort(([, a], [, b]) =>
      a.line.localeCompare(b.line, "de", { numeric: true }),
    );
    for (const [key, r] of sorted) {
      const on = filter.has(key);
      const chip = button("line line-chip", r.line, `filter-${key}`);
      const color = rowColor(r);
      chip.style.backgroundColor = color;
      chip.style.color = badgeTextColor(color, r.textColor);
      chip.setAttribute("aria-pressed", String(on));
      chip.setAttribute("aria-label", `${modeLabel(r.mode, r.line) ?? ""} ${r.line}`.trim());
      chip.addEventListener("click", () => {
        if (filter.has(key)) filter.delete(key);
        else filter.add(key);
        render();
      });
      box.append(chip);
    }
    if (filter.size) {
      const clear = button("link-button", t().filterClear, "filter-clear");
      clear.addEventListener("click", () => {
        filter = new Set();
        render();
      });
      box.append(clear);
    }
    return box;
  }

  function render(): void {
    const heading = title();
    if (message !== null) {
      if (messageBusy()) setStatus(heading, null, false);
      else setStatusNote(heading);
      renderPanel(user, heading, [el("p", "board-note", message())]);
      return;
    }

    const now = Date.now();
    const parts: HTMLElement[] = [];

    // My location: say which stops are included, then one combined list (stop name on every row).
    const nearby = shown.length > 1 || shown[0]?.distanceM !== null;
    if (nearby) {
      const names = shown.map((s) => `${shortName(s.station.name)} ${roundM(s.distanceM ?? 0)} m`).join(" · ");
      parts.push(el("p", "board-note", names));
    } else if (shown[0]) {
      parts.push(stopActions(shown[0].station));
    }

    const got = shown.map((s) => results.get(s.station.id)).filter((r): r is Result => r !== undefined);
    if (got.length === 0) {
      setStatus(heading, null, false);
      parts.push(el("p", "board-note", t().loadingDepartures));
      renderPanel(user, heading, parts);
      return;
    }

    const notices = collectNotices(
      got.flatMap((r) => r.rows.map((row) => row.alerts)),
      now,
    );
    const noticeBox = noticeList(notices, MAX_NOTICES);
    if (noticeBox) parts.push(noticeBox);

    const limit = nearby ? ROWS_NEARBY : ROWS_PER_STATION;
    // A trip on a fresh first page and on an older later page (the first page has moved on): the fresh row.
    const fresh = got.flatMap((r) => r.rows);
    const freshTrips = new Set(fresh.map(rowKey));
    const later = got.flatMap((r) => r.laterRows).filter((row) => !freshTrips.has(rowKey(row)));
    const all = upcoming(mergeRows([fresh, later]), now, Infinity);
    const filterBox = lineFilter(all);
    if (filterBox) parts.push(filterBox);
    const matching = filter.size ? all.filter((r) => filter.has(lineKey(r))) : all;
    const rows = showAll ? matching : matching.slice(0, limit);
    const anyError = got.some((r) => r.error !== null || (r.laterRows.length > 0 && r.laterStale));
    const sameStop = nearby ? null : (shown[0]?.station.name ?? null);
    // Faint lines only for the first rows: "more" must not start more background requests.
    stopLines.add(all.slice(0, limit));
    if (rows.length) {
      const list = el("ul", "rows");
      for (const r of rows) {
        list.append(
          renderRow(r, sameStop, now, (trip) => {
            lastTapped = rowKey(r);
            onTripTap(trip);
          }),
        );
      }
      parts.push(list);
    } else if (!anyError) {
      parts.push(el("p", "board-note", filter.size ? t().noDeparturesFiltered : t().noDepartures));
    }
    if (matching.length > limit) parts.push(moreButton(matching.length - limit));

    // How far ahead the list goes, and a way to look further (when everything loaded is on screen).
    const lastMs = all.length ? all[all.length - 1]!.depMs : null;
    const canLater = got.some((r) => r.cursor && r.pages < MAX_LATER_PAGES);
    if ((showAll || matching.length <= limit) && lastMs !== null) {
      const horizon = el("p", "board-note board-horizon", t().loadedUntil(formatClock(lastMs)));
      parts.push(horizon);
      if (canLater) {
        const later = button("link-button board-more", loadingLater ? t().loading : t().laterDepartures, "later");
        later.disabled = loadingLater;
        later.addEventListener("click", () => void loadLater());
        parts.push(later);
      }
    }

    // Data age, like the vehicle status line (the oldest answer counts). Never show old data as current.
    const times = got
      .flatMap((r) => [r.fetchedAtMs, r.laterRows.length ? r.laterFetchedAtMs : null])
      .filter((t): t is number => t !== null);
    const ageS = times.length ? Math.max(0, (now - Math.min(...times)) / 1000) : null;
    setStatus(heading, ageS, anyError);
    if (anyError && (ageS === null || ageS > STALE_AFTER_S)) {
      parts.push(el("p", "board-note board-error", t().departuresUnavailable));
    } else if (ageS !== null) {
      const old = ageS > STALE_AFTER_S;
      const text = anyError ? ageText(ageS, old, true) : `${ageText(ageS, old)} · ${t().everyMinute}`;
      parts.push(ageLine(text, old || anyError));
    }
    parts.push(el("p", "data-note", t().dataNote));
    renderPanel(user, heading, parts);
  }

  return {
    // A stop on a trip's route. Outside the stop area (or before the stop list is here) it is not one of our
    // stations, but the Worker takes any German stop ID, so its board opens anyway.
    showStop(stop: StopRef): void {
      const station = matchStation(stations, stop) ?? oneOffStation(stop);
      if (station) showStation(station);
      else showMessage(() => shortName(stop.name), () => t().noBoardForStop);
    },
    showStation,
    // Something else on the board meanwhile (another stop, closing, another panel): that wins, and an old
    // link's stop is not opened over it (true: nothing to report).
    async showStationId(id: string): Promise<boolean> {
      const gen = generation;
      const seen = panelChanges();
      await stationsReady;
      if (gen !== generation || panelChanges() !== seen) return true;
      const station = byId.get(id);
      if (!station) return false;
      showStation(station, true, false);
      return true;
    },
    showNear(): boolean {
      if (!lastNear) return false;
      open(lastNear, nearYou);
      return true;
    },
    stations: () => stations,
    stationsReady,
    stationsFailed: () => stationsFailed,
    onStationsChange(listener: () => void): void {
      stationsListeners.push(listener);
    },
  };
}

// Only where the Worker shows departures (isBoardStopId: North Rhine-Westphalia and Rhineland-Palatinate).
function oneOffStation(stop: StopRef): Station | null {
  if (!stop.stopId || !isBoardStopId(stop.stopId)) return null;
  return {
    id: stop.stopId,
    aliases: [],
    name: stop.name,
    lon: stop.lon,
    lat: stop.lat,
    stopIds: [stop.stopId],
    planStopId: stop.stopId,
    hasTram: false,
    hasTrain: false,
  };
}

function whenVisible(): Promise<void> {
  if (document.visibilityState === "visible") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", check);
      resolve();
    };
    document.addEventListener("visibilitychange", check);
  });
}

const roundM = (m: number) => Math.round(m / 10) * 10;

const nearYou = () => t().nearYou;
const rowKey = (r: DepartureRow) => `${r.tripId}|${r.stopName}`;

// `sameStop`: the tapped station's name, left out of the row details; null shows it on every row.
function renderRow(
  r: DepartureRow,
  sameStop: string | null,
  nowMs: number,
  onTripTap: (trip: TripRef) => void,
): HTMLElement {
  const li = el("li", "");
  // A departure you can open is a real button inside the list item, so it stays a list item for
  // screen readers; extra trips come without a usable trip ID, so there is no card to open.
  const row = el(r.extra ? "div" : "button", r.cancelled ? "row cancelled" : "row");
  li.append(row);

  const badge = el("span", "line", r.line);
  const color = rowColor(r);
  badge.style.backgroundColor = color;
  badge.style.color = badgeTextColor(color, r.textColor);

  // Destination, then what it is and where: "Stadtbahn · Colmantstr./Hbf", "Zug · Gleis 2".
  const dest = el("span", "dest");
  dest.append(el("span", "dest-name", shortName(r.headsign)));
  const details = el("small", "");
  const parts: (string | HTMLElement)[] = [];
  const kind = modeLabel(r.mode, r.line);
  if (kind) parts.push(kind);
  if (r.platform) {
    parts.push(r.plannedPlatform ? el("span", "platform-change", t().platformChanged(r.platform, r.plannedPlatform)) : r.platform);
  }
  if (r.stopName !== sameStop) parts.push(shortName(r.stopName)); // e.g. the neighbouring "Colmantstr./Hbf"
  if (r.extra) parts.push(t().extraTrip);
  if (r.alerts.length) parts.push(el("span", "row-notice", t().noticeShort));
  parts.forEach((p, i) => details.append(...(i ? [" · ", p] : [p])));
  if (parts.length) dest.append(details);

  // Countdown, and under it the clock time (planned struck through when it moved) and the live state:
  // "21:07 21:25 · +18 live", "21:25 · pünktlich", "nur Fahrplan", "fällt aus".
  const when = el("span", "when");
  when.append(el("b", "", formatCountdown(r.depMs, nowMs))); // struck through when cancelled (style.css)
  const state = delayState(r.delaySec, r.realTime, r.cancelled);
  const line = el("small", "when-line");
  line.append(clock(r.depMs, r.schedMs), " · ", el("span", `state ${state.level}`, state.text));
  when.append(line);

  row.append(badge, dest, when);

  if (!r.extra) {
    row.classList.add("tappable");
    (row as HTMLButtonElement).type = "button";
    focusKey(row, rowKey(r)); // near me: one trip can pass two of the shown stops
    row.addEventListener("click", () => onTripTap({ tripId: r.tripId, line: r.line, color, focus: [r.lon, r.lat] }));
  }
  return li;
}

function toGeoJSON(stations: Station[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: stations.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { id: s.id, name: shortName(s.name), hasTram: s.hasTram, hasTrain: s.hasTrain },
    })),
  };
}

function addLayers(map: maplibregl.Map): void {
  map.addSource(SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  map.addLayer({
    id: "stop-dot",
    type: "circle",
    source: SOURCE_ID,
    minzoom: STOPS_MIN_ZOOM,
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        13,
        ["case", ["get", "hasTrain"], 4, ["get", "hasTram"], 3, 2],
        14,
        ["case", ["get", "hasTrain"], 5, ["get", "hasTram"], 3.5, 2.5],
        17,
        ["case", ["get", "hasTrain"], 10, ["get", "hasTram"], 6, 5],
      ],
      "circle-color": "#ffffff",
      "circle-stroke-color": "#37474f",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 14, 1.5],
    },
  });

  map.addLayer({
    id: "stop-label",
    type: "symbol",
    source: SOURCE_ID,
    minzoom: 16,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-anchor": "top",
      "text-offset": [0, 0.8],
    },
    paint: {
      "text-color": "#37474f",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });

  // Invisible, larger circle so stops are easy to hit with a finger.
  map.addLayer({
    id: "stop-hit",
    type: "circle",
    source: SOURCE_ID,
    minzoom: STOPS_MIN_ZOOM,
    paint: { "circle-radius": 14, "circle-opacity": 0 },
  });
}
