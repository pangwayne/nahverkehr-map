// One end of a route, and the views the app can open, written so they fit in a link or browser history and
// can be read back safely. Pure functions only (no DOM), so everything here is unit tested.
//
// Links keep everything after "#": browsers do not send that part to the server, so a shared link does not
// end up in the hosting logs. It is still readable by whoever gets the link.

import { isInArea, isValidTripId } from "../worker/transitous";

// A stop (our station ID, e.g. "de:05314:61101"), a named point (an address, a landmark, a point picked on
// the map), or the phone's position at search time ("here": never written into a link).
export type EndRef =
  | { kind: "stop"; id: string; name: string }
  | { kind: "spot"; name: string; lat: number; lon: number; what: "address" | "place" | "pin" }
  | { kind: "here" };

// The route search as a link carries it: both ends, the time ("now", or a UTC minute) and whether that is
// leaving or arriving, plus the travel settings as their query fields.
export interface RouteRef {
  from: EndRef | null;
  to: EndRef | null;
  time: string | null; // "2026-10-24T17:00Z"; null: now
  arriveBy: boolean;
  prefs: Record<string, string>;
  // An earlier / later page of that search ("LATER|1793003700", the planner's page cursor), so a connection
  // found with "Later" opens again from a link; absent for the first page.
  page?: string;
}

export type View =
  | { kind: "stop"; id: string }
  | { kind: "near" } // nearby stops: needs the location again, so it never goes into a link
  | { kind: "trip"; tripId: string; line: string; color: string }
  | { kind: "place"; spot: Extract<EndRef, { kind: "spot" }> }
  | { kind: "route"; route: RouteRef }
  | { kind: "journey"; route: RouteRef; key: string };

// Our station IDs (stationKey in stops.ts): "de:05314:61101", "de:05111:18235_G", "000008075944".
const STATION_ID = /^[A-Za-z0-9:._-]{1,60}$/;
const NAME_MAX = 80;
const COLOR = /^#[0-9a-f]{6}$/i;
const LINE = /^[\p{L}\p{N} ./+-]{1,12}$/u;
const TIME = /^20\d{2}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\dZ$/;
// A real UTC minute in that form (not 30 February or hour 29): it reads back as the same text. How old it may
// be is not checked here; an old link is still a link (the route panel searches from now instead).
const isTime = (s: string): boolean => {
  if (!TIME.test(s)) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 16) + "Z" === s;
};
const PAGE = /^(EARLIER|LATER)\|\d{10}$/;
const KEY_MAX = 400;
const PREF_NAMES = new Set(["modes", "maxTransfers", "extra", "walk"]);
const PREF_VALUE = /^[a-z0-9]{1,4}$/;

export const isStationId = (id: string): boolean => STATION_ID.test(id);

function cleanName(name: string | null): string | null {
  if (name === null) return null;
  const s = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return s && s.length <= NAME_MAX ? s : null;
}

// Five decimals: about a metre, plenty for an address, and it keeps links short.
const coord = (n: number) => n.toFixed(5);

// "s|de:05314:61101|Bonn Hbf", "a|50.72177,7.11402|Adenauerallee 160", "here". The type letter: s stop,
// a address, p place, m point picked on the map.
function writeEnd(end: EndRef): string {
  if (end.kind === "here") return "here";
  const name = end.name.replaceAll("|", "/").slice(0, NAME_MAX);
  if (end.kind === "stop") return `s|${end.id}|${name}`;
  const type = end.what === "address" ? "a" : end.what === "place" ? "p" : "m";
  return `${type}|${coord(end.lat)},${coord(end.lon)}|${name}`;
}

function readEnd(text: string | null): EndRef | null {
  if (text === null) return null;
  if (text === "here") return { kind: "here" };
  const parts = text.split("|");
  if (parts.length !== 3) return null;
  const [type, where, rawName] = parts as [string, string, string];
  const name = cleanName(rawName);
  if (!name) return null;
  if (type === "s") return isStationId(where) ? { kind: "stop", id: where, name } : null;
  const at = /^(\d{2}\.\d{1,6}),(\d{1,2}\.\d{1,6})$/.exec(where);
  if (!at || !"apm".includes(type) || type.length !== 1) return null;
  const lat = Number(at[1]);
  const lon = Number(at[2]);
  if (!isInArea(lat, lon)) return null;
  return { kind: "spot", name, lat, lon, what: type === "a" ? "address" : type === "p" ? "place" : "pin" };
}

