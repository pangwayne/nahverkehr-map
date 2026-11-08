// The area cut into a fixed grid of tiles for the live vehicle map. Pure functions.
// Shared by the browser (which tiles are on screen) and the Worker (which tiles it accepts), so everyone
// looking at the same part of the map asks for the same tile and shares one cached answer.

export interface Box {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface Tile {
  x: number; // column, west to east
  y: number; // row, south to north
}

// The stop area (src/worker/transitous.ts, AREA; keep the two the same).
export const TILE_AREA: Box = { south: 50.63, north: 51.36, west: 6.68, east: 7.22 };

// About 10 x 10 km. One tile at rush hour: ~300 vehicles, ~100 KB compressed (measured 2026-10-30).
export const TILE_LAT = 0.09;
export const TILE_LON = 0.14;
export const TILE_ROWS = Math.ceil((TILE_AREA.north - TILE_AREA.south) / TILE_LAT - 1e-9);
export const TILE_COLS = Math.ceil((TILE_AREA.east - TILE_AREA.west) / TILE_LON - 1e-9);

// More tiles than this on screen: zoomed out too far, no vehicles are fetched (keeps phone data in check).
export const MAX_TILES = 6;
// Further out than this, vehicles would be specks: none are fetched, whatever the tile count.
export const MIN_ZOOM = 12;

export const tileKey = (tile: Tile): string => `${tile.x},${tile.y}`;

// "x,y" as sent by the browser; anything else, or a tile outside the grid, is null.
export function parseTile(text: string): Tile | null {
  const match = /^(\d{1,2}),(\d{1,2})$/.exec(text);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return x < TILE_COLS && y < TILE_ROWS ? { x, y } : null;
}

export function tileBox(tile: Tile): Box {
  const south = TILE_AREA.south + tile.y * TILE_LAT;
  const west = TILE_AREA.west + tile.x * TILE_LON;
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  return { south: round(south), north: round(south + TILE_LAT), west: round(west), east: round(west + TILE_LON) };
}

// The tiles a map view touches (only those inside the grid), west to east, south to north.
export function tilesInView(view: Box): Tile[] {
  const col = (lon: number) => Math.floor((lon - TILE_AREA.west) / TILE_LON);
  const row = (lat: number) => Math.floor((lat - TILE_AREA.south) / TILE_LAT);
  const x0 = Math.max(0, col(view.west));
  const x1 = Math.min(TILE_COLS - 1, col(view.east));
  const y0 = Math.max(0, row(view.south));
  const y1 = Math.min(TILE_ROWS - 1, row(view.north));
  const out: Tile[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) out.push({ x, y });
  }
  return out;
}

// What the live map fetches for a view: its tiles, or nothing when zoomed out too far. Zooming out can never
// load the whole area at once (~700 KB).
export function tilesToFetch(view: Box, zoom: number, maxTiles = MAX_TILES): { tiles: Tile[]; zoomedOut: boolean } {
  const tiles = tilesInView(view);
  const zoomedOut = zoom < MIN_ZOOM || tiles.length > maxTiles;
  return { tiles: zoomedOut ? [] : tiles, zoomedOut };
}
