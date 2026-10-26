// Fitting the map to things while the panel covers part of it. Shared by the trip card and the route panel.

import type * as maplibregl from "maplibre-gl";
import { MIN_FREE_PX, fitPadding } from "./fitpadding";
import type { LonLat } from "./geo";
import { panelChanges, panelCover, shrinkPanel } from "./panel";

// The last fit, done again when the screen turns or changes size, unless the map was moved by hand since or
// the panel was opened or closed (then something else is shown).
let last: { map: maplibregl.Map; points: LonLat[]; maxZoom?: number; openings: number; moved: boolean } | null = null;
let watching = false;

function watch(map: maplibregl.Map): void {
  if (watching) return;
  watching = true;
  // Only moves by a person carry the browser event; our own fits do not.
  map.on("movestart", (e) => {
    if (last && (e as { originalEvent?: Event }).originalEvent) last.moved = true;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (last && !last.moved && last.openings === panelChanges()) fit(last.map, last.points, last.maxZoom);
    }, 250);
  });
}

// Show all points, kept clear of the panel (it covers the bottom on phones, the left on wide screens).
export function fitPoints(map: maplibregl.Map, points: LonLat[], maxZoom?: number): void {
  if (!points.length) return;
  watch(map);
  last = { map, points, maxZoom, openings: panelChanges(), moved: false };
  fit(map, points, maxZoom);
}

function fit(map: maplibregl.Map, points: LonLat[], maxZoom: number | undefined): void {
  let [minLon, minLat] = points[0]!;
  let [maxLon, maxLat] = points[0]!;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const box = map.getContainer().getBoundingClientRect();
  let cover = panelCover(box);
  // Hardly any map left above a tall phone sheet: the sheet goes back to normal, so the route can be seen.
  if (box.height - cover.bottom < MIN_FREE_PX && shrinkPanel()) cover = panelCover(box);
  const padding = fitPadding(box.width, box.height, cover);
  map.fitBounds(
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    // Leave maxZoom out when not given: `maxZoom: undefined` replaces MapLibre's default and the zoom becomes NaN.
    maxZoom === undefined ? { padding } : { padding, maxZoom },
  );
}
