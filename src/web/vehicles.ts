// Where the vehicle of one trip is at a given moment, worked out from that trip's stops and track line.
// Pure functions only (no DOM, no fetch), so everything here is unit tested.
// The idea in short: see "How it works" in README.md.

import type { Mode } from "./api";
import { type LonLat, cumulativeDistances, distanceM, pointAlong } from "./geo";
import { type TripRoute, leaveMs, reachMs } from "./trip";

// Show a vehicle waiting at its first stop only if it leaves within this time.
export const WAIT_SHOW_MS = 60_000;

// When matching stops to the track line, a point this close counts as "at the stop".
const ON_TRACK_M = 50;

export interface PreparedSegment {
  depMs: number;
  arrMs: number;
  schedDepMs: number;
  schedArrMs: number;
  realTime: boolean;
  fromName: string;
  toName: string;
  points: LonLat[];
  cum: number[];
}

export interface PreparedTrip {
  tripId: string;
  line: string;
  mode: Mode;
  color: string | null; // "#rrggbb" or null
  segments: PreparedSegment[]; // sorted by departure
}

export type VehicleState = "moving" | "dwelling" | "waiting";

export interface VehiclePosition {
  tripId: string;
  line: string;
  mode: Mode;
  color: string | null;
  lon: number;
  lat: number;
  bearing: number;
  delaySec: number; // positive = late
  realTime: boolean;
  state: VehicleState;
  nextStop: string;
}

// Where each stop sits on the track line (index of its nearest point), never going backwards.
// Scans forward to the first close approach and stops there, so a route that passes the same place
// twice (a loop) does not jump ahead. A stop never close to the line takes its nearest point.
export function stopIndexes(path: LonLat[], stops: LonLat[]): number[] {
  const out: number[] = [];
  let from = 0;
  for (const stop of stops) {
    let best = from;
    let bestM = Infinity;
    for (let i = from; i < path.length; i++) {
      const d = distanceM(path[i]!, stop);
      if (d < bestM) {
        best = i;
        bestM = d;
      } else if (bestM <= ON_TRACK_M) {
        break; // moving away again after reaching the stop
      }
    }
    out.push(best);
    from = best;
  }
  return out;
}

// Cut the trip's track line into stop-to-stop segments (once per fetch, not once per frame).
// Cancelled stops are skipped: the vehicle drives past them.
export function prepareRoute(tripId: string, route: TripRoute): PreparedTrip {
  const stops = route.stops.filter((s) => !s.cancelled);
  // Stops whose live times looked wrong now carry timetable times: drawn like "timetable only".
  const timetable = new Set(route.implausibleFrom === null ? [] : route.stops.slice(route.implausibleFrom));
  const at = stopIndexes(
    route.path,
    stops.map((s) => [s.lon, s.lat]),
  );

  const segments: PreparedSegment[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const depMs = leaveMs(a);
    const arrMs = reachMs(b);
    if (depMs === null || arrMs === null) continue;

    // Fall back to a straight line between the stops if the track line is missing there.
    let points = route.path.slice(at[i]!, at[i + 1]! + 1);
    if (points.length < 2) {
      points = [
        [a.lon, a.lat],
        [b.lon, b.lat],
      ];
    }
    segments.push({
      depMs,
      arrMs,
      schedDepMs: a.schedDepMs ?? a.schedArrMs ?? depMs,
      schedArrMs: b.schedArrMs ?? b.schedDepMs ?? arrMs,
      realTime: route.realTime && !timetable.has(b),
      fromName: a.name,
      toName: b.name,
      points,
      cum: cumulativeDistances(points),
    });
  }

  return { tripId, line: route.line, mode: route.mode, color: route.color, segments };
}

// Where is this trip's vehicle at `nowMs`? Null means "not on the map right now".
export function vehicleAt(trip: PreparedTrip, nowMs: number): VehiclePosition | null {
  const segs = trip.segments;
  const first = segs[0];
  if (!first) return null;

  const base = { tripId: trip.tripId, line: trip.line, mode: trip.mode, color: trip.color };

  // Before the first known segment: waiting at its start stop, if leaving soon.
  if (nowMs < first.depMs) {
    if (first.depMs - nowMs > WAIT_SHOW_MS) return null;
    return {
      ...base,
      ...atStart(first),
      delaySec: (first.depMs - first.schedDepMs) / 1000,
      realTime: first.realTime,
      state: "waiting",
      nextStop: first.toName,
    };
  }

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;

    // Moving along this segment.
    if (seg.depMs <= nowMs && nowMs < seg.arrMs) {
      const fraction = (nowMs - seg.depMs) / (seg.arrMs - seg.depMs);
      const total = seg.cum[seg.cum.length - 1]!;
      const { at, bearing } = pointAlong(seg.points, seg.cum, fraction * total);
      return {
        ...base,
        lon: at[0],
        lat: at[1],
        bearing,
        delaySec: (seg.arrMs - seg.schedArrMs) / 1000,
        realTime: seg.realTime,
        state: "moving",
        nextStop: seg.toName,
      };
    }

    // Standing at the stop between this segment and the next one.
    const next = segs[i + 1];
    if (next && seg.arrMs <= nowMs && nowMs < next.depMs) {
      return {
        ...base,
        ...atStart(next),
        delaySec: (next.depMs - next.schedDepMs) / 1000,
        realTime: next.realTime,
        state: "dwelling",
        nextStop: next.toName,
      };
    }
  }

  // After the last known arrival: the trip has ended. Hide it.
  return null;
}

function atStart(seg: PreparedSegment): { lon: number; lat: number; bearing: number } {
  const { at, bearing } = pointAlong(seg.points, seg.cum, 0);
  return { lon: at[0], lat: at[1], bearing };
}
