// Transitous (MOTIS 2) request building. Pure functions, unit tested.

export const TRANSITOUS_BASE = "https://api.transitous.org";

// Identifies us to Transitous, as their usage policy requires.
export const USER_AGENT = "nahverkehr-map/0.1.0 (+https://nahverkehr.pangwayne.com)";

// Stop area: Bonn (Bad Godesberg) up to Düsseldorf (Ratingen), Neuss to Wuppertal.
// Transitous wants min = lower-right, max = upper-left, both "lat,lon".
export const AREA_MIN = "50.63,7.22";
export const AREA_MAX = "51.36,6.68";

// Part of the stops cache key: change it whenever the area changes, so the old list is not served.
export const AREA_VERSION = "rheinland-1";

// All visitors asking for the same stop within the same 20 s share one upstream request.
export const DEPARTURES_BUCKET_MS = 20_000;

// Enough rows for a big station (Bonn Hbf has 32 platforms) to cover the next ~15 minutes.
export const DEPARTURES_COUNT = 20;

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
export function buildDeparturesUrl(stopId: string): string {
  const params = new URLSearchParams({ stopId, n: String(DEPARTURES_COUNT) });
  return `${TRANSITOUS_BASE}/api/v6/stoptimes?${params.toString()}`;
}

// Route search. The browser chooses only these fields; everything else sent to Transitous is fixed here.
export interface PlanQuery {
  from: string; // stop ID
  to: string; // stop ID
  time: string; // "2026-10-24T17:00Z", UTC, whole minutes
  arriveBy: boolean; // true: arrive by `time`; false: leave at `time`
  cursor: string | null; // "LATER|1792863900" from an earlier answer, for earlier/later options
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
// outside the allowed time window, or from and to are the same stop.
// With a page cursor the cursor's time decides (it wins over `time` upstream), so an old open tab can still
// page; `time` is then only checked for its form (it is part of the cache key).
export function parsePlanQuery(params: URLSearchParams, nowMs: number): PlanQuery | null {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const time = params.get("time") ?? "";
  const arriveBy = params.get("arriveBy") ?? "0";
  const cursor = params.get("cursor");
  if (!isValidStopId(from) || !isValidStopId(to) || from === to) return null;
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
  return { from, to, time, arriveBy: arriveBy === "1", cursor };
}

// A page cursor, when given, wins over the time on Transitous' side.
export function buildPlanUrl(q: PlanQuery): string {
  const params = new URLSearchParams({
    fromPlace: q.from,
    toPlace: q.to,
    time: q.time,
    arriveBy: String(q.arriveBy),
    transitModes: PLAN_MODES,
    numItineraries: String(PLAN_OPTIONS),
    maxItineraries: String(PLAN_OPTIONS),
    maxTransfers: String(PLAN_MAX_TRANSFERS),
    detailedTransfers: "false",
  });
  if (q.cursor) params.set("pageCursor", q.cursor);
  return `${TRANSITOUS_BASE}/api/v6/plan?${params.toString()}`;
}
