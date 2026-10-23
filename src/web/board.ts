// Stops on the map plus the departure board: tap a stop, or press "Near me".
// Tapping a departure opens its trip card (route and vehicle on the map).
// The user's location stays on the phone: only stop IDs are ever sent to the Worker.

import type { FeatureCollection } from "geojson";
import * as maplibregl from "maplibre-gl";
import { fetchDepartures, fetchStops } from "./api";
import {
  type DepartureRow,
  delayLevel,
  formatCountdown,
  formatDelay,
  mergeRows,
  toRows,
  upcoming,
} from "./departures";
import { type PanelUser, el, offsetClearOfPanel, openPanel, ownsPanel, renderPanel } from "./panel";
import { resetStatus, setStatus } from "./status";
import { type Station, groupStations, matchStation, nearestStations } from "./stops";
import type { TripRef } from "./tripcard";

const POLL_MS = 60_000;
const TICK_MS = 10_000; // countdowns re-render, and the poll timer is checked
const FETCH_TIMEOUT_MS = 15_000;
const STOPS_RETRY_MS = 60_000;
const STALE_AFTER_S = 120;
const ROWS_PER_STATION = 8;
const ROWS_NEARBY = 12;

// "Near me": stations within ~6 minutes' walk; if none, the single nearest one up to 2 km away.
const NEAR_RADIUS_M = 500;
const NEAR_LIMIT = 3;
const NEAR_FALLBACK_M = 2000;

const SOURCE_ID = "stops";
const VEHICLE_LAYER = "vehicle-dot";
const STOPS_MIN_ZOOM = 13; // the start zoom: with no vehicles drawn, stops are what you see first

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
  showStop(stop: StopRef): Promise<void>;
}

// `onTripTap`: a departure row was tapped (opens that trip's card).
export function startBoard(map: maplibregl.Map, onTripTap: (trip: TripRef) => void): Board {
  const nearBtn = document.querySelector<HTMLButtonElement>("#near-me")!;
  const user: PanelUser = { onClose: cleanUp };

  let stations: Station[] = [];
  const byId = new Map<string, Station>();
  const stationsReady = loadStations();

  let title = "";
  let message: string | null = null;
  let shown: Shown[] = [];
  let results = new Map<string, Result>();
  let generation = 0; // bumps whenever the board changes, so late answers are ignored
  let lastPollMs = 0;
  let hereMarker: maplibregl.Marker | null = null;

  map.on("load", () => {
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
    for (;;) {
      try {
        const { data } = await fetchStops(AbortSignal.timeout(FETCH_TIMEOUT_MS));
        stations = groupStations(data);
        for (const s of stations) byId.set(s.id, s);
        updateSource();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, STOPS_RETRY_MS));
      }
    }
  }

  function updateSource(): void {
    map.getSource<maplibregl.GeoJSONSource>(SOURCE_ID)?.setData(toGeoJSON(stations));
  }

  function showStation(station: Station): void {
    open([{ station, distanceM: null }], station.name);
    map.easeTo({ center: [station.lon, station.lat], offset: offsetClearOfPanel() });
  }

  function open(list: Shown[], heading: string): void {
    openPanel(user);
    generation++;
    shown = list;
    title = heading;
    message = null;
    results = new Map();
    highlight(list.map((s) => s.station.id));
    render();
    void refresh();
  }

  function showMessage(heading: string, text: string): void {
    openPanel(user);
    generation++;
    shown = [];
    title = heading;
    message = text;
    highlight([]);
    render();
  }

  // Called by the panel when it closes or another user (the vehicle card) takes it over.
  function cleanUp(): void {
    generation++;
    shown = [];
    message = null;
    highlight([]);
    hereMarker?.remove();
    hereMarker = null;
    resetStatus();
  }

  function highlight(ids: string[]): void {
    if (map.getLayer("stop-selected")) {
      map.setFilter("stop-selected", ["in", ["get", "id"], ["literal", ids]]);
    }
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
            error: null,
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
      showMessage("Near you", "Location needs a secure connection (the https:// site, or localhost).");
      return;
    }
    showMessage("Near you", "Finding your location...");
    const gen = generation;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await stationsReady;
        if (gen !== generation) return; // the user did something else meanwhile
        const { longitude: lon, latitude: lat } = pos.coords;
        let near = nearestStations(stations, lon, lat, NEAR_RADIUS_M, NEAR_LIMIT);
        if (near.length === 0) near = nearestStations(stations, lon, lat, NEAR_FALLBACK_M, 1);
        if (near.length === 0) {
          showMessage("Near you", "No stops nearby. This map covers Bonn only.");
          return;
        }
        showHere(lon, lat);
        open(near, "Near you");
      },
      (err) => {
        if (gen !== generation) return;
        const text =
          err.code === err.PERMISSION_DENIED
            ? "Location access was not allowed. You can still tap a stop on the map."
            : "Could not find your location. You can still tap a stop on the map.";
        showMessage("Near you", text);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  }

  function showHere(lon: number, lat: number): void {
    if (!hereMarker) {
      const dot = el("div", "here");
      dot.title = "You are here";
      hereMarker = new maplibregl.Marker({ element: dot });
    }
    hereMarker.setLngLat([lon, lat]).addTo(map);
    map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 16), offset: offsetClearOfPanel() });
  }

  function render(): void {
    if (message !== null) {
      setStatus(title, null, false);
      renderPanel(user, title, [el("p", "board-note", message)]);
      return;
    }

    const now = Date.now();
    const parts: HTMLElement[] = [];

    // Near me: say which stops are included, then one combined list (stop name on every row).
    const nearby = shown.length > 1 || shown[0]?.distanceM !== null;
    if (nearby) {
      const names = shown.map((s) => `${s.station.name} ${roundM(s.distanceM ?? 0)} m`).join(" · ");
      parts.push(el("p", "board-note", names));
    }

    const got = shown.map((s) => results.get(s.station.id)).filter((r): r is Result => r !== undefined);
    if (got.length === 0) {
      setStatus(title, null, false);
      parts.push(el("p", "board-note", "Loading departures..."));
      renderPanel(user, title, parts);
      return;
    }

    const limit = nearby ? ROWS_NEARBY : ROWS_PER_STATION;
    const rows = upcoming(mergeRows(got.map((r) => r.rows)), now, limit);
    const anyError = got.some((r) => r.error !== null);
    const sameStop = nearby ? null : (shown[0]?.station.name ?? null);
    if (rows.length) {
      const list = el("ul", "rows");
      for (const r of rows) list.append(renderRow(r, sameStop, now, onTripTap));
      parts.push(list);
    } else if (!anyError) {
      parts.push(el("p", "board-note", "No departures soon."));
    }

    // Data age, like the vehicle status line (the oldest answer counts). Never show old data as current.
    const times = got.map((r) => r.fetchedAtMs).filter((t): t is number => t !== null);
    const ageS = times.length ? Math.max(0, (now - Math.min(...times)) / 1000) : null;
    setStatus(title, ageS, anyError);
    if (anyError && (ageS === null || ageS > STALE_AFTER_S)) {
      parts.push(el("p", "board-note board-error", "Departures unavailable right now. Retrying..."));
    } else if (ageS !== null) {
      const old = ageS > STALE_AFTER_S;
      const text = `updated ${Math.round(ageS)} s ago${old ? " · data is old" : ""}`;
      parts.push(el("p", old ? "board-note board-error" : "board-note", text));
    }
    renderPanel(user, title, parts);
  }

  return {
    async showStop(stop: StopRef): Promise<void> {
      await stationsReady;
      const station = matchStation(stations, stop);
      if (station) showStation(station);
    },
  };
}

