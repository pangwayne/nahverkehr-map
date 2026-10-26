// Service notices from the live feed (construction work, diversions, lifts out of order), ready to show.
// Pure functions only (no DOM, no fetch), so everything here is unit tested. The feed's texts stay plain
// text: they are put on the page with textContent, never as HTML.
// No notice does not mean all is well: many operators send none at all.

import type { Alert } from "./api";

export interface Notice {
  key: string; // header and body: the same notice attached to many stops shows once
  header: string;
  body: string; // "" when the feed has only a header
  url: string | null; // an https link for more, else null
  level: "severe" | "warning" | "info";
}

// More than this and the sheet would be all notices; the rest are counted, not shown.
export const MAX_NOTICES = 4;

const LEVELS: Record<string, Notice["level"]> = { SEVERE: "severe", WARNING: "warning" };
const ORDER: Notice["level"][] = ["severe", "warning", "info"];

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

// Shown only while one of its periods is on (no periods: as long as the feed sends it).
function current(a: Alert, nowMs: number): boolean {
  const periods = a.communicationPeriod ?? [];
  if (periods.length === 0) return true;
  return periods.some((p) => {
    const start = p.start ? Date.parse(p.start) : -Infinity;
    const end = p.end ? Date.parse(p.end) : Infinity;
    return !(nowMs < start) && !(nowMs > end);
  });
}

function safeUrl(url: string | undefined): string | null {
  if (!url || url.length > 500) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

// All notices from several places (stops, rides), once each, most serious first.
export function collectNotices(lists: (Alert[] | undefined)[], nowMs: number): Notice[] {
  const seen = new Map<string, Notice>();
  for (const list of lists) {
    for (const a of list ?? []) {
      if (!current(a, nowMs)) continue;
      let header = clean(a.headerText);
      let body = clean(a.descriptionText);
      if (!header) [header, body] = [body, ""];
      if (!header) continue;
      if (body === header) body = "";
      const key = `${header}\n${body}`;
      if (seen.has(key)) continue;
      seen.set(key, { key, header, body, url: safeUrl(a.url), level: LEVELS[a.severityLevel ?? ""] ?? "info" });
    }
  }
  return [...seen.values()].sort((x, y) => ORDER.indexOf(x.level) - ORDER.indexOf(y.level));
}
