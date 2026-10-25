// Turns a Transitous route search (/plan) into journeys for the route panel and the map.
// Pure functions only (no DOM, no fetch), so everything here is unit tested on saved answers.
// Names stay as Transitous sends them; the panel shortens them (names.ts) like the board does.

import type { Mode, PlanItinerary, PlanLeg, PlanRequest, PlanResponse, TripStopPlace } from "./api";
import { planTime } from "./berlintime";
import { hexOrNull, isHiddenMode, lineName, platformLabel, tooEarly } from "./departures";
import { type LonLat, decodePolyline } from "./geo";
import { PLAN_PAST_MS } from "../worker/transitous";

export interface LegStop {
  name: string;
  stopId: string | null;
  platform: string | null; // "Gleis 2" for trains, like the board; null where unknown
  lon: number;
  lat: number;
  ms: number; // predicted
  schedMs: number;
  cancelled: boolean;
}

export interface WalkLeg {
  kind: "walk";
  from: LegStop;
  to: LegStop;
  minutes: number; // rounded up
  path: LonLat[];
}

export interface RideLeg {
  kind: "ride";
  mode: Mode;
  line: string;
  color: string | null; // "#rrggbb" or null
  textColor: string | null;
  headsign: string;
  tripId: string | null; // opens the trip card
  realTime: boolean;
  cancelled: boolean;
  staySeated: boolean; // the same vehicle goes on under another line or number: no change needed
  from: LegStop;
  to: LegStop;
  stopsBetween: number;
  path: LonLat[];
}

export type JourneyLeg = WalkLeg | RideLeg;

export interface Journey {
  key: string; // stable across refreshes (rides and planned start), for keeping focus
  depMs: number;
  schedDepMs: number;
  arrMs: number;
  schedArrMs: number;
  transfers: number;
  realTime: boolean; // at least one ride has live data
  cancelled: boolean; // a ride or one of its stops is cancelled: this journey will not work
  legs: JourneyLeg[];
}

export interface Plan {
  journeys: Journey[];
  walk: Journey | null; // walking all the way, when Transitous offers it
  earlier: string | null; // page cursors for /api/plan
  later: string | null;
}

// Walks shorter than this between two rides are a change on the spot (same platform or next to it).
const SHORT_WALK_S = 60;

const parseMs = (iso: string | undefined, fallback: string): number => Date.parse(iso ?? fallback);

function legStop(p: TripStopPlace, mode: Mode, at: "dep" | "arr", legTime: string, legSched: string): LegStop {
  const live = at === "dep" ? p.departure : p.arrival;
  const sched = at === "dep" ? p.scheduledDeparture : p.scheduledArrival;
  return {
    name: p.name,
    stopId: p.stopId ?? null,
    platform: platformLabel(p.stopId, mode),
    lon: p.lon,
    lat: p.lat,
    ms: parseMs(live, legTime),
    schedMs: parseMs(sched, legSched),
    cancelled: p.cancelled === true,
  };
}

function toLeg(leg: PlanLeg, previous: JourneyLeg | undefined): JourneyLeg {
  const from = legStop(leg.from, leg.mode, "dep", leg.startTime, leg.scheduledStartTime);
  const to = legStop(leg.to, leg.mode, "arr", leg.endTime, leg.scheduledEndTime);
  const decoded = decodePolyline(leg.legGeometry.points, leg.legGeometry.precision);
  // Walks between two rides come without a line (the Worker asks for detailedTransfers=false):
  // draw them straight from stop to stop.
  const path: LonLat[] = decoded.length >= 2 ? decoded : [[from.lon, from.lat], [to.lon, to.lat]];
  if (leg.mode === "WALK") {
    return { kind: "walk", from, to, minutes: Math.ceil(leg.duration / 60), path };
  }
  // Live times far too early are broken data (same rule as the board): use the timetable instead.
  let realTime = leg.realTime;
  if (realTime && tooEarly((from.ms - from.schedMs) / 1000, leg.mode)) {
    realTime = false;
    from.ms = from.schedMs;
    to.ms = to.schedMs;
  }
  return {
    kind: "ride",
    mode: leg.mode,
    line: lineName(leg.displayName, leg.routeShortName) ?? "?",
    color: hexOrNull(leg.routeColor),
    textColor: hexOrNull(leg.routeTextColor),
    headsign: leg.headsign ?? leg.to.name,
    tripId: leg.tripId ?? null,
    realTime,
    cancelled: leg.cancelled === true || from.cancelled || to.cancelled,
    staySeated: leg.interlineWithPreviousLeg === true && previous?.kind === "ride",
    from,
    to,
    stopsBetween: leg.intermediateStops?.length ?? 0,
    path,
  };
}

