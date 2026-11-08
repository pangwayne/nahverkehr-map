// The live map's vehicles: map/trips answers (one per tile) turned into trips, positions, delay colors and a
// summary of what is on screen. Pure functions only (no DOM, no fetch).
// Positions are estimates: each vehicle is moved along its stretch of track by the time that has passed
// (same idea as the trip card, vehicles.ts). Never GPS.

import type { Mode } from "./api";
import { type DelayClass, delayClass } from "./delayband";
import { tooEarly, unbackedShift } from "./departures";
import { type Box } from "./tiles";
import { type LonLat, cumulativeDistances, decodePolyline } from "./geo";
import { type PreparedSegment, type PreparedTrip, type VehiclePosition, vehicleAt } from "./vehicles";

// One piece of a trip between two stops, as map/trips sends it (the fields we use).
export interface MapSegment {
  trips: { tripId: string; displayName?: string }[];
  mode: Mode;
  routeColor?: string;
  from: { name: string; stopId?: string; lat: number; lon: number };
  to: { name: string; stopId?: string; lat: number; lon: number };
  departure: string;
  arrival: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  realTime: boolean;
  polyline: string; // precision 5
}

// Local traffic only, the same as the boards and the route search: no IC/ICE, coaches, planes, on-demand
// shuttles, ferries or funiculars.
export const LIVE_MODES = new Set<Mode>(["TRAM", "SUBWAY", "BUS", "SUBURBAN", "REGIONAL_RAIL", "REGIONAL_FAST_RAIL"]);

// Regional trains (RB, RE) are drawn on the map but never counted: a late train passing through would move a
// whole city's numbers (decision 2026-10-31). Everything else in LIVE_MODES is counted, the S-Bahn included.
export const isRegionalTrain = (mode: Mode): boolean => mode === "REGIONAL_RAIL" || mode === "REGIONAL_FAST_RAIL";

// Rail replacement buses carry the train's line name: RB27, RE8, RE8X, RE47X, S1, S6 (seen 2026-10-31). They
// count as trains, not buses (decision 2026-10-31): drawn pale, not in the numbers. SB60 and the like are
// ordinary express buses ("Schnellbus") and stay counted.
const REPLACEMENT_NAME = /^(?:RB|RE) ?\d+X?$|^S ?\d+$/;
export const isReplacementBus = (mode: Mode, line: string): boolean => mode === "BUS" && REPLACEMENT_NAME.test(line);

// Whether a vehicle goes into the numbers: not a regional train, not a rail replacement bus.
export const isCounted = (v: { mode: Mode; line: string }): boolean => !isRegionalTrain(v.mode) && !isReplacementBus(v.mode, v.line);

// What the filter chips group together (counted vehicles only): Bahn = tram, Stadtbahn, U-Bahn.
export type ModeGroup = "tram" | "bus" | "sbahn";
export function modeGroup(mode: Mode): ModeGroup {
  if (mode === "BUS") return "bus";
  if (mode === "SUBURBAN") return "sbahn";
  return "tram";
}

// Delay classes and colors: delayband.ts, the same for the whole app.
export { DELAY_COLORS, type DelayClass, delayClass, roundedClass, wholeMinutes } from "./delayband";

// A counted vehicle this late is more often a stuck prediction than a real delay: it stays on the map (red),
// but is left out of every number, so one stuck report cannot move a city's figures (decision 2026-11-02).
export const UNUSUAL_DELAY_SEC = 60 * 60;
export const isUnusual = (v: { delaySec: number; realTime: boolean }): boolean => v.realTime && v.delaySec >= UNUSUAL_DELAY_SEC;

// From this many 60+ min reports, the line under the headline says how many were left out (user decision
// 2026-11-04). The note under the list says it from the first one.
export const LEFT_OUT_LINE_MIN = 10;
export const showsLeftOut = (unusual: number): boolean => unusual >= LEFT_OUT_LINE_MIN;

// Fewer live vehicles than this: no share and no median, only counts (one vehicle would swing it too much).
export const MIN_LIVE_FOR_SHARE = 10;

