// The lines on an open departure board, drawn faintly on the map. Lines are only added while the board
// is open (never removed, so nothing flickers when a tram leaves) and all go when it closes.
// One /api/trip request per line, one at a time, and each variant's path is remembered for the visit.

import type { FeatureCollection } from "geojson";
import type * as maplibregl from "maplibre-gl";
import { fetchTrip } from "./api";
import { type DepartureRow, distinctLines, lineKey, routeKey, rowColor } from "./departures";
import type { LonLat } from "./geo";
import { tripRoute } from "./trip";

const MAX_LINES = 12; // per open board, so a long stay at the Hbf stays readable
const FETCH_TIMEOUT_MS = 15_000;
const SOURCE_ID = "stop-lines";

export interface StopLines {
  addLayer(): void; // call before the stop layers are added, so the lines sit under them
  add(rows: DepartureRow[]): void; // the rows on the board right now
  clear(): void;
}

interface Wanted {
  line: string; // lineKey: one drawn line per line on the board
  route: string; // routeKey: which variant's path it shows
  tripId: string;
  color: string;
}

export function startStopLines(map: maplibregl.Map): StopLines {
  const paths = new Map<string, LonLat[]>(); // per variant; an empty path means "no usable route"
  let wanted: Wanted[] = [];
  let failed = new Set<string>(); // lines whose request failed on this board: not asked for again
  let busy = false;
  let generation = 0; // bumps on clear, so a late answer is not drawn on the next board

  async function work(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const next = wanted.find((w) => !paths.has(w.route));
        if (!next) break;
        const gen = generation;
        try {
          const { data } = await fetchTrip(next.tripId, AbortSignal.timeout(FETCH_TIMEOUT_MS));
          paths.set(next.route, tripRoute(data)?.path ?? []);
        } catch {
          if (gen !== generation) continue;
          // Not this time; the line is dropped for this board rather than asked for again and again.
          wanted = wanted.filter((w) => w !== next);
          failed.add(next.line);
          continue;
        }
        if (gen === generation) draw();
      }
    } finally {
      busy = false;
    }
  }

  function draw(): void {
    const data: FeatureCollection = {
      type: "FeatureCollection",
      features: wanted.flatMap((w) => {
        const path = paths.get(w.route);
        if (!path || path.length < 2) return [];
        return [{ type: "Feature", geometry: { type: "LineString", coordinates: path }, properties: { color: w.color } }];
      }),
    };
    map.getSource<maplibregl.GeoJSONSource>(SOURCE_ID)?.setData(data);
  }

  return {
    addLayer(): void {
      map.addSource(SOURCE_ID, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "stop-lines",
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 16, 4],
          "line-opacity": 0.55,
        },
      });
    },

    add(rows: DepartureRow[]): void {
      let added = false;
      for (const r of distinctLines(rows)) {
        if (wanted.length >= MAX_LINES) break;
        const line = lineKey(r);
        if (failed.has(line) || wanted.some((w) => w.line === line)) continue;
        wanted.push({ line, route: routeKey(r), tripId: r.tripId, color: rowColor(r) });
        added = true;
      }
      if (!added) return;
      draw(); // lines already known from an earlier board show at once
      void work();
    },

    clear(): void {
      generation++;
      wanted = [];
      failed = new Set();
      draw();
    },
  };
}
