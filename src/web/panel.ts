// The bottom sheet / side card. Shared by the stop board and the vehicle card:
// only one of them owns it at a time, and opening one closes the other.

import type * as maplibregl from "maplibre-gl";

export interface PanelUser {
  onClose(): void; // stop polling, clear map highlights
}

// Below this width the panel covers the bottom of the map, so tapped things are moved up into view.
const NARROW_PX = 700;

const panelEl = document.querySelector<HTMLElement>("#board")!;
const titleEl = document.querySelector<HTMLElement>("#board-title")!;
const bodyEl = document.querySelector<HTMLElement>("#board-body")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#board-close")!;

let owner: PanelUser | null = null;
// What had keyboard focus before the panel opened (search box, map, a button), to give it back on close.
let opener: HTMLElement | null = null;
// Focus goes back only for keyboard users: on a phone, focusing the search box again would pop up
// the on-screen keyboard after every close.
let usingKeyboard = false;
document.addEventListener("keydown", () => (usingKeyboard = true), true);
document.addEventListener("pointerdown", () => (usingKeyboard = false), true);

closeBtn.addEventListener("click", () => closePanel());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePanel();
});

export function openPanel(user: PanelUser): void {
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
  const previous = owner;
  owner = null;
  // Focus inside the panel would be lost with it (the next Tab would start at the top of the page).
  const active = document.activeElement;
  const hadFocus = active === document.body || (active instanceof Node && panelEl.contains(active));
  panelEl.hidden = true;
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

// Tapping empty map (no vehicle, no stop) closes whatever is open.
export function closeOnEmptyMapTap(map: maplibregl.Map, layers: string[]): void {
  map.on("click", (e) => {
    const present = layers.filter((id) => map.getLayer(id));
    if (present.length && map.queryRenderedFeatures(e.point, { layers: present }).length === 0) closePanel();
  });
}

// Small DOM helper. Text goes in via textContent, so upstream names are never parsed as HTML.
export function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
