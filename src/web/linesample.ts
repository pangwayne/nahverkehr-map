// The notices of a picked line come from one sample trip on screen (one /api/trip request; a new sample when
// that vehicle leaves the screen or after 2 minutes). This keeps what is shown (the last answer that arrived)
// apart from the latest try, so a failed refresh never makes an old answer look current or puts another
// trip's name on it. No DOM and no network here: livemap.ts does the request and the drawing.

import type { Notice } from "./alerts";
import { needsNewSample, tripForLine } from "./fleet";
import type { VehiclePosition } from "./vehicles";

export interface SampleAnswer {
  notices: Notice[];
  to: string | null; // the sample trip's destination
  stale: boolean; // the Worker sent its last good copy
}

export interface LineSample {
  key: string; // "TRAM|16"
  line: string;
  shown: (SampleAnswer & { tripId: string; atMs: number }) | null; // the last answer that arrived
  attempt: Attempt | null; // the latest try, answered or not
  fetching: boolean;
  failed: boolean; // the latest try failed
  gone: boolean; // no vehicle of the line on screen right now
}

// One try. `n` is unique per try, so an answer for an earlier try of the same trip (the line picked again
// meanwhile) is never taken for the current one.
export interface Attempt {
  tripId: string;
  atMs: number;
  n: number;
}
let tries = 0;

export function newSample(key: string, line: string): LineSample {
  return { key, line, shown: null, attempt: null, fetching: false, failed: false, gone: false };
}

// Whether to ask for a trip now, and which. Nothing while a request is out or the page is hidden (a hidden tab
// needs no notices; the due request follows when it is visible again).
export function planSample(
  s: LineSample,
  inView: VehiclePosition[],
  nowMs: number,
  visible: boolean,
): { sample: LineSample; fetch: Attempt | null } {
  const candidate = tripForLine(inView, s.key);
  const sample = { ...s, gone: candidate === null };
  if (!candidate || sample.fetching || !visible || !needsNewSample(sample.attempt, inView, nowMs)) {
    return { sample, fetch: null };
  }
  const attempt = { tripId: candidate, atMs: nowMs, n: ++tries };
  return { sample: { ...sample, fetching: true, attempt }, fetch: attempt };
}

// The request of try `done` came back: `answer` null means it failed. Only a success changes what is shown.
export function sampleDone(s: LineSample, done: Attempt, answer: SampleAnswer | null, nowMs: number): LineSample {
  if (s.attempt?.n !== done.n) return s; // an answer for an older try
  if (!answer) return { ...s, fetching: false, failed: true };
  return { ...s, fetching: false, failed: false, shown: { ...answer, tripId: done.tripId, atMs: nowMs } };
}

// What the notice section says:
// - "none": no vehicle of the line on screen (an earlier sample's notices are not shown under that)
// - "loading" / "failed": no answer yet
// - "list": the last answer; `previous` when the latest refresh failed (it may be about another trip than
//   the one that would be asked now, so it is labeled as older, with its own destination)
export type NoticeView =
  | { kind: "none" | "loading" | "failed"; line: string }
  | { kind: "list"; line: string; to: string | null; notices: Notice[]; stale: boolean; previous: boolean };

export function noticeView(s: LineSample): NoticeView {
  if (s.gone) return { kind: "none", line: s.line };
  if (!s.shown) return { kind: s.failed && !s.fetching ? "failed" : "loading", line: s.line };
  const { to, notices, stale } = s.shown;
  return { kind: "list", line: s.line, to, notices, stale, previous: s.failed };
}