// One itinerary as a journey, or null if it uses a mode the app leaves out (IC/ICE and the like;
// the Worker already asks Transitous not to, this is the second lock) or has nothing left.
export function toJourney(it: PlanItinerary): Journey | null {
  if (it.legs.some((l) => isHiddenMode(l.mode))) return null;
  const legs: JourneyLeg[] = [];
  for (const raw of it.legs) {
    const leg = toLeg(raw, legs[legs.length - 1]);
    // A tiny walk between two rides says nothing; a walk-only journey keeps its walk.
    if (leg.kind === "walk" && raw.duration < SHORT_WALK_S && it.legs.length > 1) continue;
    legs.push(leg);
  }
  const first = legs[0];
  const last = legs[legs.length - 1];
  if (!first || !last) return null;
  const rides = legs.filter((l): l is RideLeg => l.kind === "ride");
  return {
    key: [first.from.schedMs, ...rides.map((r) => r.tripId ?? r.line)].join("|"),
    depMs: first.from.ms,
    schedDepMs: first.from.schedMs,
    arrMs: last.to.ms,
    schedArrMs: last.to.schedMs,
    transfers: it.transfers,
    realTime: rides.some((r) => r.realTime),
    cancelled: rides.some((r) => r.cancelled),
    legs,
  };
}

// The whole answer: journeys in order of leaving (then arriving), minus any that take as long as walking
// all the way or longer. The walk's own duration counts, in seconds: its clock times are whole minutes.
export function parsePlan(answer: PlanResponse): Plan {
  const direct = (answer.direct ?? []).find((it) => toJourney(it) !== null);
  const walk = direct ? toJourney(direct) : null;
  const walkMs = direct ? direct.duration * 1000 : Infinity;
  const journeys = (answer.itineraries ?? [])
    .map(toJourney)
    .filter((j): j is Journey => j !== null && j.arrMs - j.depMs < walkMs)
    .sort((a, b) => a.depMs - b.depMs || a.arrMs - b.arrMs);
  return {
    journeys,
    walk,
    earlier: answer.previousPageCursor || null,
    later: answer.nextPageCursor || null,
  };
}

// Whole journey on the map: every leg's line, in order.
export function journeyPath(j: Journey): LonLat[] {
  return j.legs.flatMap((l) => l.path);
}

// What went wrong with a search, for the message shown: `status` from the Worker (null: no answer at all).
export type PlanFailure = "offline" | "unknownStop" | "tooMany" | "unavailable";

export function planFailure(status: number | null, online: boolean): PlanFailure {
  if (status === null) return online ? "unavailable" : "offline";
  if (status === 404) return "unknownStop";
  if (status === 429) return "tooMany";
  return "unavailable";
}

// "35 min", "1 h 05 min" (same in German and English).
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

// How long a journey takes, in whole minutes, the same everywhere it is shown. Walking all the way uses the
// walk's own seconds rounded up (its clock times are whole minutes, so their difference can be one less).
export function journeyMinutes(j: Journey): number {
  const only = j.legs.length === 1 ? j.legs[0] : undefined;
  return only?.kind === "walk" ? only.minutes : Math.round((j.arrMs - j.depMs) / 60_000);
}

// The search whose answer is on screen, kept apart from the form (which may hold unsent edits).
export interface SubmittedSearch {
  request: PlanRequest;
  isNow: boolean; // searched with "Now": a refresh searches from the new now
  name: string; // "Bonn Hbf → K-Neumarkt"
}

// What Refresh sends: a "Now" search from the current minute (first page again); a search for a chosen
// time as it was, or null once that time is too far back for the Worker.
export function refreshRequest(s: SubmittedSearch, nowMs: number): PlanRequest | null {
  if (s.isNow) return { ...s.request, time: planTime(nowMs), cursor: null };
  return Date.parse(s.request.time) < nowMs - PLAN_PAST_MS ? null : s.request;
}

// The first ride of a journey (most journeys start with one; some with a walk to the stop).
export function firstRide(j: Journey): RideLeg | null {
  return j.legs.find((l): l is RideLeg => l.kind === "ride") ?? null;
}
