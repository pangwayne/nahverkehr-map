// Turns Transitous platforms into stations, and finds the stations near a point.
// Pure functions only (no DOM, no fetch), so everything here is unit tested.

import type { StopPlace } from "./api";
import { type LonLat, distanceM } from "./geo";

const GERMAN_PREFIX = "de-DELFI_";

// Some stations exist under two IDs with the same name (Bonn Hbf does). Merge those when this close.
const SAME_NAME_MERGE_M = 400;

export interface Station {
  id: string; // e.g. "de:05314:61101" (Bonn Hbf)
  name: string;
  lon: number;
  lat: number;
  stopIds: string[]; // its platforms; asking for any one returns the whole station
  hasTram: boolean;
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

  const merged: { id: string; platforms: StopPlace[] }[] = [];
  for (const [id, platforms] of groups) {
    const center = average(platforms);
    const twin = merged.find(
      (m) => m.platforms[0]!.name === platforms[0]!.name && distanceM(average(m.platforms), center) <= SAME_NAME_MERGE_M,
    );
    if (twin) twin.platforms.push(...platforms);
    else merged.push({ id, platforms: [...platforms] });
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
