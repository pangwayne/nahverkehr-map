// One meaning of "late" for the whole app (decision 2026-10-31): the live overview, the
// map, the departure boards, the trip card and the route panel all use these bands. No imports, so every
// module can use it.

export type DelayClass = "ontime" | "slight" | "late" | "verylate" | "unknown";

export const DELAY_COLORS: Record<DelayClass, string> = {
  ontime: "#2e9d4a",
  slight: "#e0b000",
  late: "#f07800",
  verylate: "#d32f2f",
  unknown: "#8a94a6",
};

// Green punctual up to 60 s, yellow up to 5 min, orange up to 10 min, red beyond; grey without live data
// (never green). Early counts as punctual (the boards still write "-2": an early bus can be missed). Live
// times come in whole minutes, so in practice 0-1 / 2-5 / 6-10 / 11+ min.
export function delayClass(delaySec: number, realTime: boolean): DelayClass {
  if (!realTime) return "unknown";
  if (delaySec <= 60) return "ontime";
  if (delaySec <= 300) return "slight";
  if (delaySec <= 600) return "late";
  return "verylate";
}

// A delay or a median in whole minutes, the one rounding rule for text and color (90 s: +2 min, yellow).
export const wholeMinutes = (sec: number): number => Math.round(sec / 60);

// The color class of a rounded value: what the text says and the color always agree.
export const roundedClass = (sec: number, realTime: boolean): DelayClass => delayClass(wholeMinutes(sec) * 60, realTime);
