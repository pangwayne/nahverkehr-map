// Fitting the map to things while the panel covers part of it. Shared by the trip card and the route panel.

import type * as maplibregl from "maplibre-gl";
import type { LonLat } from "./geo";
import { offsetClearOfPanel } from "./panel";

// Show all points, kept clear of the panel (offset is up on phones, right on wide screens).
export function fitPoints(map: maplibregl.Map, points: LonLat[], maxZoom?: number): void {
  if (!points.length) return;
  let [minLon, minLat] = points[0]!;
  let [maxLon, maxLat] = points[0]!;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const [offsetX, offsetY] = offsetClearOfPanel();
  const padding = { top: 40, right: 40, left: 40 + offsetX * 2, bottom: 40 - offsetY * 2 };
  map.fitBounds(
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    // Leave maxZoom out when not given: `maxZoom: undefined` replaces MapLibre's default and the zoom becomes NaN.
    maxZoom === undefined ? { padding } : { padding, maxZoom },
  );
}
