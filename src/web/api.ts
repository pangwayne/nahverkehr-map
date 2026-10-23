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

export function fetchStops(signal?: AbortSignal): Promise<Fetched<StopPlace[]>> {
  return fetchJson<StopPlace[]>("/api/stops", signal);
}

export function fetchDepartures(stopId: string, signal?: AbortSignal): Promise<Fetched<StopTimesResponse>> {
  return fetchJson<StopTimesResponse>(`/api/departures?stopId=${encodeURIComponent(stopId)}`, signal);
}

export function fetchTrip(tripId: string, signal?: AbortSignal): Promise<Fetched<Itinerary>> {
  return fetchJson<Itinerary>(`/api/trip?tripId=${encodeURIComponent(tripId)}`, signal);
}
