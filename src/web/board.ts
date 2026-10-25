// Stops on the map plus the departure board: tap a stop, or press "My location".
// While a board is open, the lines on it are drawn faintly on the map (stoplines.ts).
// Tapping a departure opens its trip card (route and vehicle on the map).
// The user's location stays on the phone: only stop IDs are ever sent to the Worker.

import type { FeatureCollection } from "geojson";
import * as maplibregl from "maplibre-gl";
import { fetchDepartures, fetchStops, isStale } from "./api";
import {
  type DepartureRow,
  badgeTextColor,
  delayState,
  formatCountdown,
  mergeRows,
  modeLabel,
  rowColor,
  toRows,
  upcoming,
} from "./departures";
import {
  type PanelUser,
  ageLine,
  el,
  focusKey,
  focusPanel,
  offsetClearOfPanel,
  openPanel,
  ownsPanel,
  renderPanel,
} from "./panel";
import { t, onLangChange } from "./i18n";
import { setStationNames, shortName } from "./names";
import { ageText, resetStatus, setStatus, setStatusNote } from "./status";
import { startStopLines } from "./stoplines";
import { type Station, groupStations, matchStation, nearestStations } from "./stops";
import type { TripRef } from "./tripcard";

const POLL_MS = 60_000;
const TICK_MS = 10_000; // countdowns re-render, and the poll timer is checked
const FETCH_TIMEOUT_MS = 15_000;
const STOPS_RETRY_MS = [5_000, 15_000, 60_000]; // then every 60 s, only while the page is visible
const STALE_AFTER_S = 120;
const ROWS_PER_STATION = 8;
const ROWS_NEARBY = 12;

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

interface Result {
  rows: DepartureRow[];
  fetchedAtMs: number | null;
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
  let generation = 0; // bumps whenever the board changes, so late answers are ignored
  let lastPollMs = 0;
  let hereMarker: maplibregl.Marker | null = null;
  let glowMarkers: maplibregl.Marker[] = [];
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
        for (const s of stations) byId.set(s.id, s);
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
  function showStation(station: Station, zoomIn = false): void {
    open([{ station, distanceM: null }], () => shortName(station.name));
    const zoom = zoomIn ? Math.max(map.getZoom(), SEARCH_ZOOM) : map.getZoom();
    map.easeTo({ center: [station.lon, station.lat], zoom, offset: offsetClearOfPanel() });
  }

  // `again`: the same stops once more (back from a trip card): keep the rows already fetched and the
  // "more" choice, so the board shows at once and the row that was opened is still there to get focus.
  function open(list: Shown[], heading: () => string, again = false): void {
    openPanel(user);
    generation++;
    shown = list;
    title = heading;
    message = null;
    if (!again) {
      results = new Map();
      showAll = false;
    }
    stopLines.clear();
    highlight(list.map((s) => s.station));
    render();
    void refresh();
  }

  // The trip card's way back to this board, with focus on the row that opened it (`key`; if that trip has
  // left the board meanwhile, on the board's title).
  function backToBoard(key: string): TripRef["back"] {
    const list = shown;
    const heading = title;
    return {
      label: () => t().backToDepartures,
      run: () => {
        open(list, heading, true);
        const only = list.length === 1 ? list[0]!.station : null;
        if (only) map.easeTo({ center: [only.lon, only.lat], offset: offsetClearOfPanel() });
        const row = document.querySelector<HTMLElement>(`#board-body [data-focus="${CSS.escape(key)}"]`);
        if (row) row.focus();
        else focusPanel();
      },
    };
  }

