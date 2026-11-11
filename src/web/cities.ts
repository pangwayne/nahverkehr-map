// The three cities of the live overview (Bonn, Köln, Düsseldorf): their official limits, the box the Worker
// asks Transitous for, and which city a vehicle is in. Pure functions, shared by the browser and
// the Worker. The numbers describe everything inside a city's limits, whatever the map shows.

import { CITY_LIMITS } from "./citylimits";
import { type Box, MAX_TILES, MIN_ZOOM, tilesInView } from "./tiles";

export type CityId = "bonn" | "koeln" | "duesseldorf";

export interface City {
  id: CityId;
  name: string;
  lon: number;
  lat: number;
}

// The box around a city's limits plus about 500 m, so a vehicle right at the border is in the answer.
const MARGIN_DEG = 0.005;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
function boxAround(ring: [number, number][]): Box {
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return {
    south: round4(Math.min(...lats) - MARGIN_DEG),
    north: round4(Math.max(...lats) + MARGIN_DEG),
    west: round4(Math.min(...lons) - MARGIN_DEG),
    east: round4(Math.max(...lons) + MARGIN_DEG),
  };
}

export const CITY_IDS: CityId[] = ["bonn", "koeln", "duesseldorf"];
// The city a first visit shows: its numbers in the overview, and the map starts there (map.ts).
export const DEFAULT_CITY: CityId = "koeln";
export const CITY_BOXES: Record<CityId, Box> = {
  bonn: boxAround(CITY_LIMITS.bonn),
  koeln: boxAround(CITY_LIMITS.koeln),
  duesseldorf: boxAround(CITY_LIMITS.duesseldorf),
};

export const isCityId = (id: string): id is CityId => (CITY_IDS as string[]).includes(id);

// Ray casting: is (lon, lat) inside the ring? Points exactly on the line may go either way.
function inRing(ring: [number, number][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inCity(id: CityId, lon: number, lat: number): boolean {
  const b = CITY_BOXES[id];
  if (lat < b.south || lat > b.north || lon < b.west || lon > b.east) return false;
  return inRing(CITY_LIMITS[id], lon, lat);
}

// The city a point is in (the three do not touch), or null.
export function cityOf(lon: number, lat: number): CityId | null {
  for (const id of CITY_IDS) if (inCity(id, lon, lat)) return id;
  return null;
}

// Is the box entirely inside one of the city boxes? Then the city answers already cover it (no tiles needed).
export function coveredByCities(box: Box): boolean {
  return CITY_IDS.some((id) => {
    const c = CITY_BOXES[id];
    return box.south >= c.south && box.north <= c.north && box.west >= c.west && box.east <= c.east;
  });
}

// City centres: Bonn Hbf, Köln Dom / Hbf, Düsseldorf Altstadt.
export const CITIES: City[] = [
  { id: "bonn", name: "Bonn", lon: 7.0982, lat: 50.735 },
  { id: "koeln", name: "Köln", lon: 6.9583, lat: 50.9413 },
  { id: "duesseldorf", name: "Düsseldorf", lon: 6.786, lat: 51.223 },
];

const PREFERRED_ZOOM = 13.5;
const MAX_ZOOM = 16;

// The box a map of `width` x `height` px shows around (lon, lat) at `zoom` (MapLibre: 512 px per tile at
// zoom 0, Web Mercator, so a degree of latitude takes more pixels than one of longitude).
export function viewBox(lon: number, lat: number, zoom: number, width: number, height: number): Box {
  const degPerPx = 360 / (512 * 2 ** zoom);
  const halfW = (width / 2) * degPerPx;
  const halfH = (height / 2) * degPerPx * Math.cos((lat * Math.PI) / 180);
  return { south: lat - halfH, north: lat + halfH, west: lon - halfW, east: lon + halfW };
}

// The zoom for a city button: the preferred one, or closer in until the view needs no more tiles than
// allowed (a large screen at the preferred zoom could ask for too many and show nothing).
export function cityZoom(city: City, width: number, height: number, maxTiles = MAX_TILES): number {
  let zoom = Math.max(PREFERRED_ZOOM, MIN_ZOOM);
  while (zoom < MAX_ZOOM && tilesInView(viewBox(city.lon, city.lat, zoom, width, height)).length > maxTiles) {
    zoom += 0.25;
  }
  return zoom;
}

// The city whose centre is near the middle of the view (about 8 km), or null (between cities, say).
export function cityAt(lon: number, lat: number): City | null {
  for (const city of CITIES) {
    if (Math.abs(city.lat - lat) <= 0.075 && Math.abs(city.lon - lon) <= 0.115) return city;
  }
  return null;
}
