// Turns a Transitous route search (/plan) into journeys for the route panel and the map.
// Pure functions only (no DOM, no fetch), so everything here is unit tested on saved answers.
// Names stay as Transitous sends them; the panel shortens them (names.ts) like the board does.

import type { Alert, Mode, PlanItinerary, PlanLeg, PlanRequest, PlanResponse, Step, TripStopPlace } from "./api";
import { planTime } from "./berlintime";
import { collapsed, hexOrNull, isHiddenMode, lineName, platformLabel, plannedPlatform, unbackedShift } from "./departures";
import type { EndRef } from "./endpoints";
import { type LonLat, decodePolyline } from "./geo";
import { type RouteStop, type TripRoute, firstImplausible, leaveMs, reachMs, toStop } from "./trip";
import { PLAN_PAST_MS } from "../worker/transitous";

export interface LegStop {
  name: string;
  stopId: string | null;
  platform: string | null; // "Gleis 2" for trains, like the board; null where unknown
  plannedPlatform: string | null; // set when the train leaves from another platform than planned
  lon: number;
  lat: number;
  ms: number; // predicted
  schedMs: number;
  cancelled: boolean;
  alerts: Alert[];
}

// One line of walking directions, several of the planner's steps merged (it sends one per path piece).
export interface WalkStep {
  kind: "straight" | "left" | "right" | "uturn" | "stairs" | "elevator";
  street: string; // "" for unnamed paths
  distanceM: number;
}

export interface WalkLeg {
  kind: "walk";
  from: LegStop;
  to: LegStop;
  minutes: number; // rounded up
  seconds: number; // as the planner sent it, for the transfer maths
  steps: WalkStep[]; // empty when the planner sent none
  schematic: boolean; // no path came: drawn as a straight line, which is not a checked way
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
  // Walking time between the ride before and this one, in seconds, including walks too short to list.
  // Null for the first ride.
  transferWalkS: number | null;
  alerts: Alert[]; // notices for this ride (its own and its two stops')
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
    platform: platformLabel(p.stopId, mode, p),
    plannedPlatform: plannedPlatform(p.stopId, mode, p),
    lon: p.lon,
    lat: p.lat,
    ms: parseMs(live, legTime),
    schedMs: parseMs(sched, legSched),
    cancelled: p.cancelled === true,
    alerts: p.alerts ?? [],
  };
}

const STEP_KINDS: Record<string, WalkStep["kind"]> = {
  LEFT: "left",
  HARD_LEFT: "left",
  SLIGHTLY_LEFT: "left",
  RIGHT: "right",
  HARD_RIGHT: "right",
  SLIGHTLY_RIGHT: "right",
  UTURN_LEFT: "uturn",
  UTURN_RIGHT: "uturn",
  STAIRS: "stairs",
  ELEVATOR: "elevator",
};

// The planner's steps as a few readable lines: pieces along the same street (or an unnamed path) become one,
// and a turn takes the straight pieces after it. Stairs and lifts always get their own line.
export function compactSteps(steps: Step[]): WalkStep[] {
  const out: WalkStep[] = [];
  for (const s of steps) {
    const kind = STEP_KINDS[s.relativeDirection] ?? "straight";
    const street = (s.streetName ?? "").trim();
    const distanceM = Number.isFinite(s.distance) ? Math.max(0, s.distance) : 0;
    const last = out[out.length - 1];
    const joinable = last && last.kind !== "stairs" && last.kind !== "elevator";
    if (kind === "straight" && joinable && (street === "" || last.street === "" || street === last.street)) {
      last.distanceM += distanceM;
      if (!last.street) last.street = street;
      continue;
    }
    out.push({ kind, street, distanceM });
  }
  return out;
}

// What to make of a ride's times: keep them, use the timetable instead (`timetable`), or drop the whole
// connection (`drop`: moved far from the timetable without live data, see unbackedShift).
type RideCheck = "keep" | "timetable" | "drop";

