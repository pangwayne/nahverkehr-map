// The bottom sheet / side card. Shared by the stop board and the vehicle card:
// only one of them owns it at a time, and opening one closes the other.

import type * as maplibregl from "maplibre-gl";
import type { Notice } from "./alerts";
import { formatClock } from "./departures";
import { t, onLangChange } from "./i18n";

export interface PanelUser {
  onClose(): void; // stop polling, clear map highlights
}

// Below this width the panel covers the bottom of the map, so tapped things are moved up into view.
const NARROW_PX = 700;

const panelEl = document.querySelector<HTMLElement>("#board")!;
const titleEl = document.querySelector<HTMLElement>("#board-title")!;
const bodyEl = document.querySelector<HTMLElement>("#board-body")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#board-close")!;
const growBtn = document.querySelector<HTMLButtonElement>("#board-grow");

let owner: PanelUser | null = null;
let openings = 0; // counts every open and close, so a late action can tell that something else came first
// What had keyboard focus before the panel opened (search box, map, a button), to give it back on close.
let opener: HTMLElement | null = null;
// Focus goes back only for keyboard users: on a phone, focusing the search box again would pop up
// the on-screen keyboard after every close.
let usingKeyboard = false;
document.addEventListener("keydown", () => (usingKeyboard = true), true);
document.addEventListener("pointerdown", () => (usingKeyboard = false), true);

// What Close, Escape and a tap on empty map do: by default just close; main.ts makes it a step back in the
// browser history to the empty map (nav.ts), which then closes the panel.
let closeRequest: () => void = () => closePanel();
export function onCloseRequest(fn: () => void): void {
  closeRequest = fn;
}
export function requestClose(): void {
  if (owner) closeRequest();
}

closeBtn.addEventListener("click", () => requestClose());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") requestClose();
});

// Phones: the sheet covers half the map; this button lets it take most of the screen, and back.
function setTall(tall: boolean): void {
  panelEl.classList.toggle("tall", tall);
  if (!growBtn) return;
  growBtn.setAttribute("aria-expanded", String(tall));
  const label = tall ? t().sheetSmaller : t().sheetTaller;
  growBtn.setAttribute("aria-label", label);
  growBtn.title = label;
}
growBtn?.addEventListener("click", () => setTall(!panelEl.classList.contains("tall")));
setTall(false);
onLangChange(() => setTall(panelEl.classList.contains("tall")));

// Changes whenever the panel is opened or closed (by anyone).
export const panelChanges = (): number => openings;

export function openPanel(user: PanelUser): void {
  openings++;
  if (owner && owner !== user) {
    const previous = owner;
    owner = null;
    previous.onClose();
  }
  if (panelEl.hidden) {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  owner = user;
  panelEl.hidden = false;
  document.body.classList.add("panel-open");
}

// Replace the content. Ignored if `user` no longer owns the panel (a late answer, say).
// `title`: plain text, or nodes (the trip card puts the line badge in front of the destination).
// Keyboard focus survives the redraw: a focused control tagged with `focusKey` gets focus back
// on its new copy with the same key. If it has no copy (a departure row that opened its trip card),
// focus goes to the title, so it is not lost. Only the title is read out by screen readers, and only
// when its text changes (a new stop or trip), not on every countdown tick.
export function renderPanel(user: PanelUser, title: string | Node[], nodes: Node[]): void {
  if (owner !== user) return;
  const active = document.activeElement;
  const hadFocus = active instanceof HTMLElement && bodyEl.contains(active);
  const key = hadFocus ? active.dataset["focus"] : undefined;
  const next = document.createElement("h2");
  if (typeof title === "string") next.textContent = title;
  else next.replaceChildren(...title);
  if (next.innerHTML !== titleEl.innerHTML) titleEl.replaceChildren(...next.childNodes);
  bodyEl.replaceChildren(...nodes);
  if (!hadFocus) return;
  const again = key === undefined ? null : bodyEl.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
  (again ?? titleEl).focus({ preventScroll: true });
}

// Move keyboard focus to the panel's title (e.g. after picking a search result).
export function focusPanel(): void {
  if (!panelEl.hidden) titleEl.focus({ preventScroll: true });
}

// Tag a control so `renderPanel` can give focus back to it after a redraw.
export function focusKey<T extends HTMLElement>(node: T, key: string): T {
  node.dataset["focus"] = key;
  return node;
}

// "vor 8 s abgerufen · neu jede Minute" with a dot: green while fresh, red once the data is old
// or the last refresh failed.
export function ageLine(text: string, old: boolean): HTMLElement {
  const p = el("p", old ? "panel-age old" : "panel-age");
  p.append(el("span", "age-dot"), document.createTextNode(text));
  return p;
}

export function ownsPanel(user: PanelUser): boolean {
  return owner === user;
}

// Close the panel; with `user`, only if that user still owns it.
export function closePanel(user?: PanelUser): void {
  if (user && owner !== user) return;
  openings++;
  const previous = owner;
  owner = null;
  // Focus inside the panel would be lost with it (the next Tab would start at the top of the page).
  const active = document.activeElement;
  const hadFocus = active === document.body || (active instanceof Node && panelEl.contains(active));
  panelEl.hidden = true;
  document.body.classList.remove("panel-open");
  setTall(false);
  const back = usingKeyboard && hadFocus && opener?.isConnected && !opener.closest("[hidden]") ? opener : null;
  back?.focus({ preventScroll: true });
  opener = null;
  previous?.onClose();
}

// Map offset that keeps a point clear of the panel: above it on phones, to its right on wide screens.
export function offsetClearOfPanel(): [number, number] {
  if (panelEl.hidden) return [0, 0];
  return window.innerWidth < NARROW_PX ? [0, -panelEl.offsetHeight / 2] : [panelEl.offsetWidth / 2, 0];
}

// A finger is not a pixel: a tap this close to a thin line or a dot still counts as on it.
const TAP_SLOP_PX = 8;

// Tapping empty map (no vehicle, no stop, no shown route) closes whatever is open. `skip`: true for a tap
// that was something else (the end of holding a finger down to drop a pin).
export function closeOnEmptyMapTap(map: maplibregl.Map, layers: string[], skip: () => boolean = () => false): void {
  map.on("click", (e) => {
    if (skip()) return;
    const present = layers.filter((id) => map.getLayer(id));
    const { x, y } = e.point;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [x - TAP_SLOP_PX, y - TAP_SLOP_PX],
      [x + TAP_SLOP_PX, y + TAP_SLOP_PX],
    ];
    if (present.length && map.queryRenderedFeatures(box, { layers: present }).length === 0) requestClose();
  });
}

