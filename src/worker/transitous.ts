// Transitous (MOTIS 2) request building. Pure functions, unit tested.

export const TRANSITOUS_BASE = "https://api.transitous.org";

// Identifies us to Transitous, as their usage policy requires.
export const USER_AGENT = "nahverkehr-map/0.1.0 (+https://nahverkehr.pangwayne.com)";

// Stop area: Bonn (Bad Godesberg) up to Düsseldorf (Ratingen), Neuss to Wuppertal.
// Transitous wants min = lower-right, max = upper-left, both "lat,lon".
export const AREA = { south: 50.63, north: 51.36, west: 6.68, east: 7.22 };
export const AREA_MIN = `${AREA.south},${AREA.east}`;
export const AREA_MAX = `${AREA.north},${AREA.west}`;

export function isInArea(lat: number, lon: number): boolean {
  return lat >= AREA.south && lat <= AREA.north && lon >= AREA.west && lon <= AREA.east;
}

// Part of the stops cache key: change it whenever the area changes, so the old list is not served.
export const AREA_VERSION = "rheinland-1";

// All visitors asking for the same stop within the same 20 s share one upstream request.
export const DEPARTURES_BUCKET_MS = 20_000;

// Enough rows for a big station (Bonn Hbf has 32 platforms) to cover the next ~20 minutes: the board shows 8,
// "more departures" the rest. Measured 2026-10-25 at Bonn Hbf: 20 rows reached 10 min, 40 rows 23 min
// (80 KB JSON, 7 KB gzip; 20 rows: 4 KB gzip). One request either way.
export const DEPARTURES_COUNT = 40;

// Only German stops (the IDs our stops list uses). Keeps the Worker from proxying arbitrary requests.
const STOP_ID_PATTERN = /^de-DELFI_[A-Za-z0-9:._-]{1,80}$/;

// One trip's details (all stops, whole track line) change only when its delays do.
export const TRIP_BUCKET_MS = 60_000;

// Trip IDs of German trams, buses and regional trains: "<service day>_<start time>_de-DELFI_<id>",
// e.g. "20261020_21:41_de-DELFI_3435794835". Times can pass 24:00 ("20261020_24:43_...": after midnight,
// same service day, never past 47:59). Same reason as the stop ID check.
const TRIP_ID_PATTERN = /^20\d{6}_(?:[0-3]\d|4[0-7]):[0-5]\d_de-DELFI_[A-Za-z0-9:._-]{1,80}$/;

export function bucketStart(nowMs: number, bucketMs: number): number {
  return Math.floor(nowMs / bucketMs) * bucketMs;
}

export function isValidStopId(stopId: string): boolean {
  return STOP_ID_PATTERN.test(stopId);
}

export function isValidTripId(tripId: string): boolean {
  return TRIP_ID_PATTERN.test(tripId);
}

// A position as a route search end: "lat,lon" with up to 6 decimals (as the browser sends it), inside the stop
// area. The area check keeps the Worker from planning routes anywhere in Europe for anyone.
// A route between two positions is allowed (address to address), but only between two points in the area.
const POSITION_PATTERN = /^(\d{2}\.\d{1,6}),(\d{1,2}\.\d{1,6})$/;

export function isValidPosition(place: string): boolean {
  const match = POSITION_PATTERN.exec(place);
  return match !== null && isInArea(Number(match[1]), Number(match[2]));
}

// The whole trip as one itinerary: every stop with times, plus its track line (precision 6).
export function buildTripUrl(tripId: string): string {
  const params = new URLSearchParams({ tripId });
  return `${TRANSITOUS_BASE}/api/v6/trip?${params.toString()}`;
}

export function buildStopsUrl(): string {
  const params = new URLSearchParams({ min: AREA_MIN, max: AREA_MAX });
  return `${TRANSITOUS_BASE}/api/v6/map/stops?${params.toString()}`;
}

// Asking for one platform also returns the other platforms of the station (and close neighbours).
// `cursor`: the "later" page of an earlier answer ("LATER|1792961640"), for more departures.
export function buildDeparturesUrl(stopId: string, cursor: string | null = null): string {
  const params = new URLSearchParams({ stopId, n: String(DEPARTURES_COUNT) });
  if (cursor) params.set("pageCursor", cursor);
  return `${TRANSITOUS_BASE}/api/v6/stoptimes?${params.toString()}`;
}

// A board's page cursor: only "later", from now up to a day ahead (a board is about the next hours, and
// anything further would let a script page through the whole timetable).
const DEPARTURES_CURSOR_PATTERN = /^LATER\|(\d{10})$/;
export const DEPARTURES_CURSOR_AHEAD_MS = 86_400_000;

