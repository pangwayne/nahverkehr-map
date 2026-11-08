// The live overview's data, without the map: the three city answers and the map tiles, when to fetch them,
// how long each says something about now, and each city's numbers. No DOM and no MapLibre here, so the
// numbers can be checked in plain Node, and the overview works even when the map cannot start.
// A city's numbers come from that city's own answer only. Tiles are for drawing the map outside the cities:
// they never change a city's numbers.

import type { Fetched } from "./api";
import { CITY_IDS, type CityId, cityOf } from "./cities";
import {
  type MapSegment,
  type ModeGroup,
  type Summary,
  buildFleet,
  isCounted,
  isUnusual,
  modeGroup,
  newestFirst,
  positionsAt,
  validSegments,
  summarize,
} from "./fleet";
import type { PreparedTrip, VehiclePosition } from "./vehicles";

export const CITY_REFRESH_MS = 60_000; // each city as fresh as the Worker's shared copy (one per minute)
export const TILE_REFRESH_MS = 120_000; // per tile: ~100 KB at rush hour, so ~3 MB an hour for one tile
export const RETRY_MS = 30_000; // after a failed fetch
const FETCH_TIMEOUT_MS = 20_000;
const KEEP_TILES = 12; // answers kept for tiles scrolled away, so panning back costs nothing
const MAX_WORST = 5;
// More broken entries than this share of an answer: the city's numbers are shown with a warning, but no
// finding comes from them (decision 2026-10-31).
export const PARTIAL_SHARE = 0.1;

// One answer kept: a city's ("city:koeln") or a map tile's ("x,y").
export interface SourceState {
  key: string;
  segments: MapSegment[];
  fetchedAtMs: number; // when the Worker got it from Transitous (0: never loaded)
  windowEndMs: number; // the end of the time window the answer covers: after it, it says nothing about now
  loadedMs: number; // when this browser got it
  failedMs: number | null; // the latest try failed
  stale: boolean; // the Worker sent its last good copy
  entries: number; // entries in the answer
  dropped: number; // broken entries left out
  fleet: PreparedTrip[]; // built when the answer was accepted (an answer is only kept with its fleet)
}

// Too many broken entries for findings (PARTIAL_SHARE).
export const isPartial = (s: SourceState): boolean => s.entries > 0 && s.dropped / s.entries > PARTIAL_SHARE;

// Never loaded, or its refresh (or retry after a failure) is due.
export function due(s: SourceState | undefined, refreshMs: number, now: number): boolean {
  return !s || (s.failedMs !== null ? now - s.failedMs >= RETRY_MS : now - s.loadedMs >= refreshMs);
}

export const usable = (s: SourceState | undefined, now: number): boolean => !!s && s.fetchedAtMs > 0 && now < s.windowEndMs;

// The window end the Worker sent (X-Window-End), checked: a number, after the fetch minus a window, and not
// further ahead than a window plus a minute. Anything else (an old Worker, a broken header): fetch time plus
// the window, as before.
export function windowEnd(sent: number | null, fetchedAtMs: number, windowMs: number, nowMs: number): number {
  if (sent !== null && Number.isFinite(sent) && sent > fetchedAtMs - windowMs && sent <= nowMs + windowMs + 60_000) {
    return sent;
  }
  return fetchedAtMs + windowMs;
}

// A city's data quality, the same on every surface (headline, table, findings, ranking, phone strip):
// - ok: a current answer
// - stale: the Worker sent its last good copy (still inside its window)
// - refreshFailed: the latest refresh failed (no answer, or one that could not be read or built); the older
//   answer is still inside its window, with its own time
// - partial: a current answer with more than PARTIAL_SHARE of its entries broken
// - loading: nothing usable yet, a try is running or due
// - failed: never loaded, and the try failed
// - expired: the answer's window is over and the refresh failed
export type CityState = "ok" | "stale" | "refreshFailed" | "partial" | "loading" | "failed" | "expired";

export function cityState(s: SourceState | undefined, isLoading: boolean, now: number): CityState {
  if (s && usable(s, now)) return s.stale ? "stale" : s.failedMs !== null ? "refreshFailed" : isPartial(s) ? "partial" : "ok";
  if (isLoading || !s || s.failedMs === null) return "loading";
  return s.fetchedAtMs > 0 ? "expired" : "failed";
}

