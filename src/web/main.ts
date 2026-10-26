import "@fontsource-variable/hanken-grotesk/wght.css";
import { startBoard } from "./board";
import { type View, parseViewHash } from "./endpoints";
import { getLang, onLangChange, setLang, t } from "./i18n";
import { createMap } from "./map";
import type * as maplibregl from "maplibre-gl";
import { closeViews, initialView, run, startNav } from "./nav";
import { closeOnEmptyMapTap, closePanel, el, onCloseRequest, toast } from "./panel";
import { startPlaceCard } from "./placecard";
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
  const m = map;
  // Order matters: the board's stop layers go first, the trip card puts its route line under them
  // and its vehicle on top of everything; a chosen connection's lines also go under the stops.
  const board = startBoard(
    m,
    (trip) => card.showTrip(trip),
    (station, end) => route.open(end === "from" ? { from: station } : { to: station }),
  );
  const card = startTripCard(m, (stop) => board.showStop(stop));
  const route = startRoute(board, m, (trip) => card.showTrip(trip));
  const place = startPlaceCard(m, board, (spot, end) => route.open(end === "from" ? { from: spot } : { to: spot }));
  startSearch(board, {
    flyTo: (center) => m.flyTo({ center, zoom: 13 }),
    showPlace: (spot) => place.show(spot),
    openRoute: (saved) => route.openSaved(saved),
  });
  document.querySelector("#route-btn")!.addEventListener("click", () => route.open());
  const pinJustDropped = startPinDrop(m, (lon, lat) =>
    place.show({ kind: "spot", name: t().pinName, lat, lon, what: "pin" }),
  );
  closeOnEmptyMapTap(
    m,
    ["vehicle-dot", "stop-hit", "trip-route-line", "trip-stop-dot", "journey-ride", "journey-walk", "journey-point"],
    pinJustDropped,
  );

  // Browser history: Back / Forward and links open the view of their entry (nav.ts). Close steps back to the
  // empty map. The `false`s keep these from adding entries of their own.
  const showView = (view: View | null): void => {
    if (!view) {
      closePanel();
      return;
    }
    switch (view.kind) {
      case "stop":
        void board.showStationId(view.id).then((ok) => {
          if (!ok) toast(t().linkGone);
        });
        break;
      case "near":
        if (!board.showNear()) closePanel();
        break;
      case "trip":
        card.showTrip({ tripId: view.tripId, line: view.line, color: view.color, focus: null }, false);
        break;
      case "place":
        place.show(view.spot, false);
        break;
      case "route":
      case "journey":
        route.restore(view);
        break;
    }
  };
  startNav(showView);
  onCloseRequest(() => {
    closeViews();
    closePanel();
  });
  const linked = parseViewHash(location.hash);
  // A link that cannot be read (cut off, or a date that does not exist): the empty map, and said so.
  if (!linked && location.hash.length > 1) toast(t().linkBroken);
  const first = initialView(linked);
  if (first) run(first);
}

// Holding a finger (or the right mouse button) on the map drops a pin there: a place to plan a route from
// or to. Moving or a second finger cancels it (that is panning or zooming). Returns a check for "a pin was
// dropped a moment ago", so the tap that ends the hold does not count as a tap on empty map.
function startPinDrop(map: maplibregl.Map, onPin: (lon: number, lat: number) => void): () => boolean {
  const HOLD_MS = 600;
  const SLOP_PX = 10;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let firedAt = 0;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  map.on("touchstart", (e) => {
    cancel();
    if (e.originalEvent.touches.length !== 1) return;
    start = { x: e.point.x, y: e.point.y };
    const { lng, lat } = e.lngLat;
    timer = setTimeout(() => {
      timer = null;
      firedAt = Date.now();
      onPin(lng, lat);
    }, HOLD_MS);
  });
  map.on("touchmove", (e) => {
    if (!start || Math.hypot(e.point.x - start.x, e.point.y - start.y) > SLOP_PX) cancel();
  });
  map.on("touchend", cancel);
  map.on("touchcancel", cancel);
  map.on("movestart", cancel);
  map.on("contextmenu", (e) => {
    if (Date.now() - firedAt < 1000) return; // the same hold, seen again as a context menu
    firedAt = Date.now();
    onPin(e.lngLat.lng, e.lngLat.lat);
  });
  return () => Date.now() - firedAt < 1000;
}