// Small DOM helper. Text goes in via textContent, so upstream names are never parsed as HTML.
export function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, text: string, focus?: string): HTMLButtonElement {
  const btn = el("button", className, text) as HTMLButtonElement;
  btn.type = "button";
  if (focus) focusKey(btn, focus);
  return btn;
}

// A clock time, with the planned one struck through in front when they differ by a minute or more:
// "21:07 21:25" (screen readers hear "geplant 21:07, 21:25").
export function clock(ms: number, schedMs: number): HTMLElement {
  const span = el("span", "route-clock");
  if (Math.abs(ms - schedMs) >= 60_000) {
    const planned = el("s", "");
    planned.append(el("span", "sr-only", `${t().routePlanned} `), formatClock(schedMs));
    span.append(planned, " ");
  }
  span.append(el("b", "", formatClock(ms)));
  return span;
}

// Service notices as a list of foldable boxes: the header shows, the text opens on a tap. Plain text only;
// a link only when the feed gives an http(s) address. `max`: the rest are counted in a last line.
export function noticeList(notices: Notice[], max: number): HTMLElement | null {
  if (!notices.length) return null;
  const box = el("div", "notices");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", t().noticesLabel);
  for (const n of notices.slice(0, max)) {
    const item = el("details", `notice ${n.level}`);
    const summary = el("summary", "", n.header);
    item.append(summary);
    if (n.body) item.append(el("p", "", n.body));
    if (n.url) {
      const a = el("a", "", t().noticeMore) as HTMLAnchorElement;
      a.href = n.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      item.append(a);
    }
    if (!n.body && !n.url) item.classList.add("bare");
    box.append(item);
  }
  if (notices.length > max) box.append(el("p", "notice-more", t().moreNotices(notices.length - max)));
  return box;
}

// A short message at the bottom of the screen ("Link kopiert"), read out by screen readers.
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string): void {
  let node = document.querySelector<HTMLElement>("#toast");
  if (!node) {
    node = el("div", "toast");
    node.id = "toast";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  node.textContent = text;
  node.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node!.classList.remove("show"), 3000);
}

// Share a link: the phone's share sheet where there is one, else copy it. Says what happened.
export async function shareLink(url: string, title: string, note?: string): Promise<void> {
  if (typeof navigator.share === "function" && window.matchMedia?.("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title, url });
      if (note) toast(note);
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // the user closed the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(note ? `${t().linkCopied} ${note}` : t().linkCopied);
  } catch {
    window.prompt(t().copyThisLink, url);
  }
}
