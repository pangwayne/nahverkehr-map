import "@fontsource-variable/hanken-grotesk/wght.css";
import { startBoard } from "./board";
import { getLang, onLangChange, setLang, t } from "./i18n";
import { createMap } from "./map";
import type * as maplibregl from "maplibre-gl";
import { closeOnEmptyMapTap, el } from "./panel";
import { startRoute } from "./route";
import { startSearch } from "./search";
import { resetStatus } from "./status";
import { startTripCard } from "./tripcard";

const mapEl = document.querySelector<HTMLElement>("#map")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;

// Static texts in index.html name their entry in i18n.ts: data-t (text), data-t-label (aria-label),
// data-t-placeholder (input hint), data-href (link target, e.g. the privacy page in the right language).
function pick(key: string | undefined): string | null {
  const v = key ? (t() as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : null;
}

function applyTexts(): void {
  document.documentElement.lang = getLang();
  document.title = t().pageTitle;
  for (const node of document.querySelectorAll<HTMLElement>("[data-t]")) {
    const v = pick(node.dataset["t"]);
    if (v !== null) node.textContent = v;
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-t-label]")) {
    const v = pick(node.dataset["tLabel"]);
    if (v !== null) node.setAttribute("aria-label", v);
  }
  for (const node of document.querySelectorAll<HTMLInputElement>("input[data-t-placeholder]")) {
    const v = pick(node.dataset["tPlaceholder"]);
    if (v !== null) node.placeholder = v;
  }
  for (const node of document.querySelectorAll<HTMLAnchorElement>("a[data-href]")) {
    const v = pick(node.dataset["href"]);
    if (v !== null) node.href = v;
  }
  // Nothing open: the status line shows the hint, in the new language.
  if ((statusEl.dataset["freshness"] ?? "idle") === "idle") resetStatus();
}

applyTexts();
onLangChange(applyTexts);
document.querySelector("#lang")!.addEventListener("click", () => setLang(getLang() === "de" ? "en" : "de"));

// Everything runs on the map. If it cannot start (no WebGL, say), say so instead of a blank page with
// buttons that do nothing.
let map: maplibregl.Map | null = null;
try {
  map = createMap(mapEl);
} catch (err) {
  console.error("map failed to start", err);
  const note = el("p", "map-failed", t().mapFailed);
  note.dataset["t"] = "mapFailed"; // follows the language switch (applyTexts)
  mapEl.replaceChildren(note);
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("#search, #near-me, #route-btn")) {
    input.disabled = true;
  }
}

if (map) {
  // Order matters: the board's stop layers go first, the trip card puts its route line under them
  // and its vehicle on top of everything; a chosen connection's lines also go under the stops.
  // The route planner is still being built: only with ?route=1 in the address.
  const routeOn = new URLSearchParams(location.search).get("route") === "1";
  const board = startBoard(
    map,
    (trip) => card.showTrip(trip),
    routeOn ? (station, end) => route.open(end === "from" ? { from: station } : { to: station }) : null,
  );
  const card = startTripCard(map, (stop) => board.showStop(stop));
  startSearch(board);
  const route = startRoute(board, map, (trip) => card.showTrip(trip));
  if (routeOn) {
    const btn = document.querySelector<HTMLButtonElement>("#route-btn")!;
    btn.hidden = false;
    btn.addEventListener("click", () => route.open());
  }
  closeOnEmptyMapTap(map, [
    "vehicle-dot",
    "stop-hit",
    "trip-route-line",
    "trip-stop-dot",
    "journey-ride",
    "journey-walk",
    "journey-point",
  ]);
}
