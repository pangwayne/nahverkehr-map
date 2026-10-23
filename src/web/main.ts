import "@fontsource-variable/hanken-grotesk/wght.css";
import { startBoard } from "./board";
import { getLang, onLangChange, setLang, t } from "./i18n";
import { createMap } from "./map";
import { closeOnEmptyMapTap } from "./panel";
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

const map = createMap(mapEl);
// Order matters: the board's stop layers go first, the trip card puts its route line under them
// and its vehicle on top of everything.
const board = startBoard(map, (trip) => card.showTrip(trip));
const card = startTripCard(map, (stop) => void board.showStop(stop));
startSearch(board);
closeOnEmptyMapTap(map, ["vehicle-dot", "stop-hit", "trip-route-line", "trip-stop-dot"]);