const roundM = (m: number) => Math.round(m / 10) * 10;

// `sameStop`: the tapped station's name, left out of the row details; null shows it on every row.
function renderRow(
  r: DepartureRow,
  sameStop: string | null,
  nowMs: number,
  onTripTap: (trip: TripRef) => void,
): HTMLElement {
  const li = el("li", r.cancelled ? "row cancelled" : "row");

  const badge = el("span", "line", r.line);
  const color = r.color ?? (r.extra ? "#757575" : r.mode === "BUS" ? "#4a5a6a" : "#1565c0");
  badge.style.backgroundColor = color;
  badge.style.color = r.textColor ?? "#ffffff";

  const dest = el("span", "dest", r.headsign);
  const details: string[] = [];
  if (r.stopName !== sameStop) details.push(r.stopName); // e.g. the neighbouring "Colmantstr./Hbf"
  if (r.platform) details.push(r.platform);
  if (r.extra) details.push("extra trip, no details");
  if (!r.realTime && !r.cancelled) details.push("timetable only");
  if (details.length) dest.append(el("small", "", details.join(" · ")));

  const when = el("span", "when");
  if (r.cancelled) {
    when.append(el("b", "", "cancelled"));
  } else {
    when.append(el("b", "", formatCountdown(r.depMs, nowMs)));
    const delay = formatDelay(r.delaySec);
    if (delay && r.realTime) when.append(el("span", `delay ${delayLevel(r.delaySec, r.realTime)}`, delay));
  }

  li.append(badge, dest, when);

  // Extra trips come without a usable trip ID, so there is no card to open.
  if (!r.extra) {
    li.classList.add("tappable");
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    const tap = () => onTripTap({ tripId: r.tripId, line: r.line, color, focus: [r.lon, r.lat] });
    li.addEventListener("click", tap);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        tap();
      }
    });
  }
  return li;
}

function toGeoJSON(stations: Station[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: stations.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { id: s.id, name: s.name, hasTram: s.hasTram },
    })),
  };
}

function addLayers(map: maplibregl.Map): void {
  map.addSource(SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  map.addLayer({
    id: "stop-selected",
    type: "circle",
    source: SOURCE_ID,
    filter: ["in", ["get", "id"], ["literal", []]],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 7, 17, 12],
      "circle-color": "#ffd54f",
      "circle-opacity": 0.8,
    },
  });

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
        ["case", ["get", "hasTram"], 3, 2],
        14,
        ["case", ["get", "hasTram"], 3.5, 2.5],
        17,
        ["case", ["get", "hasTram"], 6, 5],
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