// Live times are checked with the trip card's rules (trip.ts firstImplausible: backwards, bunched, too early,
// collapsed) on the ride's own stops, and the whole ride must not take less than half its timetable time.
// A followed connection's refresh (updateRide) applies the same, so a refresh cannot undo this.
function checkRide(leg: PlanLeg, from: LegStop, to: LegStop): RideCheck {
  const fromSec = (from.ms - from.schedMs) / 1000;
  const toSec = (to.ms - to.schedMs) / 1000;
  if (unbackedShift(fromSec, leg.realTime) || unbackedShift(toSec, leg.realTime)) return "drop";
  if (!leg.realTime) return fromSec !== 0 || toSec !== 0 ? "timetable" : "keep";
  if (collapsed(from.ms, to.ms, from.schedMs, to.schedMs)) return "timetable";
  const stops = [leg.from, ...(leg.intermediateStops ?? []), leg.to].map((p) => toStop(p));
  // The ride's ends count only as boarding and alighting (the search leaves out the other time).
  stops[0]!.arrMs = stops[0]!.schedArrMs = null;
  stops[stops.length - 1]!.depMs = stops[stops.length - 1]!.schedDepMs = null;
  return firstImplausible(stops, leg.mode) === null ? "keep" : "timetable";
}

// A leg for the panel, and whether a ride's times were swapped for the timetable; null when the connection
// cannot be offered at all.
function toLeg(leg: PlanLeg, previous: JourneyLeg | undefined): { leg: JourneyLeg; corrected: boolean } | null {
  const from = legStop(leg.from, leg.mode, "dep", leg.startTime, leg.scheduledStartTime);
  const to = legStop(leg.to, leg.mode, "arr", leg.endTime, leg.scheduledEndTime);
  const decoded = decodePolyline(leg.legGeometry.points, leg.legGeometry.precision);
  // A walk without a path (short changes on the spot, or an answer without detailed transfers): drawn
  // straight from stop to stop, and marked as such.
  const schematic = decoded.length < 2;
  const path: LonLat[] = schematic ? [[from.lon, from.lat], [to.lon, to.lat]] : decoded;
  if (leg.mode === "WALK") {
    const walk: WalkLeg = {
      kind: "walk",
      from,
      to,
      minutes: Math.ceil(leg.duration / 60),
      seconds: leg.duration,
      steps: compactSteps(leg.steps ?? []),
      schematic,
      path,
    };
    return { leg: walk, corrected: false };
  }
  // Times that cannot be right (far too early, a ride that takes no time, moved without live data) are
  // replaced by the timetable, the same rules as the board and the trip card.
  const check = checkRide(leg, from, to);
  if (check === "drop") return null;
  let realTime = leg.realTime;
  if (check === "timetable") {
    realTime = false;
    from.ms = from.schedMs;
    to.ms = to.schedMs;
  }
  const ride: RideLeg = {
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
    transferWalkS: null, // filled in by toJourney, which sees the walks around it
    alerts: [...(leg.alerts ?? []), ...from.alerts, ...to.alerts],
  };
  return { leg: ride, corrected: check === "timetable" };
}

const isRide = (leg: PlanLeg | undefined): boolean => leg !== undefined && leg.mode !== "WALK";

// After a ride was moved to its (later) timetable times, the walks behind it move along with it, each taking
// at least its own walking time (its clock times are whole minutes and can be shorter: 119 s shown as 1 min).
// A ride that then leaves before the leg in front of it has ended cannot be caught: false, the journey no
// longer works. The other rides keep their own times; only Transitous knows those.
// A moved walk's planned times follow the planned end of the leg in front of it, so a journey on the
// timetable shows no crossed-out time.
// `legs` includes the short walks the panel leaves out: they take time too.
function retime(legs: JourneyLeg[]): boolean {
  for (let i = 1; i < legs.length; i++) {
    const leg = legs[i]!;
    const endMs = legs[i - 1]!.to.ms;
    if (leg.from.ms >= endMs) continue;
    if (leg.kind === "ride") return false;
    const spanMs = Math.max(leg.to.ms - leg.from.ms, leg.minutes * 60_000);
    leg.from.schedMs = legs[i - 1]!.to.schedMs;
    leg.to.schedMs = leg.from.schedMs + spanMs;
    leg.from.ms = endMs;
    leg.to.ms = endMs + spanMs;
  }
  return true;
}