export function isValidDeparturesCursor(cursor: string, nowMs: number): boolean {
  const match = DEPARTURES_CURSOR_PATTERN.exec(cursor);
  if (!match) return false;
  const ms = Number(match[1]) * 1000;
  return ms >= nowMs - 3600_000 && ms <= nowMs + DEPARTURES_CURSOR_AHEAD_MS;
}

// Place search (addresses and landmarks; stops are searched in the browser). The text is what the user typed
// and pressed Search for: 2-80 characters, no control characters. Results only from inside the stop area.
const GEOCODE_MIN = 2;
const GEOCODE_MAX = 80;
export const GEOCODE_RESULTS = 8;

export interface GeocodeQuery {
  text: string; // trimmed, spaces collapsed, lower case: one cache entry for "Bonn" and "bonn "
  lang: "de" | "en";
}

export function parseGeocodeQuery(params: URLSearchParams): GeocodeQuery | null {
  const raw = params.get("text") ?? "";
  const lang = params.get("lang") ?? "de";
  if (lang !== "de" && lang !== "en") return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const text = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (text.length < GEOCODE_MIN || text.length > GEOCODE_MAX) return null;
  return { text, lang };
}

export function buildGeocodeUrl(q: GeocodeQuery): string {
  const params = new URLSearchParams({
    text: q.text,
    language: q.lang,
    type: "ADDRESS,PLACE",
    min: AREA_MIN,
    max: AREA_MAX,
    numResults: String(GEOCODE_RESULTS),
  });
  return `${TRANSITOUS_BASE}/api/v1/geocode?${params.toString()}`;
}

// Travel settings a route search may carry (all optional; leaving them out keeps the defaults).
// Modes as letters: b = bus, t = tram/Stadtbahn/U-Bahn, s = S-Bahn, r = regional trains.
const MODE_LETTERS: Record<string, string> = {
  b: "BUS",
  t: "TRAM,SUBWAY",
  s: "SUBURBAN",
  r: "REGIONAL_RAIL,REGIONAL_FAST_RAIL",
};
export const PLAN_MAX_EXTRA_MIN = 15; // extra time for each change
export const PLAN_MAX_WALK_MIN = 15; // longest walk to the first / from the last stop (Transitous' own default)

export interface PlanPrefs {
  modes: string | null; // "bt": buses and trams only; null: all
  maxTransfers: number | null; // 0-3; null: the default (PLAN_MAX_TRANSFERS)
  extraMin: number | null; // 1-15 minutes extra for each change
  walkMin: number | null; // 1-14 minutes at most for the first and last walk
}

export const NO_PREFS: PlanPrefs = { modes: null, maxTransfers: null, extraMin: null, walkMin: null };

const INT = /^\d{1,2}$/;

// The settings from a request, or null if one of them is malformed. Defaults stay null, so the same search
// with and without "default" settings shares one cache entry.
export function parsePlanPrefs(params: URLSearchParams): PlanPrefs | null {
  const prefs: PlanPrefs = { ...NO_PREFS };
  const modes = params.get("modes");
  if (modes !== null) {
    const letters = [...new Set(modes)].sort().join("");
    if (!letters || [...letters].some((l) => !(l in MODE_LETTERS)) || letters.length !== modes.length) return null;
    if (letters !== Object.keys(MODE_LETTERS).sort().join("")) prefs.modes = letters;
  }
  const number = (name: string, min: number, max: number): number | null | undefined => {
    const v = params.get(name);
    if (v === null) return null;
    if (!INT.test(v)) return undefined;
    const n = Number(v);
    return n >= min && n <= max ? n : undefined;
  };
  const transfers = number("maxTransfers", 0, PLAN_MAX_TRANSFERS);
  const extra = number("extra", 0, PLAN_MAX_EXTRA_MIN);
  const walk = number("walk", 1, PLAN_MAX_WALK_MIN);
  if (transfers === undefined || extra === undefined || walk === undefined) return null;
  prefs.maxTransfers = transfers === PLAN_MAX_TRANSFERS ? null : transfers;
  prefs.extraMin = extra === 0 ? null : extra;
  prefs.walkMin = walk === PLAN_MAX_WALK_MIN ? null : walk;
  return prefs;
}

// The settings as query fields (only those that differ from the default), for cache keys and the browser.
export function prefsParams(p: PlanPrefs): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.modes) out["modes"] = p.modes;
  if (p.maxTransfers !== null) out["maxTransfers"] = String(p.maxTransfers);
  if (p.extraMin !== null) out["extra"] = String(p.extraMin);
  if (p.walkMin !== null) out["walk"] = String(p.walkMin);
  return out;
}

