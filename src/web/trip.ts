// Turns a Transitous trip (/trip) into a route for the map and a stop list for the info card,
// and works out where along its stops the vehicle is right now.
// Pure functions only (no DOM, no fetch), so everything here is unit tested.

import type { Itinerary, Mode, TripStopPlace } from "./api";
import { hexOrNull, lineName, tooEarly } from "./departures";
import { type LonLat, decodePolyline } from "./geo";

export interface RouteStop {
  stopId: string | null;
  name: string;
  lon: number;
  lat: number;
  track: string | null;
  arrMs: number | null; // predicted (includes delay); null at the first stop
  depMs: number | null; // predicted; null at the last stop
  schedArrMs: number | null;
  schedDepMs: number | null;
  cancelled: boolean;
}

export interface TripRoute {
  line: string;
  headsign: string;
  mode: Mode;
  color: string | null; // "#rrggbb" or null
  textColor: string | null;
  realTime: boolean;
  cancelled: boolean;
  path: LonLat[]; // the whole track line, first to last stop
  stops: RouteStop[];
  // First stop whose live times looked wrong (Phase 4.8); from there on, the stop times are the timetable.
  implausibleFrom: number | null;
}

export type TripState = "before" | "moving" | "atStop" | "ended";

export interface TripProgress {
  state: TripState;
  next: number | null; // index of the next (or current) stop; null once the trip has ended
  delaySec: number; // at that stop, positive = late
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : null);

function toStop(p: TripStopPlace): RouteStop {
  return {
    stopId: p.stopId ?? null,
    name: p.name,
    lon: p.lon,
    lat: p.lat,
    track: p.track ?? null,
    arrMs: ms(p.arrival),
    depMs: ms(p.departure),
    schedArrMs: ms(p.scheduledArrival),
    schedDepMs: ms(p.scheduledDeparture),
    cancelled: p.cancelled === true,
  };
}

// Join all legs into one route. Where one leg ends and the next starts at the same stop,
// that stop appears once (arrival from the first leg, departure from the second).
export function tripRoute(itinerary: Itinerary): TripRoute | null {
  const first = itinerary.legs[0];
  if (!first) return null;

  const stops: RouteStop[] = [];
  const path: LonLat[] = [];
  for (const leg of itinerary.legs) {
    const legStops = [leg.from, ...(leg.intermediateStops ?? []), leg.to].map(toStop);
    const prev = stops[stops.length - 1];
    const start = legStops[0]!;
    if (prev && prev.name === start.name && prev.depMs === null) {
      prev.depMs = start.depMs;
      prev.schedDepMs = start.schedDepMs;
      legStops.shift();
    }
    stops.push(...legStops);
    path.push(...decodePolyline(leg.legGeometry.points, leg.legGeometry.precision));
  }

  const last = itinerary.legs[itinerary.legs.length - 1]!;
  const realTime = itinerary.legs.some((l) => l.realTime);
  const implausibleFrom = realTime ? firstImplausible(stops, first.mode) : null;
  if (implausibleFrom !== null) useTimetableFrom(stops, implausibleFrom);
  return {
    line: lineName(first.displayName, first.routeShortName) ?? "?",
    headsign: last.headsign ?? last.to.name,
    mode: first.mode,
    color: hexOrNull(first.routeColor),
    textColor: hexOrNull(first.routeTextColor),
    realTime,
    cancelled: itinerary.legs.every((l) => l.cancelled === true),
    path,
    stops,
    implausibleFrom,
  };
}

const BACKWARDS_MS = 60_000; // times have minute resolution, so allow one minute of noise
const BUNCH_STOPS = 3;
const BUNCH_SPREAD_MS = 3 * 60_000;

const minuteOf = (t: number) => Math.floor(t / 60_000);
const schedLeaveMs = (s: RouteStop) => s.schedDepMs ?? s.schedArrMs;