  // Shows the rest of the fetched departures (no extra request: the Worker already asks for that many).
  function moreButton(hidden: number): HTMLElement {
    const btn = focusKey(
      el("button", "link-button board-more", showAll ? t().fewerDepartures : t().moreDepartures(hidden)) as HTMLButtonElement,
      "more",
    );
    btn.type = "button";
    btn.setAttribute("aria-expanded", String(showAll));
    btn.addEventListener("click", () => {
      showAll = !showAll;
      render();
    });
    return btn;
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
        try {
          const res = await fetchDepartures(station.stopIds[0]!, AbortSignal.timeout(FETCH_TIMEOUT_MS));
          if (gen !== generation) return;
          results.set(station.id, {
            rows: toRows(res.data.stopTimes),
            fetchedAtMs: res.fetchedAtMs,
            error: isStale(res) ? "stale copy from the Worker" : null,
          });
        } catch (err) {
          if (gen !== generation) return;
          const prev = results.get(station.id);
          results.set(station.id, {
            rows: prev?.rows ?? [],
            fetchedAtMs: prev?.fetchedAtMs ?? null,
            error: String(err),
          });
        }
        render();
      }),
    );
  }

  function nearMe(): void {
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
    } else if (onRoute && shown[0]) {
      parts.push(routeButtons(shown[0].station, onRoute));
    }

    const got = shown.map((s) => results.get(s.station.id)).filter((r): r is Result => r !== undefined);
    if (got.length === 0) {
      setStatus(heading, null, false);
      parts.push(el("p", "board-note", t().loadingDepartures));
      renderPanel(user, heading, parts);
      return;
    }

    const limit = nearby ? ROWS_NEARBY : ROWS_PER_STATION;
    const all = upcoming(mergeRows(got.map((r) => r.rows)), now, Infinity);
    const rows = showAll ? all : all.slice(0, limit);
    const anyError = got.some((r) => r.error !== null);
    const sameStop = nearby ? null : (shown[0]?.station.name ?? null);
    // Faint lines only for the first rows: "more" must not start more background requests.
    stopLines.add(all.slice(0, limit));
    if (rows.length) {
      const list = el("ul", "rows");
      for (const r of rows) {
        list.append(renderRow(r, sameStop, now, (trip) => onTripTap({ ...trip, back: backToBoard(rowKey(r)) })));
      }
      parts.push(list);
      if (all.length > limit) parts.push(moreButton(all.length - limit));
    } else if (!anyError) {
      parts.push(el("p", "board-note", t().noDepartures));
    }

    // Data age, like the vehicle status line (the oldest answer counts). Never show old data as current.
    const times = got.map((r) => r.fetchedAtMs).filter((t): t is number => t !== null);
    const ageS = times.length ? Math.max(0, (now - Math.min(...times)) / 1000) : null;
    setStatus(heading, ageS, anyError);
    if (anyError && (ageS === null || ageS > STALE_AFTER_S)) {
      parts.push(el("p", "board-note board-error", t().departuresUnavailable));
    } else if (ageS !== null) {
      const old = ageS > STALE_AFTER_S;
      const text = anyError ? ageText(ageS, old, true) : `${ageText(ageS, old)} · ${t().everyMinute}`;
      parts.push(ageLine(text, old || anyError));
    }
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
    stations: () => stations,
    stationsReady,
    stationsFailed: () => stationsFailed,
    onStationsChange(listener: () => void): void {
      stationsListeners.push(listener);
    },
  };
}

function oneOffStation(stop: StopRef): Station | null {
  if (!stop.stopId) return null;
  return {
    id: stop.stopId,
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

function routeButtons(station: Station, onRoute: (station: Station, end: "from" | "to") => void): HTMLElement {
  const box = el("div", "board-route");
  for (const [end, text] of [
    ["from", t().routeFromHere],
    ["to", t().routeToHere],
  ] as const) {
    const btn = focusKey(el("button", "board-route-btn", text) as HTMLButtonElement, `route-${end}`);
    btn.type = "button";
    btn.addEventListener("click", () => onRoute(station, end));
    box.append(btn);
  }
  return box;
}
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
  const details: string[] = [];
  const kind = modeLabel(r.mode, r.line);
  if (kind) details.push(kind);
  if (r.platform) details.push(r.platform);
  if (r.stopName !== sameStop) details.push(shortName(r.stopName)); // e.g. the neighbouring "Colmantstr./Hbf"
  if (r.extra) details.push(t().extraTrip);
  if (details.length) dest.append(el("small", "", details.join(" · ")));

  // Countdown, and under it the live state: "+3 live", "pünktlich", "nur Fahrplan", "fällt aus".
  const when = el("span", "when");
  when.append(el("b", "", formatCountdown(r.depMs, nowMs))); // struck through when cancelled (style.css)
  const state = delayState(r.delaySec, r.realTime, r.cancelled);
  when.append(el("small", `state ${state.level}`, state.text));

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