function writeRoute(r: RouteRef, params: URLSearchParams): void {
  if (r.from) params.set("from", writeEnd(r.from));
  if (r.to) params.set("to", writeEnd(r.to));
  if (r.time) params.set("at", r.time);
  if (r.arriveBy) params.set("arr", "1");
  for (const [name, value] of Object.entries(r.prefs)) params.set(name, value);
  if (r.page) params.set("pg", r.page);
}

function readRoute(params: URLSearchParams): RouteRef | null {
  const from = readEnd(params.get("from"));
  const to = readEnd(params.get("to"));
  if ((params.has("from") && !from) || (params.has("to") && !to)) return null;
  const time = params.get("at");
  if (time !== null && !isTime(time)) return null;
  const arr = params.get("arr");
  if (arr !== null && arr !== "1") return null;
  const prefs: Record<string, string> = {};
  for (const name of PREF_NAMES) {
    const v = params.get(name);
    if (v === null) continue;
    if (!PREF_VALUE.test(v)) return null;
    prefs[name] = v;
  }
  const page = params.get("pg");
  if (page !== null && !PAGE.test(page)) return null;
  return { from, to, time, arriveBy: arr === "1", prefs, ...(page ? { page } : {}) };
}

// The part after "#" for a view ("" for none, and for views that cannot go into a link). Version 1.
export function viewHash(view: View | null): string {
  if (!view || view.kind === "near") return "";
  const params = new URLSearchParams({ v: "1" });
  switch (view.kind) {
    case "stop":
      params.set("stop", view.id);
      break;
    case "trip":
      params.set("trip", view.tripId);
      params.set("line", view.line);
      params.set("color", view.color.slice(1));
      break;
    case "place":
      params.set("place", writeEnd(view.spot));
      break;
    case "route":
      params.set("route", "1");
      writeRoute(view.route, params);
      break;
    case "journey":
      params.set("route", "1");
      writeRoute(view.route, params);
      params.set("j", view.key);
      break;
  }
  return params.toString();
}

// A view from the part after "#", or null when it is empty, from another version, or anything in it is wrong.
export function parseViewHash(hash: string): View | null {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!text || text.length > 2000) return null;
  const params = new URLSearchParams(text);
  if (params.get("v") !== "1") return null;
  const stop = params.get("stop");
  if (stop !== null) return isStationId(stop) ? { kind: "stop", id: stop } : null;
  const trip = params.get("trip");
  if (trip !== null) {
    const line = cleanName(params.get("line"));
    const color = `#${params.get("color") ?? ""}`;
    if (!isValidTripId(trip) || !line || !LINE.test(line) || !COLOR.test(color)) return null;
    return { kind: "trip", tripId: trip, line, color };
  }
  const place = params.get("place");
  if (place !== null) {
    const spot = readEnd(place);
    return spot?.kind === "spot" ? { kind: "place", spot } : null;
  }
  if (params.get("route") === "1") {
    const route = readRoute(params);
    if (!route) return null;
    const key = params.get("j");
    if (key === null) return { kind: "route", route };
    return key.length > 0 && key.length <= KEY_MAX ? { kind: "journey", route, key } : null;
  }
  return null;
}

// The same view for someone else: My location is left out (it is this phone's position, not theirs).
export function shareableView(view: View): View {
  if (view.kind !== "route" && view.kind !== "journey") return view;
  const strip = (e: EndRef | null) => (e?.kind === "here" ? null : e);
  return { ...view, route: { ...view.route, from: strip(view.route.from), to: strip(view.route.to) } };
}

export const sameEnd = (a: EndRef | null, b: EndRef | null): boolean =>
  a !== null && b !== null && writeEnd(a) === writeEnd(b);
