// Turns Transitous stoptimes into departure-board rows, plus the text shown for each row.
// Pure functions only (no DOM, no fetch), so everything here is unit tested. Texts come from i18n.ts.

import type { Mode, StopTime } from "./api";
import { t } from "./i18n";

// Keep a departure on the board this long after it left (times have minute resolution).
export const DEPARTED_GRACE_MS = 30_000;

export type DelayLevel = "ontime" | "late" | "verylate" | "unknown";

export interface DepartureRow {
  tripId: string;
  line: string;
  extra: boolean; // a trip the timetable does not know (no line name, no usable trip ID)
  headsign: string;
  mode: Mode;
  stopName: string;
  lon: number;
  lat: number;
  platform: string | null; // e.g. "Gleis 2"; null where we do not know what the sign says
  depMs: number;
  schedMs: number;
  delaySec: number; // positive = late
  realTime: boolean;
  cancelled: boolean;
  color: string | null; // "#rrggbb" or null
  textColor: string | null;
}

const HEX_COLOR = /^[0-9a-fA-F]{6}$/;

// Transitous colors come as "rrggbb"; anything else is ignored.
export const hexOrNull = (c: string | undefined): string | null => (c && HEX_COLOR.test(c) ? `#${c}` : null);

// Long-distance and other non-local traffic is left off the boards (IC/ICE, coaches, planes).
const HIDDEN_MODES = new Set<Mode>(["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "COACH", "AIRPLANE"]);

const RAIL_MODES = new Set<Mode>(["REGIONAL_RAIL", "REGIONAL_FAST_RAIL", "SUBURBAN", "RAIL"]);

// Trams, Stadtbahn and buses are hardly ever more than a few minutes early.
// Much earlier than that is broken live data (seen: a steady "-9", a "-16"). Trains are not checked.
const EARLY_CHECK_MODES = new Set<Mode>(["TRAM", "SUBWAY", "BUS"]);
export const TOO_EARLY_SEC = 5 * 60;

// True when a live time this early cannot be right; the board then shows the timetable time instead.
export function tooEarly(delaySec: number, mode: Mode): boolean {
  return EARLY_CHECK_MODES.has(mode) && delaySec < -TOO_EARLY_SEC;
}

// German rail platform IDs end in ":7:<70 + platform>", e.g. "de:05314:66101:7:72" = Gleis 2.
// Checked against DB's own platforms for ~160 trains at Bonn Hbf, Bad Godesberg and Köln Messe/Deutz
// (Gleis 1-10). Transitous' `track` field is not the sign (it says 78 for Bonn Hbf Gleis 1).
const RAIL_PLATFORM = /:7:(\d{2})$/;

// What the platform sign says, where we know it: only trains. Bus and tram numbers in the data
// do not match the signs (Rheinallee's bays C1-C3 come as 26-28), so they are left out.
export function platformLabel(stopId: string | undefined | null, mode: Mode): string | null {
  if (!stopId || !RAIL_MODES.has(mode)) return null;
  const m = RAIL_PLATFORM.exec(stopId);
  const n = m ? Number(m[1]) - 70 : 0;
  return n >= 1 ? `Gleis ${n}` : null;
}

// "RB26", not "RB26 (25445)": the number in brackets is the train number, which riders do not need.
// Null when the feed has no line name at all (extra trips added by the live feed).
export function lineName(displayName: string | undefined, routeShortName: string | undefined): string | null {
  const name = (routeShortName || displayName || "").replace(/\s*\(\d+\)$/, "").trim();
  return name && name !== "?" ? name : null;
}

// Local departures you can board, sorted by (predicted) departure time, exact duplicates removed.
export function toRows(stopTimes: StopTime[]): DepartureRow[] {
  const rows: DepartureRow[] = [];
  const seen = new Set<string>();

  for (const st of stopTimes) {
    const p = st.place;
    // Arrival-only entries (e.g. at the last stop of a trip) are not departures.
    if (st.pickupDropoffType === "NOT_ALLOWED" || !p.departure) continue;
    if (HIDDEN_MODES.has(st.mode)) continue;

    const liveMs = Date.parse(p.departure);
    const schedMs = p.scheduledDeparture ? Date.parse(p.scheduledDeparture) : liveMs;
    // A live time that cannot be right is replaced by the timetable (shown as "timetable only").
    const implausible = st.realTime && tooEarly((liveMs - schedMs) / 1000, st.mode);
    const depMs = implausible ? schedMs : liveMs;
    const key = `${st.tripId}|${p.stopId ?? p.name}|${depMs}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const line = lineName(st.displayName, st.routeShortName);
    rows.push({
      tripId: st.tripId,
      line: line ?? "Extra",
      extra: line === null,
      headsign: st.headsign,
      mode: st.mode,
      stopName: p.name,
      lon: p.lon,
      lat: p.lat,
      platform: platformLabel(p.stopId, st.mode),
      depMs,
      schedMs,
      delaySec: (depMs - schedMs) / 1000,
      realTime: st.realTime && !implausible,
      cancelled: st.cancelled || st.tripCancelled || p.cancelled === true,
      color: hexOrNull(st.routeColor),
      textColor: hexOrNull(st.routeTextColor),
    });
  }
  return rows.sort((a, b) => a.depMs - b.depMs);
}

// Combine the boards of several stations into one list. Nearby stations often return the same
// departures (Transitous groups stops with similar names), so duplicates are dropped.
export function mergeRows(lists: DepartureRow[][]): DepartureRow[] {
  const seen = new Set<string>();
  const out: DepartureRow[] = [];
  for (const rows of lists) {
    for (const r of rows) {
      const key = `${r.tripId}|${r.stopName}|${r.depMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.depMs - b.depMs);
}

// Rows still worth showing at `nowMs`, at most `limit`.
export function upcoming(rows: DepartureRow[], nowMs: number, limit: number): DepartureRow[] {
  return rows.filter((r) => r.depMs >= nowMs - DEPARTED_GRACE_MS).slice(0, limit);
}

// The badge color: the feed's own, else grey for extra trips, slate for buses, blue for the rest.
export const rowColor = (r: DepartureRow): string =>
  r.color ?? (r.extra ? "#757575" : r.mode === "BUS" ? "#4a5a6a" : "#1565c0");

// One row per line, in board order (both directions of a line run along the same streets).
// Extra trips have no trip to ask for; a cancelled row is skipped, another row of that line may come.
export function distinctLines(rows: DepartureRow[]): DepartureRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (r.extra || r.cancelled) return false;
    const key = lineKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const lineKey = (r: DepartureRow): string => `${r.mode}|${r.line}`;

// Same thresholds as the vehicle ring on the map (guidelines section 5.3).
export function delayLevel(delaySec: number, realTime: boolean): DelayLevel {
  if (!realTime) return "unknown";
  const late = Math.abs(delaySec);
  if (late < 60) return "ontime";
  if (late < 300) return "late";
  return "verylate";
}

// "+2" / "-1" in minutes, empty when on time.
export function formatDelay(delaySec: number): string {
  const min = Math.round(delaySec / 60);
  if (min === 0) return "";
  return min > 0 ? `+${min}` : `${min}`;
}

const berlinClock = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
});

// "21:50" in Berlin time.
export function formatClock(ms: number): string {
  return berlinClock.format(ms);
}

// "jetzt" / "now", "in 7 min", or a Berlin clock time for anything an hour or more away.
// Rounds down: better to arrive a little early than to miss it.
export function formatCountdown(depMs: number, nowMs: number): string {
  const diff = depMs - nowMs;
  if (diff < 60_000) return t().now;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return t().inMin(min);
  return berlinClock.format(depMs);
}

// Bonn's and Köln's Stadtbahn lines come as TRAM, like real trams (Bonn 61/62/65, Düsseldorf 701-709).
// Düsseldorf's U70-U79 come as SUBWAY.
const STADTBAHN_LINES = new Set(["1", "3", "4", "5", "7", "9", "12", "13", "15", "16", "17", "18", "63", "66", "67", "68"]);

// What kind of vehicle, in words ("Stadtbahn", "Zug"); null when it is nothing we name.
export function modeLabel(mode: Mode, line: string): string | null {
  if (mode === "TRAM") return STADTBAHN_LINES.has(line) ? t().modeLightRail : t().modeTram;
  if (mode === "SUBWAY") return t().modeLightRail;
  if (mode === "BUS") return t().modeBus;
  if (mode === "ODM") return t().modeOnDemand;
  if (mode === "FUNICULAR") return t().modeSuspension; // the only one around: Wuppertal's Schwebebahn
  if (mode === "FERRY") return t().modeFerry;
  if (mode === "SUBURBAN") return t().modeSBahn;
  if (RAIL_MODES.has(mode)) return t().modeTrain;
  return null;
}

// The small line under the countdown: "+3 live", "pünktlich", "nur Fahrplan" or "fällt aus".
export function delayState(delaySec: number, realTime: boolean, cancelled: boolean): { text: string; level: DelayLevel } {
  if (cancelled) return { text: t().cancelled, level: "verylate" };
  if (!realTime) return { text: t().timetableOnly, level: "unknown" };
  const delay = formatDelay(delaySec);
  return { text: delay ? t().liveDelay(delay) : t().onTimeShort, level: delayLevel(delaySec, true) };
}