// The first stop whose live times cannot be right, or null when they all look fine (Phase 4.8):
// 1. backwards: earlier than a stop before it; 2. bunched: 3+ stops in a row at the same minute while
// the timetable spreads them over more than 3 min; 3. too early: trams and buses only.
// Cancelled stops are skipped (their times mean nothing).
export function firstImplausible(stops: RouteStop[], mode: Mode): number | null {
  let bad = Infinity;
  let latest = -Infinity; // latest predicted time seen so far
  let runStart = -1; // index of the first stop in the current same-minute run
  let prev = -1; // index of the previous stop that was looked at

  stops.forEach((s, i) => {
    if (s.cancelled) return;

    for (const t of [s.arrMs, s.depMs]) {
      if (t === null) continue;
      if (t < latest - BACKWARDS_MS) bad = Math.min(bad, i);
      latest = Math.max(latest, t);
    }

    const leave = leaveMs(s);
    const sched = schedLeaveMs(s);
    if (leave !== null && sched !== null && tooEarly((leave - sched) / 1000, mode)) bad = Math.min(bad, i);

    if (leave === null) {
      runStart = -1;
    } else {
      const prevLeave = prev >= 0 ? leaveMs(stops[prev]!) : null;
      if (runStart < 0 || prevLeave === null || minuteOf(prevLeave) !== minuteOf(leave)) runStart = i;
      const inRun = stops.slice(runStart, i + 1).filter((r) => !r.cancelled).length;
      const startSched = schedLeaveMs(stops[runStart]!);
      if (inRun >= BUNCH_STOPS && sched !== null && startSched !== null && sched - startSched > BUNCH_SPREAD_MS) {
        bad = Math.min(bad, runStart);
      }
    }
    prev = i;
  });

  return Number.isFinite(bad) ? bad : null;
}

// From stop `from` on, show the timetable instead of the broken live times. Never earlier than the
// stop before (a late vehicle cannot jump back to its timetable time), so the dot does not run backwards.
function useTimetableFrom(stops: RouteStop[], from: number): void {
  let floor = -Infinity;
  for (let i = from - 1; i >= 0; i--) {
    const t = stops[i]!.cancelled ? null : leaveMs(stops[i]!);
    if (t !== null) {
      floor = t;
      break;
    }
  }
  for (let i = from; i < stops.length; i++) {
    const s = stops[i]!;
    if (s.schedArrMs !== null) s.arrMs = Math.max(s.schedArrMs, floor);
    if (s.schedDepMs !== null) s.depMs = Math.max(s.schedDepMs, s.arrMs ?? floor, floor);
    const t = leaveMs(s);
    if (!s.cancelled && t !== null) floor = t;
  }
}

// When the vehicle leaves / reaches a stop (the first stop has no arrival, the last no departure).
export const leaveMs = (s: RouteStop) => s.depMs ?? s.arrMs;
export const reachMs = (s: RouteStop) => s.arrMs ?? s.depMs;

// Where along its stops the trip is at `nowMs`. Cancelled stops are skipped.
export function progressAt(stops: RouteStop[], nowMs: number): TripProgress {
  const next = stops.findIndex((s) => !s.cancelled && (leaveMs(s) ?? -Infinity) > nowMs);
  if (next === -1) return { state: "ended", next: null, delaySec: 0 };

  const stop = stops[next]!;
  const reach = reachMs(stop) ?? nowMs;
  const state: TripState = next === 0 && stop.arrMs === null ? "before" : reach <= nowMs ? "atStop" : "moving";

  // Delay when leaving that stop (what a passenger waiting there cares about, and what the stop list
  // shows); at the last stop, when arriving.
  const delayMs =
    stop.depMs !== null && stop.schedDepMs !== null
      ? stop.depMs - stop.schedDepMs
      : stop.arrMs !== null && stop.schedArrMs !== null
        ? stop.arrMs - stop.schedArrMs
        : 0;
  return { state, next, delaySec: delayMs / 1000 };
}
