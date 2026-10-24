// The status line under the title: what is open, and how old its data is.

import { t } from "./i18n";

export type Freshness = "idle" | "loading" | "live" | "stale" | "unavailable";

// Same rule as the board and the trip card: data older than this is called old.
const STALE_AFTER_S = 120;

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

// `ageS`: seconds since the Worker got the data from Transitous; null while nothing has arrived.
export function setStatus(what: string, ageS: number | null, error: boolean): void {
  let freshness: Freshness;
  let text: string;
  if (ageS === null) {
    freshness = error ? "unavailable" : "loading";
    text = `${what} · ${error ? t().unavailable : t().loading}`;
  } else {
    // Recent data stays on screen when a refresh fails, but no longer counts as live.
    const old = ageS > STALE_AFTER_S;
    freshness = old || error ? "stale" : "live";
    text = `${what} · ${ageText(ageS, old, error)}`;
  }
  statusEl.dataset.freshness = freshness;
  statusEl.textContent = text;
}

// Just what is open, for a message that is no data and not loading either ("no stops nearby").
export function setStatusNote(what: string): void {
  statusEl.dataset.freshness = "unavailable";
  statusEl.textContent = what;
}

export function resetStatus(): void {
  statusEl.dataset.freshness = "idle";
  statusEl.textContent = t().idle;
}

// "fetched 8 s ago" (when the server got it, not when the operator last changed it), plus a warning
// once the data is old or the last refresh failed. Also used by the board and the trip card.
export function ageText(ageS: number, old: boolean, failed = false): string {
  const warning = old ? t().dataOld : failed ? t().refreshFailed : null;
  return `${t().updated(Math.round(ageS))}${warning ? ` · ${warning}` : ""}`;
}