// One itinerary as a journey, or null if it uses a mode the app leaves out (IC/ICE and the like;
// the Worker already asks Transitous not to, this is the second lock) or has nothing left.
export function toJourney(it: PlanItinerary): Journey | null {
  if (it.legs.some((l) => isHiddenMode(l.mode))) return null;
  const legs: JourneyLeg[] = [];
  const all: JourneyLeg[] = []; // `legs` plus the tiny walks left out, for retime
  let corrected = false; // a ride's times were swapped for the timetable (toLeg)
  let dropped = false; // a ride cannot be offered at all (toLeg)
  let walkS: number | null = null; // walking since the last ride; null before the first ride
  it.legs.forEach((raw, i) => {
    if (dropped) return;
    const made = toLeg(raw, legs[legs.length - 1]);
    if (!made) {
      dropped = true;
      return;
    }
    const leg = made.leg;
    if (made.corrected) corrected = true;
    if (leg.kind === "walk") {
      if (walkS !== null) walkS += leg.seconds;
    } else {
      leg.transferWalkS = walkS;
      walkS = 0;
    }
    all.push(leg);
    // A tiny walk between two rides says nothing. A walk at the start or end stays, however short: it
    // leads to or from the stops that were asked for (and a walk-only journey keeps its walk).
    const betweenRides = isRide(it.legs[i - 1]) && isRide(it.legs[i + 1]);
    if (leg.kind === "walk" && raw.duration < SHORT_WALK_S && betweenRides) return;
    legs.push(leg);
  });
  if (dropped || (corrected && !retime(all))) return null;
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
// `keepSlow`: keep those too (someone who limited walking may not be able to walk all the way).
export function parsePlan(answer: PlanResponse, keepSlow = false): Plan {
  const direct = (answer.direct ?? []).find((it) => toJourney(it) !== null);
  const walk = direct ? toJourney(direct) : null;
  const walkMs = direct && !keepSlow ? direct.duration * 1000 : Infinity;
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

// "My location" as a route search end: "lat,lon", the form Transitous and the Worker take. Six decimals are
// about 10 cm, finer than any phone's fix, so this sends the position as the phone found it.
export function positionPlace(lat: number, lon: number): string {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

// A journey end at a position (My location, an address, a point on the map) rather than a stop. Transitous
// names it "START" or "END" and gives it no stop ID; the panel and the map show the searched end's name.
export const isPosition = (s: LegStop): boolean => s.stopId === null;

// The search whose answer is on screen, kept apart from the form (which may hold unsent edits).
export interface SubmittedSearch {
  request: PlanRequest;
  isNow: boolean; // searched with "Now": a refresh searches from the new now
  from: string | null; // names as shown ("Bonn Hbf", "K-Neumarkt", "Adenauerallee 160"); null: My location,
  to: string | null; // named in the language shown at the time
  ends: { from: EndRef; to: EndRef }; // what was searched, for links, saved routes and "find alternatives"
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

// A change between two rides: how much time is left once the walk is done. Rounded clock times and predicted
// delays make this an estimate, so a tight change is a warning, not a verdict.
export interface Transfer {
  ride: RideLeg; // the ride to catch
  arriveMs: number; // the ride before arrives
  departMs: number; // this one leaves
  walkS: number;
  slackS: number; // time to spare after walking; clearly below 0 it will not work as shown
  level: "ok" | "tight" | "missed";
}

// Less spare time than this on a change counts as tight.
export const TIGHT_TRANSFER_S = 120;
// Clock times are whole minutes and walks are seconds, so a change that works can come out a little below
// zero; only clearly less than that counts as missed.
export const MISSED_TRANSFER_S = -60;

export function transfersOf(j: Journey): Transfer[] {
  const out: Transfer[] = [];
  let prev: RideLeg | null = null;
  for (const leg of j.legs) {
    if (leg.kind !== "ride") continue;
    if (prev && !leg.staySeated) {
      const walkS = leg.transferWalkS ?? 0;
      const slackS = (leg.from.ms - prev.to.ms) / 1000 - walkS;
      const level = slackS < MISSED_TRANSFER_S ? "missed" : slackS < TIGHT_TRANSFER_S ? "tight" : "ok";
      out.push({ ride: leg, arriveMs: prev.to.ms, departMs: leg.from.ms, walkS, slackS, level });
    }
    prev = leg;
  }
  return out;
}

// The state of a whole journey, from all its rides (not just the first): what the connection list shows.
// - cancelled: a ride is cancelled; missed: a change no longer works with the predicted times
// - live: every ride has live data; partial: some do; timetable: none do
// `delaySec`: the largest delay of a ride with live data (leaving, or arriving at the end); `tight`: a change
// has less than TIGHT_TRANSFER_S to spare.
export interface JourneyState {
  kind: "cancelled" | "missed" | "live" | "partial" | "timetable";
  delaySec: number;
  tight: boolean;
}

export function journeyState(j: Journey): JourneyState {
  const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride");
  const changes = transfersOf(j);
  const tight = changes.some((c) => c.level === "tight");
  if (j.cancelled || rides.some((r) => r.cancelled)) return { kind: "cancelled", delaySec: 0, tight };
  const live = rides.filter((r) => r.realTime);
  let delaySec = 0;
  for (const r of live) {
    delaySec = Math.max(delaySec, (r.from.ms - r.from.schedMs) / 1000);
  }
  const last = rides[rides.length - 1];
  if (last?.realTime) delaySec = Math.max(delaySec, (last.to.ms - last.to.schedMs) / 1000);
  if (changes.some((c) => c.level === "missed")) return { kind: "missed", delaySec, tight };
  if (rides.length === 0 || live.length === 0) return { kind: "timetable", delaySec: 0, tight };
  return { kind: live.length === rides.length ? "live" : "partial", delaySec, tight };
}

// Left already: its first leg (a walk to the stop included) started before `nowMs`. Grace as on the board.
export function departed(j: Journey, nowMs: number): boolean {
  return j.depMs < nowMs - 30_000;
}

// One ride with fresh times from its trip (/api/trip), or null when its stops cannot be found on the trip.
// The stops are matched by ID, else by name; the destination stop must come after the boarding stop.
// Platforms and notices come from the trip too: the trip's own notices and those of the two stops used (not
// every stop along the way). The ride's line on the map stays as searched (a trip has no piece for one ride).
export function updateRide(leg: RideLeg, route: TripRoute): RideLeg | null {
  const find = (s: LegStop, from: number) => {
    const byId = s.stopId ? route.stops.findIndex((r, i) => i >= from && r.stopId === s.stopId) : -1;
    return byId >= 0 ? byId : route.stops.findIndex((r, i) => i >= from && r.name === s.name);
  };
  const a = find(leg.from, 0);
  const b = a >= 0 ? find(leg.to, a + 1) : -1;
  if (a < 0 || b < 0) return null;
  const board = route.stops[a]!;
  const alight = route.stops[b]!;
  let depMs = leaveMs(board);
  let arrMs = reachMs(alight);
  if (depMs === null || arrMs === null) return null;
  const schedDep = board.schedDepMs ?? board.schedArrMs ?? leg.from.schedMs;
  const schedArr = alight.schedArrMs ?? alight.schedDepMs ?? leg.to.schedMs;
  // The same rules as the search (checkRide): live only where this section of the trip has live data and its
  // times look right. Times thrown out within the ride give the ride's timetable, as in the search; thrown out
  // before boarding, the trip's corrected times (a late vehicle cannot catch up with its timetable).
  const sectionLive = route.realTime && board.depLive !== false && alight.arrLive !== false;
  const wrongBefore = route.implausibleFrom !== null && route.implausibleFrom <= a;
  const wrongWithin =
    (route.implausibleFrom !== null && route.implausibleFrom <= b) || collapsed(depMs, arrMs, schedDep, schedArr);
  const realTime = sectionLive && !wrongWithin;
  if (!realTime && !wrongBefore) {
    depMs = schedDep;
    arrMs = schedArr;
  }
  const from: LegStop = { ...freshStop(leg.from, board, leg.mode), ms: depMs, schedMs: schedDep };
  const to: LegStop = { ...freshStop(leg.to, alight, leg.mode), ms: arrMs, schedMs: schedArr };
  return {
    ...leg,
    realTime,
    cancelled: route.cancelled || board.cancelled || alight.cancelled,
    from,
    to,
    alerts: [...route.alerts, ...from.alerts, ...to.alerts],
  };
}

// A ride's stop with what its trip says now: the stop (a changed platform can be another stop ID), the
// platform and its notices. A platform the trip cannot name stays as it was when the stop is the same one.
function freshStop(old: LegStop, s: RouteStop, mode: Mode): LegStop {
  const stopId = s.stopId ?? old.stopId;
  const platform = platformLabel(stopId, mode, s);
  const same = stopId === old.stopId;
  return {
    ...old,
    stopId,
    platform: platform ?? (same ? old.platform : null),
    plannedPlatform: platform ? plannedPlatform(stopId, mode, s) : same ? old.plannedPlatform : null,
    cancelled: s.cancelled,
    alerts: s.alerts ?? [],
  };
}

// The journey again with some rides replaced (fresh times). Walks move with the rides around them: a walk
// to the first ride ends when it leaves, a walk after a ride starts when it arrives; each keeps its length.
// Whether the changes still work is not decided here (transfersOf / journeyState say so).
export function withRides(j: Journey, rides: Map<RideLeg, RideLeg>): Journey {
  const legs: JourneyLeg[] = j.legs.map((l) => (l.kind === "ride" ? (rides.get(l) ?? l) : { ...l, from: { ...l.from }, to: { ...l.to } }));
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    if (leg.kind !== "walk") continue;
    const spanMs = Math.max(leg.to.ms - leg.from.ms, leg.minutes * 60_000);
    const before = legs[i - 1];
    const after = legs[i + 1];
    if (before) {
      leg.from.ms = before.to.ms;
      leg.to.ms = before.to.ms + spanMs;
    } else if (after) {
      leg.to.ms = after.from.ms;
      leg.from.ms = after.from.ms - spanMs;
    }
  }
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const all = legs.filter((l): l is RideLeg => l.kind === "ride");
  return {
    ...j,
    depMs: first.from.ms,
    arrMs: last.to.ms,
    realTime: all.some((r) => r.realTime),
    cancelled: all.some((r) => r.cancelled),
    legs,
  };
}

// What a refresh changed, ride by ride: newly cancelled; live times lost (then no delay is claimed: no live
// data is not "on time"); a delay leaving or arriving (whole minutes) that moved; a platform that changed.
export interface RideChange {
  line: string;
  kind: "cancelled" | "noLive" | "delay" | "arrival" | "platform" | "arrPlatform";
  beforeMin: number;
  afterMin: number;
  platform: string | null; // the new platform, for "platform" and "arrPlatform"
}

export function rideChanges(before: Journey, after: Journey): RideChange[] {
  const a = before.legs.filter((l): l is RideLeg => l.kind === "ride");
  const b = after.legs.filter((l): l is RideLeg => l.kind === "ride");
  const out: RideChange[] = [];
  const minutes = (s: LegStop) => Math.round((s.ms - s.schedMs) / 60_000);
  a.forEach((old, i) => {
    const now = b[i];
    if (!now) return;
    const change = (kind: RideChange["kind"], beforeMin = 0, afterMin = 0, platform: string | null = null) =>
      out.push({ line: now.line, kind, beforeMin, afterMin, platform });
    if (now.cancelled) {
      if (!old.cancelled) change("cancelled");
      return;
    }
    if (old.realTime && !now.realTime) change("noLive");
    else if (now.realTime) {
      if (minutes(now.from) !== minutes(old.from)) change("delay", minutes(old.from), minutes(now.from));
      else if (minutes(now.to) !== minutes(old.to)) change("arrival", minutes(old.to), minutes(now.to));
    }
    if (now.from.platform && now.from.platform !== old.from.platform) change("platform", 0, 0, now.from.platform);
    if (now.to.platform && now.to.platform !== old.to.platform) change("arrPlatform", 0, 0, now.to.platform);
  });
  return out;
}
