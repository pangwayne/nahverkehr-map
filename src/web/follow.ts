// An open connection kept current through its rides' trips (/api/trip, the same requests a trip card makes).
// The connection stays the same one: no other departure is picked. No DOM here (the route panel draws it), so
// this is tested on its own.

import { type Fetched, type Itinerary, isStale } from "./api";
import { type Journey, type RideChange, type RideLeg, rideChanges, updateRide, withRides } from "./plan";
import { tripRoute } from "./trip";

export const FOLLOW_POLL_MS = 60_000;
// After the journey has arrived (the later of planned and expected), it is followed this much longer: a late
// arrival can still move. Then the timer stops; Refresh still works.
export const FOLLOW_AFTER_END_MS = 5 * 60_000;

export interface Followed {
  origin: Journey; // as the search found it, to say what changed since
  journey: Journey; // with the latest times
  fetchedAtMs: number; // the oldest of its rides' data
  lastTryMs: number;
  failed: boolean; // the last refresh (or the search it came from) did not reach every ride
  busy: boolean;
  changes: RideChange[];
}

// `fetchedAtMs` and `failed`: as the search answer the connection came from (a stale answer stays marked
// until a refresh of the rides works).
export function follow(j: Journey, fetchedAtMs: number, failed: boolean, nowMs: number): Followed {
  return { origin: j, journey: j, fetchedAtMs, lastTryMs: nowMs, failed, busy: false, changes: [] };
}

export function followEnded(f: Followed, nowMs: number): boolean {
  return nowMs > Math.max(f.journey.arrMs, f.journey.schedArrMs) + FOLLOW_AFTER_END_MS;
}

// Time for the timer to refresh: a minute since the last try, not running, and the journey not over yet.
export function dueForRefresh(f: Followed, nowMs: number): boolean {
  return !f.busy && !followEnded(f, nowMs) && nowMs - f.lastTryMs >= FOLLOW_POLL_MS;
}

export type TripFetch = (tripId: string) => Promise<Fetched<Itinerary>>;

// One refresh: every ride's trip, then the walks move along. A ride whose answer failed, came stale or could
// not be read keeps its last times, and the refresh counts as failed (the age stays that of the oldest data).
// `busy` is set at once (before the first await) and always cleared again, whatever the answers are.
export async function refreshFollowed(f: Followed, fetchTrip: TripFetch): Promise<void> {
  if (f.busy) return;
  f.busy = true;
  f.lastTryMs = Date.now();
  try {
    const j = f.journey;
    const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride" && l.tripId !== null);
    const answers = await Promise.allSettled(rides.map((r) => fetchTrip(r.tripId!)));
    const updated = new Map<RideLeg, RideLeg>();
    let failed = false;
    let oldest = Infinity;
    answers.forEach((a, i) => {
      const ride = rides[i]!;
      const next = a.status === "fulfilled" ? freshRide(ride, a.value.data) : null;
      if (a.status !== "fulfilled" || !next) {
        failed = true;
        return;
      }
      if (isStale(a.value)) failed = true;
      oldest = Math.min(oldest, a.value.fetchedAtMs);
      updated.set(ride, next);
    });
    const next = withRides(j, updated);
    f.journey = next;
    f.failed = failed;
    if (!failed && Number.isFinite(oldest)) f.fetchedAtMs = oldest;
    f.changes = rideChanges(f.origin, next);
  } catch {
    f.failed = true; // the times stay as they were
  } finally {
    f.busy = false;
  }
}

// A ride from its trip's answer, or null when the answer cannot be read or does not have the ride's stops.
function freshRide(ride: RideLeg, data: Itinerary): RideLeg | null {
  try {
    const route = tripRoute(data);
    return route ? updateRide(ride, route) : null;
  } catch {
    return null;
  }
}
