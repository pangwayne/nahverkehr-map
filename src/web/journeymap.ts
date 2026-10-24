// A chosen connection on the map: each ride in its line's colour, walks as grey dashes, the start as a
// ringed dot, the destination as a filled one, and a small dot where you change.
// Drawn only while its details are open; nothing is fetched for it (the lines came with the search).

import type { FeatureCollection } from "geojson";
import type * as maplibregl from "maplibre-gl";
import type { Journey } from "./plan";
import { shortName } from "./names";

const LEGS_SOURCE = "journey-legs";
const POINTS_SOURCE = "journey-points";
const STOPS_FIRST_LAYER = "stop-dot"; // the lines go under the stop layers, like a trip's route
const WALK_COLOR = "#5f6b7a";
const BUS_COLOR = "#4a5a6a";
const TRAM_COLOR = "#1565c0";

export interface JourneyMap {
  addLayers(): void; // once the map style has loaded
  show(j: Journey | null): void;
}

export function startJourneyMap(map: maplibregl.Map): JourneyMap {
  let shown: Journey | null = null;

  function draw(): void {
    const { legs, points } = journeyGeoJSON(shown);
    map.getSource<maplibregl.GeoJSONSource>(LEGS_SOURCE)?.setData(legs);
    map.getSource<maplibregl.GeoJSONSource>(POINTS_SOURCE)?.setData(points);
  }

  return {
    addLayers(): void {
      addLayers(map);
      draw();
    },
    show(j: Journey | null): void {
      shown = j;
      draw();
    },
  };
}

// Pure, so it is unit tested: the journey as map features (empty collections for null).
export function journeyGeoJSON(j: Journey | null): { legs: FeatureCollection; points: FeatureCollection } {
  const legs: FeatureCollection = { type: "FeatureCollection", features: [] };
  const points: FeatureCollection = { type: "FeatureCollection", features: [] };
  if (!j) return { legs, points };

  for (const leg of j.legs) {
    if (leg.path.length < 2) continue;
    const walk = leg.kind === "walk";
    const color = walk ? WALK_COLOR : (leg.color ?? (leg.mode === "BUS" ? BUS_COLOR : TRAM_COLOR));
    legs.features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: leg.path },
      properties: { color, walk },
    });
  }

  const first = j.legs[0];
  const last = j.legs[j.legs.length - 1];
  if (first && last) {
    const point = (lon: number, lat: number, kind: "start" | "change" | "end", name: string) =>
      points.features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { kind, label: shortName(name) },
      });
    point(first.from.lon, first.from.lat, "start", first.from.name);
    // Where one ride ends and the next begins (walks in between included), once per place.
    for (let i = 1; i < j.legs.length; i++) {
      const leg = j.legs[i]!;
      if (leg.kind === "ride" && !leg.staySeated) point(leg.from.lon, leg.from.lat, "change", leg.from.name);
    }
    point(last.to.lon, last.to.lat, "end", last.to.name);
  }
  return { legs, points };
}

function addLayers(map: maplibregl.Map): void {
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
  map.addSource(LEGS_SOURCE, { type: "geojson", data: empty });
  map.addSource(POINTS_SOURCE, { type: "geojson", data: empty });
  const underStops = map.getLayer(STOPS_FIRST_LAYER) ? STOPS_FIRST_LAYER : undefined;
  const ride: maplibregl.FilterSpecification = ["!", ["get", "walk"]];

  map.addLayer(
    {
      id: "journey-casing",
      type: "line",
      source: LEGS_SOURCE,
      filter: ride,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 16, 11] },
    },
    underStops,
  );
  map.addLayer(
    {
      id: "journey-ride",
      type: "line",
      source: LEGS_SOURCE,
      filter: ride,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 7],
        "line-opacity": 0.9,
      },
    },
    underStops,
  );
  map.addLayer(
    {
      id: "journey-walk",
      type: "line",
      source: LEGS_SOURCE,
      filter: ["get", "walk"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 16, 4],
        "line-dasharray": [1, 2],
      },
    },
    underStops,
  );

  // Start: white with a dark ring; change: small white dot; destination: dark filled dot.
  map.addLayer({
    id: "journey-point",
    type: "circle",
    source: POINTS_SOURCE,
    paint: {
      "circle-radius": ["match", ["get", "kind"], "change", 5, 8],
      "circle-color": ["match", ["get", "kind"], "end", "#11131a", "#ffffff"],
      "circle-stroke-color": "#11131a",
      "circle-stroke-width": ["match", ["get", "kind"], "change", 2, 3],
    },
  });
  map.addLayer({
    id: "journey-point-label",
    type: "symbol",
    source: POINTS_SOURCE,
    filter: ["!=", ["get", "kind"], "change"],
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 12,
      "text-anchor": "left",
      "text-offset": [1, 0],
      "text-optional": true,
    },
    paint: {
      "text-color": "#11131a",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });
}
