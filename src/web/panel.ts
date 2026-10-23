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
  owner = user;
  panelEl.hidden = false;
}

// Replace the content. Ignored if `user` no longer owns the panel (a late answer, say).
// `title`: plain text, or nodes (the trip card puts the line badge in front of the destination).
// Keyboard focus survives the redraw: a focused control tagged with `focusKey` gets focus back
// on its new copy with the same key. Only the title is read out by screen readers, and only when
// its text changes (a new stop or trip), not on every countdown tick.
export function renderPanel(user: PanelUser, title: string | Node[], nodes: Node[]): void {
  if (owner !== user) return;
  const active = document.activeElement;
  const key = active instanceof HTMLElement && bodyEl.contains(active) ? active.dataset["focus"] : undefined;
  const next = document.createElement("h2");
  if (typeof title === "string") next.textContent = title;
  else next.replaceChildren(...title);
  if (next.innerHTML !== titleEl.innerHTML) titleEl.replaceChildren(...next.childNodes);
  bodyEl.replaceChildren(...nodes);
  if (key !== undefined) {
    bodyEl.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }
}

// Tag a control so `renderPanel` can give focus back to it after a redraw.
export function focusKey<T extends HTMLElement>(node: T, key: string): T {
  node.dataset["focus"] = key;
  return node;
}

// "vor 8 s aktualisiert · neu jede Minute" with a dot: green while fresh, red once the data is old.
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
  panelEl.hidden = true;
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