// Numbers may be shown (with a warning unless ok).
export const hasNumbers = (state: CityState): boolean =>
  state === "ok" || state === "stale" || state === "refreshFailed" || state === "partial";

// One city's numbers for the chosen kinds: its counted vehicles inside its limits, from its own answer.
export interface CityAnalysis {
  id: CityId;
  state: CityState;
  fetchedAtMs: number | null; // of the answer the numbers come from
  windowEndMs: number | null;
  dropped: number; // broken entries left out of that answer
  vehicles: VehiclePosition[]; // counted, chosen kinds, inside the city limits; empty without numbers
  unusual: number; // of those, reporting 60+ min: left out of `vehicles` and every number
  summary: Summary;
}

// The counted vehicles of `fleet` inside city `id` at `now`, of the chosen kinds.
export function cityVehicles(fleet: PreparedTrip[], id: CityId, groups: Set<ModeGroup>, now: number): VehiclePosition[] {
  return positionsAt(fleet, now).filter((v) => isCounted(v) && groups.has(modeGroup(v.mode)) && cityOf(v.lon, v.lat) === id);
}

// The worse state first: all three together are only as good as the worst city.
const STATE_ORDER: CityState[] = ["failed", "expired", "loading", "partial", "refreshFailed", "stale", "ok"];

// Several cities as one: numbers only once every one of them has them (two cities would look like three),
// the worst city's state, the oldest answer's time, and every city's vehicles in one summary. A line running
// through two cities (16 and 18, Bonn to Köln) is one line here.
export function combineAnalyses(list: CityAnalysis[]): Omit<CityAnalysis, "id"> {
  const state = STATE_ORDER.find((st) => list.some((a) => a.state === st)) ?? "loading";
  const ok = hasNumbers(state);
  const vehicles = ok ? list.flatMap((a) => a.vehicles) : [];
  const times = (key: "fetchedAtMs" | "windowEndMs") => (ok ? Math.min(...list.map((a) => a[key]!)) : null);
  return {
    state,
    fetchedAtMs: times("fetchedAtMs"),
    windowEndMs: times("windowEndMs"),
    dropped: ok ? list.reduce((n, a) => n + a.dropped, 0) : 0,
    vehicles,
    unusual: ok ? list.reduce((n, a) => n + a.unusual, 0) : 0,
    summary: summarize(vehicles, MAX_WORST),
  };
}

export interface LiveDataOptions {
  fetchCity: (id: CityId, signal: AbortSignal) => Promise<Fetched<unknown>>;
  fetchTile: (key: string, signal: AbortSignal) => Promise<Fetched<unknown>>;
  cityWindowMs: number;
  tileWindowMs: number;
  onChange: () => void; // an answer came in or a try started or failed
  now?: () => number;
}

export type LiveData = ReturnType<typeof createLiveData>;

