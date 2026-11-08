// Idle pause: after 10 minutes without any input, nothing asks for new data until someone is back. A tab left
// open on a screen would otherwise ask Transitous every minute all day. A hidden tab never asks either.
// Mouse, touch, keys and the wheel count as input, and so does coming back to the tab. On the way back,
// the pollers that registered with onResume ask right away, so the numbers are fresh at once.

import { onLangChange, t } from "./i18n";

export const IDLE_MS = 10 * 60_000;
const CHECK_MS = 15_000;

let lastInputMs = Date.now();
let paused = false;
const resumers: (() => void)[] = [];
let note: HTMLElement | null = null;

// Whether a poller may ask for new data now: the page is visible and someone used it in the last 10 minutes.
export function isLive(nowMs = Date.now()): boolean {
  return document.visibilityState === "visible" && nowMs - lastInputMs < IDLE_MS;
}

// Called once the page is live again after a pause (or after being hidden).
export function onResume(fn: () => void): void {
  resumers.push(fn);
}

function input(): void {
  lastInputMs = Date.now();
  if (paused) setPaused(false);
}

function setPaused(on: boolean): void {
  paused = on;
  if (on) {
    note ??= buildNote();
    note.textContent = t().idlePaused;
    note.hidden = false;
    void note.offsetWidth; // lay it out once while still transparent, so adding "show" fades it in
    note.classList.add("show");
  } else {
    note?.classList.remove("show");
    if (note) note.hidden = true;
    for (const fn of resumers) fn();
  }
}

function buildNote(): HTMLElement {
  const el = document.createElement("div");
  el.className = "toast idle-note";
  el.setAttribute("role", "status");
  el.hidden = true;
  // At the top of the map, where nothing else sits (the overview bar and the map's credits are at the bottom).
  (document.querySelector("#map-area") ?? document.body).append(el);
  return el;
}

export function startIdleWatch(): void {
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(type, input, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") input();
  });
  setInterval(() => {
    if (!paused && document.visibilityState === "visible" && !isLive()) setPaused(true);
  }, CHECK_MS);
  onLangChange(() => {
    if (note && paused) note.textContent = t().idlePaused;
  });
}
