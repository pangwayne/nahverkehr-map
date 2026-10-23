// Turns Transitous platforms into stations, and finds the stations near a point.
// Pure functions only (no DOM, no fetch), so everything here is unit tested.

import type { StopPlace } from "./api";
import { type LonLat, distanceM } from "./geo";
import { plateName, townName } from "./names";

const GERMAN_PREFIX = "de-DELFI_";

// Some stations exist under two IDs with the same name (Bonn Hbf does). Merge those when this close.
const SAME_NAME_MERGE_M = 400;

// Any kind of train: S-Bahn, regional, long-distance, night. Drawn as a bigger dot on the map.
const TRAIN_MODES = new Set<string>([
  "SUBURBAN",
  "REGIONAL_RAIL",
  "REGIONAL_FAST_RAIL",
  "RAIL",
  "LONG_DISTANCE",
  "HIGHSPEED_RAIL",
  "NIGHT_RAIL",
]);

export interface Station {
  id: string; // e.g. "de:05314:61101" (Bonn Hbf)
  name: string;
  lon: number;
  lat: number;
  stopIds: string[]; // its platforms; asking for any one returns the whole station
  hasTram: boolean;
  hasTrain: boolean;
}

export interface NearStation {
  station: Station;
  distanceM: number;
}

// German stop IDs carry the station inside: "de:05314:61101:2:64" = station "de:05314:61101",
// area 2, platform 64. IDs without that shape stay a station of their own.
export function stationKey(stopId: string): string | null {
  if (!stopId.startsWith(GERMAN_PREFIX)) return null;
  const local = stopId.slice(GERMAN_PREFIX.length);
  const parts = local.split(":");
  return parts.length >= 3 ? parts.slice(0, 3).join(":") : local;
}

// Group platforms into stations. Non-German duplicates (e.g. a Belgian "Bonn Hbf") are dropped,
// and same-name stations close together become one. A station sits at the average of its platforms.
export function groupStations(places: StopPlace[]): Station[] {
  const groups = new Map<string, StopPlace[]>();
  for (const p of places) {
    const key = stationKey(p.stopId);
    if (key === null) continue;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }

  // Looked up by name: comparing every station with every other is too slow for ~7,000 stations on a phone.
  const merged: { id: string; platforms: StopPlace[] }[] = [];
  const byName = new Map<string, { id: string; platforms: StopPlace[] }[]>();
  for (const [id, platforms] of groups) {
    const center = average(platforms);
    const name = platforms[0]!.name;
    const sameName = byName.get(name) ?? [];
    const twin = sameName.find((m) => distanceM(average(m.platforms), center) <= SAME_NAME_MERGE_M);
    if (twin) {
      twin.platforms.push(...platforms);
      continue;
    }
    const entry = { id, platforms: [...platforms] };
    merged.push(entry);
    sameName.push(entry);
    byName.set(name, sameName);
  }

  return merged.map(({ id, platforms }) => {
    const [lon, lat] = average(platforms);
    return {
      id,
      name: platforms[0]!.name,
      lon,
      lat,
      stopIds: platforms.map((p) => p.stopId),
      hasTram: platforms.some((p) => p.modes?.some((m) => m === "TRAM" || m === "SUBWAY") ?? false),
      hasTrain: platforms.some((p) => p.modes?.some((m) => TRAIN_MODES.has(m)) ?? false),
    };
  });
}

function average(places: StopPlace[]): LonLat {
  return [
    places.reduce((sum, p) => sum + p.lon, 0) / places.length,
    places.reduce((sum, p) => sum + p.lat, 0) / places.length,
  ];
}

// A stop from somewhere else (e.g. a stop on a trip's route) -> our station for it: by platform ID,
// else the nearest station with the same name within `maxM` meters. Null if there is none.
export function matchStation(
  stations: Station[],
  stop: { stopId: string | null; name: string; lon: number; lat: number },
  maxM = 300,
): Station | null {
  if (stop.stopId) {
    const byId = stations.find((s) => s.stopIds.includes(stop.stopId!));
    if (byId) return byId;
  }
  const here: LonLat = [stop.lon, stop.lat];
  let best: Station | null = null;
  let bestM = maxM;
  for (const s of stations) {
    if (s.name !== stop.name) continue;
    const d = distanceM(here, [s.lon, s.lat]);
    if (d <= bestM) {
      best = s;
      bestM = d;
    }
  }
  return best;
}

// The closest stations within `maxM` meters, nearest first, at most `limit`.
export function nearestStations(
  stations: Station[],
  lon: number,
  lat: number,
  maxM: number,
  limit: number,
): NearStation[] {
  const here: LonLat = [lon, lat];
  return stations
    .map((station) => ({ station, distanceM: distanceM(here, [station.lon, station.lat]) }))
    .filter((s) => s.distanceM <= maxM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

// Short forms used in stop names, so "Hauptbahnhof" finds "Bonn Hbf" and "Straße" finds "Str.".
const SHORT_FORMS: [string, string][] = [
  ["hauptbahnhof", "hbf"],
  ["bahnhof", "bf"],
  ["strasse", "str"],
  ["platz", "pl"],
];

// Lower case, no accents ("ü" -> "u", "ß" -> "ss"), long words shortened like in the stop names.
export function searchText(text: string): string {
  let s = text.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [long, short] of SHORT_FORMS) s = s.replaceAll(long, short);
  return s;
}

function words(text: string): string[] {
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}

// The ways one typed word can appear in a stop name: itself, or the short form of a word being typed
// ("hauptbah" may become "hbf").
function variants(typed: string): string[] {
  const out = [typed];
  if (typed.length >= 4) {
    for (const [long, short] of SHORT_FORMS) if (long.startsWith(typed)) out.push(short);
  }
  return out;
}

// What a station can be found by: its name, with the plate ("K Neumarkt") and with the town spelled
// out ("Düsseldorf Wehrhahn" for "D-Wehrhahn S"). Worked out once per station, not on every key press.
const searchIndex = new WeakMap<Station, { text: string; words: string[] }>();

function searchable(station: Station): { text: string; words: string[] } {
  let entry = searchIndex.get(station);
  if (!entry) {
    const forms = new Set([station.name, plateName(station.name), townName(station.name)]);
    const text = [...forms].map(searchText).join(" ");
    entry = { text, words: words(text) };
    searchIndex.set(station, entry);
  }
  return entry;
}

// Stations whose name contains every typed word, best first: a whole name word beats a name word
// starting with the typed word, which beats one containing it; then shorter names. The town counts like any other word,
// so "bonn hbf" finds Bonn Hbf and not Köln Hbf.
export function searchStations(stations: Station[], query: string, limit: number): Station[] {
  const typed = words(searchText(query));
  if (typed.length === 0) return [];

  const hits: { station: Station; rank: number }[] = [];
  for (const station of stations) {
    const { text: name, words: nameWords } = searchable(station);
    let rank = 0;
    let ok = true;
    for (const [i, w] of typed.entries()) {
      const forms = variants(w);
      const atStart = forms.some((f) => nameWords.some((nw) => nw.startsWith(f)));
      if (!atStart && !forms.some((f) => f.length >= 3 && name.includes(f))) {
        ok = false;
        break;
      }
      if (!atStart) rank += i === 0 ? 2 : 1;
      else if (!forms.some((f) => nameWords.includes(f))) rank += 0.5; // "k" is the whole plate in K-Neumarkt, only the start of Kuhweg
    }
    if (ok) hits.push({ station, rank });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.station.name.length - b.station.name.length || a.station.name.localeCompare(b.station.name))
    .slice(0, limit)
    .map((h) => h.station);
}
