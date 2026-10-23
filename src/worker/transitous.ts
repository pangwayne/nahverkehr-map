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
// same service day). Same reason as the stop ID check.
const TRIP_ID_PATTERN = /^\d{8}_\d{2}:\d{2}_de-DELFI_[A-Za-z0-9:._-]{1,80}$/;

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
