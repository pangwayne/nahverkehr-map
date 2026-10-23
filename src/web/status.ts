// The status line under the title: what is open, and how old its data is.

export type Freshness = "idle" | "loading" | "live" | "stale" | "unavailable";

// Same rule as the board and the trip card: data older than this is called old.
const STALE_AFTER_S = 120;

const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

const IDLE_TEXT = "Tap a stop for departures, or press Near me";

// `ageS`: seconds since the Worker got the data from Transitous; null while nothing has arrived.
export function setStatus(what: string, ageS: number | null, error: boolean): void {
  let freshness: Freshness;
  let text: string;
  if (ageS === null) {
    freshness = error ? "unavailable" : "loading";
    text = error ? `${what} · unavailable right now` : `${what} · loading...`;
  } else {
    const old = ageS > STALE_AFTER_S;
    freshness = old ? "stale" : "live";
    text = `${what} · updated ${Math.round(ageS)} s ago${old ? " · data is old" : ""}`;
  }
  statusEl.dataset.freshness = freshness;
  statusEl.textContent = text;
}

export function resetStatus(): void {
  statusEl.dataset.freshness = "idle";
  statusEl.textContent = IDLE_TEXT;
}