// Route search. The browser chooses only these fields; everything else sent to Transitous is fixed here.
export interface PlanQuery {
  from: string; // stop ID, or a position ("50.7300,7.0960"): My location, an address or a point on the map
  to: string; // the same
  time: string; // "2026-10-24T17:00Z", UTC, whole minutes
  arriveBy: boolean; // true: arrive by `time`; false: leave at `time`
  cursor: string | null; // "LATER|1792863900" from an earlier answer, for earlier/later options
  prefs: PlanPrefs;
}

// Same modes as the boards: no IC/ICE, coaches or planes (an ICE showed up without this).
export const PLAN_MODES = "TRAM,SUBWAY,BUS,SUBURBAN,REGIONAL_RAIL,REGIONAL_FAST_RAIL";
// numItineraries alone is only a minimum (a "later" page once brought 12); maxItineraries caps it.
export const PLAN_OPTIONS = 5;
export const PLAN_MAX_TRANSFERS = 4;
// How far the search time may lie from now: a little in the past (a page left open), a week ahead.
export const PLAN_PAST_MS = 2 * 3600_000;
export const PLAN_AHEAD_MS = 7 * 86_400_000;
// A page cursor may point a little past that window, on purpose: the "later" page of a search near the end
// of the week points a few hours beyond it, the "earlier" page of a search 2 h back points before it. A day
// covers both without opening far-off dates.
export const PLAN_CURSOR_MARGIN_MS = 86_400_000;

const PLAN_TIME_PATTERN = /^20\d{2}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\dZ$/;
const PLAN_CURSOR_PATTERN = /^(EARLIER|LATER)\|(\d{10})$/;

// The checked search, or null if any field is missing, malformed, a date that does not exist,
// outside the allowed time window, or from and to are the same place. Either end may be a position, as long
// as it lies in the stop area (so this is no route planner for anywhere in Europe).
// With a page cursor the cursor's time decides (it wins over `time` upstream), so an old open tab can still
// page; `time` is then only checked for its form (it is part of the cache key).
export function parsePlanQuery(params: URLSearchParams, nowMs: number): PlanQuery | null {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const time = params.get("time") ?? "";
  const arriveBy = params.get("arriveBy") ?? "0";
  const cursor = params.get("cursor");
  if (!(isValidStopId(from) || isValidPosition(from)) || !(isValidStopId(to) || isValidPosition(to))) return null;
  if (from === to) return null;
  const prefs = parsePlanPrefs(params);
  if (!prefs) return null;
  if (!PLAN_TIME_PATTERN.test(time)) return null;
  const ms = Date.parse(time);
  // "2026-02-30T10:00Z" parses as 2 March: the round trip catches dates that do not exist.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 16) + "Z" !== time) return null;
  if (arriveBy !== "0" && arriveBy !== "1") return null;
  if (cursor === null) {
    if (ms < nowMs - PLAN_PAST_MS || ms > nowMs + PLAN_AHEAD_MS) return null;
  } else {
    const match = PLAN_CURSOR_PATTERN.exec(cursor);
    if (!match) return null;
    const cursorMs = Number(match[2]) * 1000;
    const earliest = nowMs - PLAN_PAST_MS - PLAN_CURSOR_MARGIN_MS;
    const latest = nowMs + PLAN_AHEAD_MS + PLAN_CURSOR_MARGIN_MS;
    if (cursorMs < earliest || cursorMs > latest) return null;
  }
  return { from, to, time, arriveBy: arriveBy === "1", cursor, prefs };
}

// A page cursor, when given, wins over the time on Transitous' side. Walks come with their path and
// turn-by-turn steps (detailedTransfers), so the panel can draw and describe them.
export function buildPlanUrl(q: PlanQuery): string {
  const { prefs } = q;
  const modes = prefs.modes ? [...prefs.modes].map((l) => MODE_LETTERS[l]).join(",") : PLAN_MODES;
  const params = new URLSearchParams({
    fromPlace: q.from,
    toPlace: q.to,
    time: q.time,
    arriveBy: String(q.arriveBy),
    transitModes: modes,
    numItineraries: String(PLAN_OPTIONS),
    maxItineraries: String(PLAN_OPTIONS),
    maxTransfers: String(prefs.maxTransfers ?? PLAN_MAX_TRANSFERS),
    detailedTransfers: "true",
  });
  if (prefs.extraMin !== null) params.set("additionalTransferTime", String(prefs.extraMin));
  if (prefs.walkMin !== null) {
    params.set("maxPreTransitTime", String(prefs.walkMin * 60));
    params.set("maxPostTransitTime", String(prefs.walkMin * 60));
  }
  if (q.cursor) params.set("pageCursor", q.cursor);
  return `${TRANSITOUS_BASE}/api/v6/plan?${params.toString()}`;
}