// The middle value (early counts as 0); null for none.
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.map((v) => Math.max(0, v)).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Trains come as "RE7 (17428)": the train number goes, so all RE7 trains count as one line.
export const lineOf = (displayName: string | undefined): string => (displayName ?? "").replace(/\s*\(\d+\)$/, "").trim();

const toMs = (iso: string): number | null => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

// Each tile's answer covers 5 minutes from when the Worker fetched it (src/worker/transitous.ts); after that,
// it says nothing about now.
export const ANSWER_LIFE_MS = 5 * 60_000;

// A tile's answer, as the live map keeps it.
export interface TileAnswer {
  key: string; // "x,y"
  segments: MapSegment[];
  fetchedAtMs: number; // when the Worker got it from Transitous
}

// Newest answer first (same age: by tile, so the order never depends on which tile came back first).
// buildFleet keeps the first copy of a stretch, so the newest prediction wins.
export function newestFirst<T extends { key: string; fetchedAtMs: number }>(answers: T[]): T[] {
  return [...answers].sort((a, b) => b.fetchedAtMs - a.fetchedAtMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// A generous box around the region (NRW and its neighbours): a local stop outside it is a broken coordinate
// (0/0, swapped lat/lon). Only checked for the modes we show: the answers also carry planes and coaches from
// far away (a real tile: Cagliari to Düsseldorf), which are left out by mode, not broken.
const REGION = { south: 49, north: 53, west: 5, east: 10 };
const inRegion = (p: { lat: number; lon: number }): boolean =>
  p.lat >= REGION.south && p.lat <= REGION.north && p.lon >= REGION.west && p.lon <= REGION.east;
const optString = (v: unknown): boolean => v === undefined || typeof v === "string";
const isTime = (v: unknown): boolean => typeof v === "string" && Number.isFinite(Date.parse(v));

const isPlace = (p: unknown): boolean => {
  const o = p as { name?: unknown; stopId?: unknown; lat?: unknown; lon?: unknown } | null;
  return (
    !!o &&
    typeof o === "object" &&
    typeof o.name === "string" &&
    optString(o.stopId) &&
    Number.isFinite(o.lat) &&
    Number.isFinite(o.lon)
  );
};

// Everything buildFleet relies on is there, of the right kind and makes sense (an answer comes from
// outside): a line name that is text, a live flag that is a real true / false, times that
// are dates with the arrival not before the departure, and for the modes we show, stops inside the region.
export function isSegment(s: unknown): s is MapSegment {
  const o = s as Partial<MapSegment> | null;
  return (
    !!o &&
    typeof o === "object" &&
    Array.isArray(o.trips) &&
    typeof o.trips[0]?.tripId === "string" &&
    optString(o.trips[0]?.displayName) &&
    typeof o.mode === "string" &&
    typeof o.realTime === "boolean" &&
    isPlace(o.from) &&
    isPlace(o.to) &&
    (!LIVE_MODES.has(o.mode as Mode) || (inRegion(o.from!) && inRegion(o.to!))) &&
    isTime(o.departure) &&
    isTime(o.arrival) &&
    isTime(o.scheduledDeparture) &&
    isTime(o.scheduledArrival) &&
    Date.parse(o.arrival!) >= Date.parse(o.departure!) &&
    typeof o.polyline === "string"
  );
}

// An answer's usable entries and how many broken ones were left out. Null when it is not a list, or when it
// has entries but none usable: counted as a failed try, never as "no vehicles".
export function validSegments(data: unknown): { segments: MapSegment[]; dropped: number } | null {
  if (!Array.isArray(data)) return null;
  const segments = data.filter(isSegment);
  if (data.length > 0 && segments.length === 0) return null;
  return { segments, dropped: data.length - segments.length };
}

// All tiles' answers into trips: segments grouped by trip, once each (a stretch crossing a tile border comes
// in both tiles), in time order. Non-local modes and broken entries (isSegment) are dropped. The first copy of a stretch
// wins: pass the answers through `newestFirst`.
export function buildFleet(answers: MapSegment[][]): PreparedTrip[] {
  const trips = new Map<string, { trip: PreparedTrip; seen: Set<string> }>();
  for (const answer of answers) {
    for (const s of answer) {
      if (!isSegment(s) || !LIVE_MODES.has(s.mode)) continue;
      const ref = s.trips[0]!;
      const depMs = toMs(s.departure);
      const arrMs = toMs(s.arrival);
      const schedDepMs = toMs(s.scheduledDeparture);
      const schedArrMs = toMs(s.scheduledArrival);
      if (depMs === null || arrMs === null || schedDepMs === null || schedArrMs === null || arrMs < depMs) continue;

      // Same rules as the boards: a time moved by more than 15 min without live data is backed by nothing
      // (dropped), and a live time far too early for a tram or bus is broken (shown as timetable only).
      const delaySec = (arrMs - schedArrMs) / 1000;
      if (unbackedShift(delaySec, s.realTime)) continue;
      const realTime = s.realTime && !tooEarly(delaySec, s.mode);

      let entry = trips.get(ref.tripId);
      if (!entry) {
        entry = {
          trip: { tripId: ref.tripId, line: lineOf(ref.displayName), mode: s.mode, color: null, segments: [] },
          seen: new Set(),
        };
        trips.set(ref.tripId, entry);
      }
      const key = `${schedDepMs}|${s.from.stopId ?? s.from.name}`;
      if (entry.seen.has(key)) continue;
      entry.seen.add(key);

      let points: LonLat[] = decodePolyline(s.polyline, 5);
      if (points.length < 2) {
        points = [
          [s.from.lon, s.from.lat],
          [s.to.lon, s.to.lat],
        ];
      }
      entry.trip.segments.push({
        depMs: realTime ? depMs : schedDepMs,
        arrMs: realTime ? arrMs : schedArrMs,
        schedDepMs,
        schedArrMs,
        realTime,
        fromName: s.from.name,
        toName: s.to.name,
        points,
        cum: cumulativeDistances(points),
      });
    }
  }
  const out: PreparedTrip[] = [];
  for (const { trip } of trips.values()) {
    trip.segments.sort((a, b) => a.depMs - b.depMs);
    out.push(trip);
  }
  return out;
}

// Every vehicle on the road at `nowMs`.
export function positionsAt(trips: PreparedTrip[], nowMs: number): VehiclePosition[] {
  const out: VehiclePosition[] = [];
  for (const trip of trips) {
    const at = vehicleAt(trip, nowMs);
    if (at) out.push(at);
  }
  return out;
}

// The stretch of track a vehicle is on right now plus the next one: drawn in its delay color, like a
// traffic layer. Null when the vehicle is not on the road.
export function trackAhead(trip: PreparedTrip, nowMs: number): LonLat[] | null {
  const segs = trip.segments;
  let i = segs.findIndex((s) => nowMs < s.arrMs);
  if (i < 0) return null;
  const first = segs[i]!;
  if (i === 0 && first.depMs - nowMs > 60_000) return null; // not started yet (vehicles.ts: WAIT_SHOW_MS)
  const points: LonLat[] = [...first.points];
  const next: PreparedSegment | undefined = segs[i + 1];
  if (next) points.push(...next.points.slice(1));
  return points;
}

// Drawing order of the colored track where lines share a street: grey (no live data) at the bottom, then
// by delay, red on top. A highlighted line's track (dim false while others are dim) goes above all of them.
const TRACK_PRIORITY: Record<DelayClass, number> = { unknown: 0, ontime: 1, slight: 2, late: 3, verylate: 4 };
export const trackRank = (cls: DelayClass, dim: boolean): number => (dim ? 0 : 10) + TRACK_PRIORITY[cls];

// The filter chips: which kinds of counted vehicles.
export interface Filters {
  groups: Set<ModeGroup>;
}

export const ALL_GROUPS: ModeGroup[] = ["bus", "tram", "sbahn"];

// The kinds with a chip. The S-Bahn has none: too few vehicles for a filter to show much, so it is always
// drawn and counted (decision 2026-11-01).
export const FILTER_GROUPS: ModeGroup[] = ["bus", "tram"];

// The chosen kinds, as a link or a click may give them: the S-Bahn always in, and at least one chip on.
export function withSbahn(groups: Iterable<ModeGroup>): Set<ModeGroup> {
  const out = new Set(groups);
  out.add("sbahn");
  if (!FILTER_GROUPS.some((g) => out.has(g))) for (const g of FILTER_GROUPS) out.add(g);
  return out;
}

// Regional trains and rail replacement buses are not counted and have no chip: always drawn.
export function passes(v: VehiclePosition, f: Filters): boolean {
  return !isCounted(v) || f.groups.has(modeGroup(v.mode));
}

// How many counted vehicles in each color, for the bar under the headline (regional trains left out).
export function classCounts(vehicles: VehiclePosition[]): Record<DelayClass, number> {
  const out: Record<DelayClass, number> = { ontime: 0, slight: 0, late: 0, verylate: 0, unknown: 0 };
  for (const v of vehicles) if (isCounted(v)) out[delayClass(v.delaySec, v.realTime)]++;
  return out;
}

// "When late, how late?": the counted vehicles with live data that are not punctual (2+ min, the yellow,
// orange and red bands). The median of all vehicles is nearly always +0, so it says little.
export const MIN_LATE_FOR_MEDIAN = 10; // the same guard as the headline share
export const lateVehicles = (vehicles: VehiclePosition[]): VehiclePosition[] =>
  vehicles.filter((v) => isCounted(v) && v.realTime && delayClass(v.delaySec, true) !== "ontime");

// Their count, and their median delay from MIN_LATE_FOR_MEDIAN late vehicles on (null below). `group`: only
// that kind of vehicle.
export function lateMedian(vehicles: VehiclePosition[], group?: ModeGroup): { late: number; medianSec: number | null } {
  const late = lateVehicles(vehicles).filter((v) => !group || modeGroup(v.mode) === group);
  return { late: late.length, medianSec: late.length >= MIN_LATE_FOR_MEDIAN ? median(late.map((v) => v.delaySec)) : null };
}

// The late vehicles by minutes late, in five bins: 2-5, 6-10 (the yellow and orange bands), then the red band
// split in three, so a long tail does not hide in one "11+" bar. Rounded up like the bands (61 s is 2 min,
// 601 s is 11), so each bin lies inside one band. `to`: the bin's last minute, null for the open end.
export const DELAY_BINS: { from: number; to: number | null }[] = [
  { from: 2, to: 5 },
  { from: 6, to: 10 },
  { from: 11, to: 15 },
  { from: 16, to: 30 },
  { from: 31, to: null },
];
export function delayHistogram(vehicles: VehiclePosition[]): { from: number; to: number | null; count: number }[] {
  const bins = DELAY_BINS.map((bin) => ({ ...bin, count: 0 }));
  for (const v of lateVehicles(vehicles)) {
    const min = Math.max(2, Math.ceil(v.delaySec / 60));
    bins.find((bin) => bin.to === null || min <= bin.to)!.count++;
  }
  return bins;
}

export const inBox = (box: Box, lon: number, lat: number): boolean =>
  lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east;

// One line's state: how many of its vehicles, their median delay (live ones only).
export interface LineState {
  key: string; // "TRAM|16"
  line: string;
  mode: Mode;
  vehicles: number;
  live: number;
  late: number; // live and more than 1 min late
  medianDelaySec: number | null; // over live vehicles; null without any
  maxDelaySec: number;
  unusual: number; // live vehicles 60+ min late
}

export interface Summary {
  vehicles: number;
  live: number;
  onTime: number; // live and punctual (up to 1 min)
  late: number; // live and more than 1 min late
  medianDelaySec: number | null; // over all live vehicles; null without any
  lines: LineState[]; // every line: supported ones first, each part latest median first
  worst: LineState[]; // lines with a live late vehicle, latest median first (60+ min ones last), at most maxWorst
}

// A line's median says something about the line only with this many live vehicles; with fewer it is one or
// two reports. Those lines still show, after the supported ones, under "few data" (decision 2026-10-31).
export const LINE_SUPPORTED_MIN = 3;
export const isSupported = (s: { live: number }): boolean => s.live >= LINE_SUPPORTED_MIN;

// Ranking order: supported lines first; within each part, a line led by a 60+ min report (probably a stuck
// prediction) goes after the others, so it never leads; then by `then`.
export function bySupport(then: (a: LineState, b: LineState) => number) {
  return (a: LineState, b: LineState): number =>
    Number(isSupported(b)) - Number(isSupported(a)) || Number(a.unusual > 0) - Number(b.unusual > 0) || then(a, b);
}

// Latest median first, then more late vehicles, then the single latest, then by name (a fixed order).
export function byMedian(a: LineState, b: LineState): number {
  return (
    (b.medianDelaySec ?? -1) - (a.medianDelaySec ?? -1) ||
    b.late - a.late ||
    b.maxDelaySec - a.maxDelaySec ||
    a.line.localeCompare(b.line, "de", { numeric: true })
  );
}

export const lineKeyOf = (v: { mode: Mode; line: string }): string => `${v.mode}|${v.line}`;

// map/trips carries no notices. For a highlighted line, one /api/trip request for one of its vehicles
// brings the line's notices: the latest live one (the most likely to be hit by whatever is going on).
// Only vehicles on screen are passed in, so the sample fits the list the user picked the line from.
export function tripForLine(vehicles: VehiclePosition[], key: string): string | null {
  let best: VehiclePosition | null = null;
  for (const v of vehicles) {
    if (lineKeyOf(v) !== key) continue;
    const score = (x: VehiclePosition) => (x.realTime ? x.delaySec : -Infinity);
    if (!best || score(v) > score(best)) best = v;
  }
  return best?.tripId ?? null;
}

// What the headline, the bar and the line lists show, for the counted vehicles given. Regional trains are
// left out here too, whatever the caller passes.
export function summarize(vehicles: VehiclePosition[], maxWorst = 5): Summary {
  const lines = new Map<string, LineState & { delays: number[] }>();
  const allDelays: number[] = [];
  let count = 0;
  let onTime = 0;
  for (const v of vehicles) {
    if (!isCounted(v)) continue;
    count++;
    const key = lineKeyOf(v);
    let s = lines.get(key);
    if (!s) {
      s = { key, line: v.line, mode: v.mode, vehicles: 0, live: 0, late: 0, medianDelaySec: null, maxDelaySec: 0, unusual: 0, delays: [] };
      lines.set(key, s);
    }
    s.vehicles++;
    if (!v.realTime) continue;
    s.live++;
    s.delays.push(v.delaySec);
    allDelays.push(v.delaySec);
    s.maxDelaySec = Math.max(s.maxDelaySec, Math.max(0, v.delaySec));
    if (isUnusual(v)) s.unusual++;
    if (delayClass(v.delaySec, true) === "ontime") onTime++;
    else s.late++;
  }
  const all = [...lines.values()]
    .filter((s) => s.line)
    .map(({ delays, ...s }) => ({ ...s, medianDelaySec: median(delays) }))
    .sort(bySupport(byMedian));
  const live = allDelays.length;
  return {
    vehicles: count,
    live,
    onTime,
    late: live - onTime,
    medianDelaySec: median(allDelays),
    lines: all,
    // The summary ranks by median alone: a line with even one live late vehicle can lead it (user decision
    // 2026-10-31 night, replacing "3+ live first" here); its row says how few vehicles that is.
    worst: all
      .filter((s) => s.late > 0)
      .sort((a, b) => Number(a.unusual > 0) - Number(b.unusual > 0) || byMedian(a, b))
      .slice(0, maxWorst),
  };
}

// One row of the most delayed: a line in one direction, told by its next vehicle. `to`: the trips'
// destination ("Königsforst"), null when this vehicle's destination is not known (yet).
export interface DirectionState extends LineState {
  to: string | null;
  next: VehiclePosition; // the vehicle the row is about
}

// A next stop due further than this from now (by the timetable) is not the next departure: most likely a
// trip of another day (user decision 2026-11-02).
export const NEXT_WINDOW_MS = 60 * 60_000;

// The most delayed list counts lines at least this late (user decision 2026-11-04).
export const WORST_MIN_DELAY_SEC = 120;

// What the destinations known so far say about one line's row.
interface LineRead {
  row: DirectionState | null; // not settled yet: the latest vehicle that may still make the row
  missing: string | null; // the trip to look up next; null: the row is settled
  latest: number; // the latest delay the row can still show, whatever the lookups say
}

// A line's row is its most delayed direction, and a direction is told only by its next vehicle. So the latest
// vehicle makes the row unless an earlier one goes to the same place; then the next latest is tried. Its own
// destination comes first, as a vehicle already known to go there rules it out at once. It takes the row once
// every earlier vehicle is known to go elsewhere. The vehicles behind it need no lookup (undefined from `toOf`:
// not looked up yet; null: none known). A vehicle with no known destination cannot be ruled out: two unknowns are
// not known to share a direction, so a failed lookup never hides a late line. Until a line is settled its row
// already shows that vehicle, so a line with a late vehicle is not missing from the list while lookups run.
function readLine(
  live: VehiclePosition[],
  toOf: (tripId: string) => string | null | undefined,
  nowMs: number,
): LineRead {
  const due = live
    .filter((v) => v.nextSchedMs === undefined || Math.abs(v.nextSchedMs - nowMs) <= NEXT_WINDOW_MS)
    .sort((a, b) => (a.nextMs ?? 0) - (b.nextMs ?? 0));
  const rowOf = (next: VehiclePosition, to: string | null): DirectionState => ({ ...summarize([next], 0).lines[0]!, to, next });
  const latestFirst = due.filter((v) => v.delaySec >= WORST_MIN_DELAY_SEC).sort((a, b) => b.delaySec - a.delaySec);
  for (const v of latestFirst) {
    const to = toOf(v.tripId);
    if (to === undefined) return { row: rowOf(v, null), missing: v.tripId, latest: v.delaySec };
    if (to === null) return { row: rowOf(v, null), missing: null, latest: v.delaySec };
    const earlier = due.slice(0, due.indexOf(v));
    if (earlier.some((e) => toOf(e.tripId) === to)) continue;
    const unknown = earlier.find((e) => toOf(e.tripId) === undefined);
    return { row: rowOf(v, to), missing: unknown?.tripId ?? null, latest: v.delaySec };
  }
  return { row: null, missing: null, latest: 0 };
}

// A failed lookup (the Worker's limit, an outage) is tried again after a minute, the wait the Worker's "too many
// requests" answer asks for, at most LOOKUP_TRIES times in all. Until then its row has no direction.
export const LOOKUP_RETRY_MS = 60_000;
export const LOOKUP_TRIES = 3;
export interface FailedLookup {
  tries: number;
  atMs: number; // when the latest try failed
}
export const lookupFailed = (before: FailedLookup | undefined, nowMs: number): FailedLookup => ({
  tries: (before?.tries ?? 0) + 1,
  atMs: nowMs,
});
export const retryDue = (failed: FailedLookup, nowMs: number): boolean =>
  failed.tries < LOOKUP_TRIES && nowMs - failed.atMs >= LOOKUP_RETRY_MS;

// Every tram line (tram, Stadtbahn, U-Bahn) with live vehicles. Timetable-only vehicles say nothing about a
// delay and are left out.
function readTramLines(
  vehicles: VehiclePosition[],
  toOf: (tripId: string) => string | null | undefined,
  nowMs: number,
): LineRead[] {
  const byLine = new Map<string, VehiclePosition[]>();
  for (const v of vehicles) {
    if (modeGroup(v.mode) !== "tram" || !isCounted(v) || !v.realTime || !v.line) continue;
    const key = lineKeyOf(v);
    byLine.set(key, [...(byLine.get(key) ?? []), v]);
  }
  return [...byLine.values()].map((live) => readLine(live, toOf, nowMs));
}

// The most delayed list (user decisions 2026-11-03 and 2026-11-04): tram lines only, one row per line, its most
// delayed direction's next vehicle, latest first, 2+ min late, at most 5.
export function worstTramLines(
  vehicles: VehiclePosition[],
  toOf: (tripId: string) => string | null | undefined,
  nowMs: number,
  maxWorst = 5,
): DirectionState[] {
  return readTramLines(vehicles, toOf, nowMs)
    .flatMap((line) => (line.row && (line.row.medianDelaySec ?? 0) >= WORST_MIN_DELAY_SEC ? [line.row] : []))
    .sort(byMedian)
    .slice(0, maxWorst);
}

// The trips to look up for that list, most useful first: at most one per line. Lines are taken from the latest
// on, and a line stays out once `maxWorst` settled rows are later than anything it could show. While lookups are
// open for enough lines to fill the list, the lines after them wait: the answers may rule them out.
export function destinationsNeeded(
  vehicles: VehiclePosition[],
  toOf: (tripId: string) => string | null | undefined,
  nowMs: number,
  maxWorst = 5,
): string[] {
  const settled: number[] = []; // the settled rows' delays, latest first
  const ask: string[] = [];
  for (const line of readTramLines(vehicles, toOf, nowMs).sort((a, b) => b.latest - a.latest)) {
    if (settled.length >= maxWorst && settled[maxWorst - 1]! > line.latest) break;
    if (ask.length && settled.length + ask.length >= maxWorst) break;
    if (line.missing) ask.push(line.missing);
    else if (line.row) {
      settled.push(line.row.next.delaySec);
      settled.sort((a, b) => b - a);
    }
  }
  return ask;
}

// How many counted vehicles of each kind there are, and how many of them have live data (live coverage is a
// finding of its own: buses often have none).
export function liveByGroup(vehicles: VehiclePosition[]): Record<ModeGroup, { vehicles: number; live: number }> {
  const out: Record<ModeGroup, { vehicles: number; live: number }> = {
    bus: { vehicles: 0, live: 0 },
    tram: { vehicles: 0, live: 0 },
    sbahn: { vehicles: 0, live: 0 },
  };
  for (const v of vehicles) {
    if (!isCounted(v)) continue;
    const g = out[modeGroup(v.mode)];
    g.vehicles++;
    if (v.realTime) g.live++;
  }
  return out;
}

// A comparison sentence needs this many live vehicles on each side (decision 2026-10-31): the same
// rule as the headline. No minimum gap and no coverage guard: the sentence always gives both percentages and
// how many vehicles have live data on each side, so the reader can judge. A display rule, not a test of
// significance.
export const FINDING_MIN_LIVE = MIN_LIVE_FOR_SHARE;

export interface Group<K> {
  key: K;
  vehicles: number; // all counted vehicles of the group, with or without live data
  live: number;
  onTime: number;
}

export interface Finding<K> {
  better: K;
  worse: K;
  betterPct: number; // rounded for display
  worsePct: number;
  gapPct: number; // unrounded
  betterGroup: Group<K>;
  worseGroup: Group<K>;
}

const shareOf = (g: Group<unknown>): number => (g.onTime / g.live) * 100;
export const enoughForFinding = (g: Group<unknown>): boolean => g.live >= FINDING_MIN_LIVE;

// The biggest gap among the groups (kinds of vehicles, or cities): the most and the least punctual of those
// with enough live data, however small the gap. Null with fewer than two such groups.
export function clearestGap<K>(groups: Group<K>[]): Finding<K> | null {
  const usable = groups.filter(enoughForFinding).sort((a, b) => shareOf(b) - shareOf(a));
  if (usable.length < 2) return null;
  const best = usable[0]!;
  const worst = usable[usable.length - 1]!;
  const gapPct = shareOf(best) - shareOf(worst);
  return {
    better: best.key,
    worse: worst.key,
    betterPct: Math.round(shareOf(best)),
    worsePct: Math.round(shareOf(worst)),
    gapPct,
    betterGroup: best,
    worseGroup: worst,
  };
}

// The counted vehicles split by kind, as groups for clearestGap (kinds with no vehicle left out).
export function groupsByMode(vehicles: VehiclePosition[]): Group<ModeGroup>[] {
  const out = new Map<ModeGroup, Group<ModeGroup>>();
  for (const v of vehicles) {
    if (!isCounted(v)) continue;
    const key = modeGroup(v.mode);
    const g = out.get(key) ?? { key, vehicles: 0, live: 0, onTime: 0 };
    g.vehicles++;
    if (v.realTime) {
      g.live++;
      if (delayClass(v.delaySec, true) === "ontime") g.onTime++;
    }
    out.set(key, g);
  }
  return [...out.values()];
}

// How complete the numbers are: each wanted tile is usable (an answer inside its 5 minutes), loading,
// failed (never loaded) or expired (its answer is too old and no new one came).
export interface TileSnapshot {
  fetchedAtMs: number; // 0: never loaded
  failedMs: number | null; // the latest try failed
  stale: boolean; // the Worker sent its last good copy
  loading: boolean;
}

export interface Coverage {
  wanted: number;
  usable: number;
  loading: number;
  failed: number; // failed or expired: no usable answer and no try running
  refreshFailed: boolean; // a usable answer whose refresh failed, or a stale copy
  oldestMs: number | null; // the oldest usable answer
}

// `lifeMs`: how long an answer says something about now (a tile's window, or a city's shorter one).
export function coverage(tiles: (TileSnapshot | undefined)[], nowMs: number, lifeMs = ANSWER_LIFE_MS): Coverage {
  const out: Coverage = { wanted: tiles.length, usable: 0, loading: 0, failed: 0, refreshFailed: false, oldestMs: null };
  for (const s of tiles) {
    if (s && s.fetchedAtMs > 0 && nowMs - s.fetchedAtMs <= lifeMs) {
      out.usable++;
      if (s.failedMs !== null || s.stale) out.refreshFailed = true;
      out.oldestMs = out.oldestMs === null ? s.fetchedAtMs : Math.min(out.oldestMs, s.fetchedAtMs);
    } else if (!s || s.loading || s.failedMs === null) {
      out.loading++; // not asked yet counts as loading: sync() asks right away
    } else {
      out.failed++;
    }
  }
  return out;
}

// The notices of a picked line come from one sample trip. A new sample is taken when there is none, when
// that vehicle has left the screen, or when the sample is older than `maxAgeMs`.
export function needsNewSample(
  sample: { tripId: string; atMs: number } | null,
  inView: VehiclePosition[],
  nowMs: number,
  maxAgeMs = 120_000,
): boolean {
  if (!sample) return true;
  if (nowMs - sample.atMs >= maxAgeMs) return true;
  return !inView.some((v) => v.tripId === sample.tripId);
}

// A picked line's vehicles on screen (the line detail view): how many, how many with live data, the range of
// their live delays, and the vehicles themselves, latest live one first, timetable-only ones last.
export interface LineDetail {
  vehicles: number;
  live: number;
  timetableOnly: number;
  minDelaySec: number | null; // live ones only, early counts as 0; null without live data
  maxDelaySec: number | null;
  rows: VehiclePosition[]; // at most `maxRows`
  more: number; // vehicles not in `rows`
}

export function lineDetail(inView: VehiclePosition[], key: string, maxRows = 8): LineDetail {
  const mine = inView.filter((v) => lineKeyOf(v) === key);
  const live = mine.filter((v) => v.realTime);
  const delays = live.map((v) => Math.max(0, v.delaySec));
  const sorted = [...mine].sort(
    (a, b) =>
      Number(b.realTime) - Number(a.realTime) ||
      (a.realTime ? b.delaySec - a.delaySec : 0) ||
      (a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0),
  );
  return {
    vehicles: mine.length,
    live: live.length,
    timetableOnly: mine.length - live.length,
    minDelaySec: delays.length ? Math.min(...delays) : null,
    maxDelaySec: delays.length ? Math.max(...delays) : null,
    rows: sorted.slice(0, maxRows),
    more: Math.max(0, sorted.length - maxRows),
  };
}
