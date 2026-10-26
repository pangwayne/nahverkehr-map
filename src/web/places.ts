// Addresses and places (landmarks, shops, parks) from the place search, as route ends.
// Pure functions only (no DOM, no fetch), so everything here is unit tested.

import type { GeocodeMatch } from "./api";
import type { EndRef } from "./endpoints";
import { isInArea } from "../worker/transitous";

export type Spot = Extract<EndRef, { kind: "spot" }>;

const NAME_MAX = 80;

// The town a match lies in: the area the geocoder marks as the default one ("Bonn").
function townOf(m: GeocodeMatch): string | null {
  return m.areas?.find((a) => a.default)?.name ?? null;
}

// Matches as spots: only addresses and places inside the stop area, each name once, town added
// ("Adenauerallee 160, Bonn"), so the same street in two towns can be told apart.
export function matchesToSpots(matches: GeocodeMatch[]): Spot[] {
  const out: Spot[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(matches) ? matches : []) {
    if (m.type !== "ADDRESS" && m.type !== "PLACE") continue;
    if (typeof m.lat !== "number" || typeof m.lon !== "number" || !isInArea(m.lat, m.lon)) continue;
    const base = typeof m.name === "string" ? m.name.replace(/\s+/g, " ").trim() : "";
    if (!base) continue;
    const town = townOf(m);
    const name = (town && !base.includes(town) ? `${base}, ${town}` : base).slice(0, NAME_MAX);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ kind: "spot", name, lat: m.lat, lon: m.lon, what: m.type === "ADDRESS" ? "address" : "place" });
  }
  return out;
}
