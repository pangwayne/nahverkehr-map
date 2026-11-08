// Saved stops and routes ("Merken"), kept in this browser only (localStorage), never sent anywhere.
// No account, no sync: another browser or a cleared browser starts empty. My location is never stored as a
// position: a saved route from "My location" asks for the location again when used.
// Pure apart from the storage calls, which may fail (private mode): then saving lasts until the tab closes.

import { type EndRef, type RouteRef, isStationId } from "./endpoints";

export interface SavedStop {
  id: string; // station ID
  name: string;
}

export interface SavedRoute {
  from: EndRef;
  to: EndRef;
  prefs: Record<string, string>;
}

export interface Saved {
  stops: SavedStop[];
  routes: SavedRoute[];
}

const STORAGE_KEY = "saved";
const MAX_ITEMS = 20; // per kind; the oldest goes when a new one comes
const NAME_MAX = 80;

let memory: Saved = { stops: [], routes: [] }; // used when storage is blocked
const listeners: (() => void)[] = [];

export function onSavedChange(fn: () => void): void {
  listeners.push(fn);
}

const cleanName = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && v.length <= NAME_MAX ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : null;

function readEndRef(v: unknown): EndRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o["kind"] === "here") return { kind: "here" };
  const name = cleanName(o["name"]);
  if (!name) return null;
  if (o["kind"] === "stop" && typeof o["id"] === "string" && isStationId(o["id"])) return { kind: "stop", id: o["id"], name };
  const what = o["what"];
  const lat = o["lat"];
  const lon = o["lon"];
  if (
    o["kind"] === "spot" &&
    (what === "address" || what === "place" || what === "pin") &&
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon)
  ) {
    return { kind: "spot", name, lat, lon, what };
  }
  return null;
}

// Whatever was stored, checked item by item: a broken entry is dropped, not the whole list.
export function parseSaved(text: string | null): Saved {
  const out: Saved = { stops: [], routes: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "null");
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const s of Array.isArray(o["stops"]) ? o["stops"] : []) {
    const id = (s as Record<string, unknown>)?.["id"];
    const name = cleanName((s as Record<string, unknown>)?.["name"]);
    if (typeof id === "string" && isStationId(id) && name && !out.stops.some((x) => x.id === id)) out.stops.push({ id, name });
  }
  for (const r of Array.isArray(o["routes"]) ? o["routes"] : []) {
    const from = readEndRef((r as Record<string, unknown>)?.["from"]);
    const to = readEndRef((r as Record<string, unknown>)?.["to"]);
    const rawPrefs = (r as Record<string, unknown>)?.["prefs"];
    const prefs: Record<string, string> = {};
    if (rawPrefs && typeof rawPrefs === "object") {
      for (const [k, v] of Object.entries(rawPrefs)) if (typeof v === "string" && /^[a-z0-9]{1,4}$/.test(v)) prefs[k] = v;
    }
    if (from && to) out.routes.push({ from, to, prefs });
  }
  out.stops = out.stops.slice(0, MAX_ITEMS);
  out.routes = out.routes.slice(0, MAX_ITEMS);
  return out;
}

export function loadSaved(): Saved {
  try {
    const text = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (text === undefined) return memory;
    memory = parseSaved(text);
  } catch {
    // Storage blocked: keep what this tab saved.
  }
  return memory;
}

function store(saved: Saved): void {
  memory = saved;
  try {
    if (saved.stops.length || saved.routes.length) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(saved));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: kept in memory until the tab closes.
  }
  for (const fn of listeners) fn();
}

// `ids`: every ID the station goes by (stops.ts stationIds): it may have been saved under one merged into it.
export const isStopSaved = (ids: string[]): boolean => loadSaved().stops.some((s) => ids.includes(s.id));

// `aliases`: the station's other IDs; a copy saved under one of them counts as this stop.
export function toggleStop(stop: SavedStop, aliases: string[] = []): boolean {
  const saved = loadSaved();
  const ids = [stop.id, ...aliases];
  const on = saved.stops.some((s) => ids.includes(s.id));
  const stops = on ? saved.stops.filter((s) => !ids.includes(s.id)) : [stop, ...saved.stops].slice(0, MAX_ITEMS);
  store({ ...saved, stops });
  return !on;
}

const routeKey = (r: { from: EndRef; to: EndRef; prefs: Record<string, string> }) =>
  JSON.stringify([r.from, r.to, Object.entries(r.prefs).sort()]);

// A route as a saved one, if both its ends are known (My location counts: it is asked for again).
export function savableRoute(r: RouteRef): SavedRoute | null {
  return r.from && r.to ? { from: r.from, to: r.to, prefs: r.prefs } : null;
}

export const isRouteSaved = (r: SavedRoute): boolean => loadSaved().routes.some((x) => routeKey(x) === routeKey(r));

export function toggleRoute(r: SavedRoute): boolean {
  const saved = loadSaved();
  const on = isRouteSaved(r);
  const routes = on ? saved.routes.filter((x) => routeKey(x) !== routeKey(r)) : [r, ...saved.routes].slice(0, MAX_ITEMS);
  store({ ...saved, routes });
  return !on;
}

export function clearSaved(): void {
  store({ stops: [], routes: [] });
}
