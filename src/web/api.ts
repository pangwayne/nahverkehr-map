// Typed fetch helpers + the Transitous (MOTIS 2) shapes we use.

export interface Place {
  name: string;
  stopId?: string;
  lat: number;
  lon: number;
  track?: string;
}

export type Mode =
  | "TRAM"
  | "SUBWAY"
  | "BUS"
  | "COACH"
  | "SUBURBAN"
  | "REGIONAL_RAIL"
  | "REGIONAL_FAST_RAIL"
  | "RAIL"
  | "LONG_DISTANCE"
  | "HIGHSPEED_RAIL"
  | "NIGHT_RAIL"
  | "AIRPLANE"
  | "OTHER" // e.g. extra trips added by the live feed
  | (string & {});

// One platform from map/stops. German IDs look like "de-DELFI_de:05314:61101:2:64".
export interface StopPlace extends Place {
  stopId: string;
  modes?: Mode[];
}

// Where and when one departure happens. Times are ISO strings in UTC; departure includes delay.
export interface StopTimePlace extends Place {
  departure?: string;
  scheduledDeparture?: string;
  cancelled?: boolean;
}

export interface StopTime {
  place: StopTimePlace;
  mode: Mode;
  realTime: boolean;
  headsign: string;
  tripId: string;
  displayName?: string;
  routeShortName?: string;
  routeColor?: string; // "rrggbb", only when the feed has one
  routeTextColor?: string;
  cancelled: boolean;
  tripCancelled: boolean;
  pickupDropoffType?: "NORMAL" | "NOT_ALLOWED" | (string & {});
}

export interface StopTimesResponse {
  stopTimes: StopTime[];
}

// One stop of a trip (from /trip). The first stop has no arrival, the last one no departure.
export interface TripStopPlace extends Place {
  arrival?: string;
  scheduledArrival?: string;
  departure?: string;
  scheduledDeparture?: string;
  cancelled?: boolean;
}

export interface Leg {
  mode: Mode;
  tripId?: string;
  headsign?: string;
  displayName?: string;
  routeShortName?: string;
  routeColor?: string;
  routeTextColor?: string;
  realTime: boolean;
  cancelled?: boolean;
  from: TripStopPlace;
  to: TripStopPlace;
  intermediateStops?: TripStopPlace[];
  legGeometry: { points: string; precision: number }; // precision 6 here, unlike map/trips (5)
}

// /trip answers with a trip as an itinerary: usually one leg, several if the vehicle changes number.
export interface Itinerary {
  legs: Leg[];
}

// One leg of a /plan answer: a ride (with a trip) or a walk ("WALK", no trip, no line).
export interface PlanLeg extends Leg {
  startTime: string; // predicted, UTC
  endTime: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  duration: number; // seconds
  interlineWithPreviousLeg?: boolean; // same vehicle as the leg before: stay seated
}

export interface PlanItinerary {
  startTime: string;
  endTime: string;
  duration: number; // seconds
  transfers: number;
  legs: PlanLeg[];
}

// /plan: connections, plus walking all the way (`direct`), plus cursors for earlier and later ones.
export interface PlanResponse {
  itineraries: PlanItinerary[];
  direct: PlanItinerary[];
  previousPageCursor?: string;
  nextPageCursor?: string;
}

export interface Fetched<T> {
  data: T;
  fetchedAtMs: number; // when the Worker got it from Transitous
  cacheState: string | null; // HIT / MISS / STALE (debug)
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<Fetched<T>> {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  const data = (await res.json()) as T;
  const fetchedHeader = res.headers.get("X-Fetched-At");
  return {
    data,
    fetchedAtMs: fetchedHeader ? Date.parse(fetchedHeader) : Date.now(),
    cacheState: res.headers.get("X-Cache"),
  };
}

// The query only changes the address, so browsers do not reuse a list cached before the area grew.
// The Worker ignores it.
export function fetchStops(signal?: AbortSignal): Promise<Fetched<StopPlace[]>> {
  return fetchJson<StopPlace[]>("/api/stops?area=rheinland-1", signal);
}

export function fetchDepartures(stopId: string, signal?: AbortSignal): Promise<Fetched<StopTimesResponse>> {
  return fetchJson<StopTimesResponse>(`/api/departures?stopId=${encodeURIComponent(stopId)}`, signal);
}

export function fetchTrip(tripId: string, signal?: AbortSignal): Promise<Fetched<Itinerary>> {
  return fetchJson<Itinerary>(`/api/trip?tripId=${encodeURIComponent(tripId)}`, signal);
}

// What the route panel asks for; the Worker checks every field again (src/worker/transitous.ts).
export interface PlanRequest {
  from: string; // stop IDs
  to: string;
  time: string; // "2026-10-24T17:00Z"
  arriveBy: boolean;
  cursor: string | null; // earlier / later page
}

// A route search the Worker refused or could not answer. `status` is null when nothing came back at all.
export class PlanError extends Error {
  constructor(
    readonly status: number | null,
    readonly retryAfterS: number | null,
  ) {
    super(`/api/plan failed (${status ?? "no answer"})`);
  }
}

export async function fetchPlan(q: PlanRequest, signal?: AbortSignal): Promise<Fetched<PlanResponse>> {
  const params = new URLSearchParams({ from: q.from, to: q.to, time: q.time, arriveBy: q.arriveBy ? "1" : "0" });
  if (q.cursor) params.set("cursor", q.cursor);
  let res: Response;
  try {
    res = await fetch(`/api/plan?${params.toString()}`, { signal });
  } catch (err) {
    if (signal?.aborted && signal.reason instanceof DOMException && signal.reason.name === "AbortError") throw err;
    throw new PlanError(null, null); // offline, or the time limit ran out
  }
  if (!res.ok) {
    const retry = Number(res.headers.get("Retry-After"));
    throw new PlanError(res.status, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  const fetchedHeader = res.headers.get("X-Fetched-At");
  return {
    data: (await res.json()) as PlanResponse,
    fetchedAtMs: fetchedHeader ? Date.parse(fetchedHeader) : Date.now(),
    cacheState: res.headers.get("X-Cache"),
  };
}