export function createLiveData(opts: LiveDataOptions) {
  const now = opts.now ?? Date.now;
  const cities = new Map<CityId, SourceState>(); // the three city answers, always kept
  const tiles = new Map<string, SourceState>(); // tiles, only for map views outside the city boxes
  const loading = new Set<string>();
  let wanted: string[] = [];
  // The drawn fleet (cities and tiles together), rebuilt only when the answers change.
  let mapFleet: PreparedTrip[] = [];
  let mapFrom = "";

  const cityKey = (id: CityId): string => `city:${id}`;

  // Fetch what is due: all three cities every minute (`selected` first), and the wanted tiles. Nothing while
  // the page is hidden.
  function sync(selected: CityId, visible: boolean): void {
    if (!visible) return;
    const t = now();
    for (const id of [selected, ...CITY_IDS.filter((c) => c !== selected)]) {
      if (due(cities.get(id), CITY_REFRESH_MS, t) && !loading.has(cityKey(id))) {
        void load(cityKey(id), opts.cityWindowMs, (signal) => opts.fetchCity(id, signal), (s) => cities.set(id, s), () => cities.get(id));
      }
    }
    for (const key of wanted) {
      if (due(tiles.get(key), TILE_REFRESH_MS, t) && !loading.has(key)) {
        void load(key, opts.tileWindowMs, (signal) => opts.fetchTile(key, signal), (s) => tiles.set(key, s), () => tiles.get(key));
      }
    }
  }

  // The tiles the map wants now (outside the city boxes). Old answers of tiles scrolled away are kept for a
  // while, so panning back costs nothing.
  function setWanted(keys: string[]): void {
    wanted = keys;
    if (tiles.size <= KEEP_TILES) return;
    const keep = new Set(wanted);
    const old = [...tiles.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].loadedMs - b[1].loadedMs);
    for (const [k] of old.slice(0, tiles.size - KEEP_TILES)) tiles.delete(k);
  }

  async function load(
    key: string,
    windowMs: number,
    get: (signal: AbortSignal) => Promise<Fetched<unknown>>,
    put: (s: SourceState) => void,
    old: () => SourceState | undefined,
  ): Promise<void> {
    loading.add(key);
    opts.onChange();
    let res: Fetched<unknown> | null = null;
    try {
      res = await get(AbortSignal.timeout(FETCH_TIMEOUT_MS));
    } catch (err) {
      console.warn("vehicles failed", key, err);
    }
    loading.delete(key);
    const t = now();
    // Not a list, nothing in it usable, or a fleet that cannot be built: a failed try, like no answer. An
    // answer is only kept together with its built fleet, so old vehicles never get a new answer's time.
    const checked = res ? validSegments(res.data) : null;
    let fleet: PreparedTrip[] | null = null;
    if (checked) {
      try {
        fleet = buildFleet([checked.segments]);
      } catch (err) {
        console.warn("vehicles could not be built", key, err);
      }
    }
    const fetchedAtMs = res && Number.isFinite(res.fetchedAtMs) ? res.fetchedAtMs : t;
    const prev = old();
    if (res && checked && fleet) {
      put({
        key,
        segments: checked.segments,
        fetchedAtMs,
        windowEndMs: windowEnd(res.windowEndMs ?? null, fetchedAtMs, windowMs, t),
        loadedMs: t,
        failedMs: null,
        stale: res.cacheState === "STALE",
        entries: checked.segments.length + checked.dropped,
        dropped: checked.dropped,
        fleet,
      });
    } else if (prev) {
      prev.failedMs = t;
    } else {
      put({ key, segments: [], fetchedAtMs: 0, windowEndMs: 0, loadedMs: 0, failedMs: t, stale: false, entries: 0, dropped: 0, fleet: [] });
    }
    opts.onChange();
  }

  // A city's fleet: the one built with its current answer, nothing else.
  function cityFleet(id: CityId): PreparedTrip[] {
    const s = cities.get(id);
    return s && usable(s, now()) ? s.fleet : [];
  }

  // What the map draws: the three cities and the wanted tiles, newest answer first (where two answers carry
  // the same stretch, the newer prediction wins). Never used for the numbers.
  function drawnFleet(): PreparedTrip[] {
    const t = now();
    const used = newestFirst(
      [...CITY_IDS.map((id) => cities.get(id)), ...wanted.map((k) => tiles.get(k))].filter((s): s is SourceState => usable(s, t)),
    );
    const from = used.map((s) => `${s.key}@${s.loadedMs}`).join(" ");
    if (from === mapFrom) return mapFleet;
    try {
      mapFleet = buildFleet(used.map((s) => s.segments));
      mapFrom = from;
    } catch (err) {
      console.warn("map fleet failed", err);
    }
    return mapFleet;
  }

  function state(id: CityId): CityState {
    return cityState(cities.get(id), loading.has(cityKey(id)), now());
  }

  // One city's numbers for the chosen kinds, from its own answer only.
  function analysis(id: CityId, groups: Set<ModeGroup>): CityAnalysis {
    const st = state(id);
    const s = cities.get(id);
    const all = hasNumbers(st) ? cityVehicles(cityFleet(id), id, groups, now()) : [];
    const vehicles = all.filter((v) => !isUnusual(v)); // a 60+ min report is probably stuck: no number uses it
    return {
      id,
      state: st,
      fetchedAtMs: hasNumbers(st) ? s!.fetchedAtMs : null,
      windowEndMs: hasNumbers(st) ? s!.windowEndMs : null,
      dropped: hasNumbers(st) ? s!.dropped : 0,
      vehicles,
      unusual: all.length - vehicles.length,
      summary: summarize(vehicles, MAX_WORST),
    };
  }

  return { sync, setWanted, drawnFleet, analysis, state, city: (id: CityId) => cities.get(id) };
}
