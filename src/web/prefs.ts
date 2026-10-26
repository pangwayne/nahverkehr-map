// Travel settings for the route search: which vehicles, how many changes, extra time to change, and how far
// to walk to the first and from the last stop. The defaults search like before; the choice is kept in this
// browser only (localStorage) and sent with a search as a few query fields.
// Pure apart from loadPrefs / savePrefs, so the rest is unit tested.

export interface TravelPrefs {
  bus: boolean;
  tram: boolean; // trams, Stadtbahn, U-Bahn
  sbahn: boolean;
  train: boolean; // regional trains (RE, RB)
  maxTransfers: number | null; // 0-3; null: as many as needed
  extraMin: number; // 0, 5 or 10 minutes extra for each change
  walkMin: number; // 5, 10 or 15 minutes at most for the first and last walk (15: the planner's own limit)
}

export const DEFAULT_PREFS: TravelPrefs = {
  bus: true,
  tram: true,
  sbahn: true,
  train: true,
  maxTransfers: null,
  extraMin: 0,
  walkMin: 15,
};

export const TRANSFER_CHOICES = [null, 0, 1, 2, 3] as const;
export const EXTRA_CHOICES = [0, 5, 10] as const;
export const WALK_CHOICES = [15, 10, 5] as const;

const STORAGE_KEY = "prefs";

// The query fields the Worker reads (parsePlanPrefs in src/worker/transitous.ts); only what differs from
// the default, so a search with default settings looks exactly like one without.
export function prefsQuery(p: TravelPrefs): Record<string, string> {
  const out: Record<string, string> = {};
  const letters = [p.bus ? "b" : "", p.train ? "r" : "", p.sbahn ? "s" : "", p.tram ? "t" : ""].join("");
  if (letters.length < 4) out["modes"] = letters;
  if (p.maxTransfers !== null) out["maxTransfers"] = String(p.maxTransfers);
  if (p.extraMin) out["extra"] = String(p.extraMin);
  if (p.walkMin !== DEFAULT_PREFS.walkMin) out["walk"] = String(p.walkMin);
  return out;
}

// Settings back from query fields (a link, saved storage). Anything unknown or out of range keeps its default.
export function prefsFromQuery(q: Record<string, string>): TravelPrefs {
  const p = { ...DEFAULT_PREFS };
  const modes = q["modes"];
  if (typeof modes === "string" && /^[brst]{1,4}$/.test(modes)) {
    p.bus = modes.includes("b");
    p.train = modes.includes("r");
    p.sbahn = modes.includes("s");
    p.tram = modes.includes("t");
  }
  const pick = <T extends number | null>(value: string | undefined, choices: readonly T[]): T | undefined =>
    choices.find((c) => c !== null && String(c) === value);
  const transfers = pick(q["maxTransfers"], TRANSFER_CHOICES);
  if (transfers !== undefined) p.maxTransfers = transfers;
  p.extraMin = pick(q["extra"], EXTRA_CHOICES) ?? p.extraMin;
  p.walkMin = pick(q["walk"], WALK_CHOICES) ?? p.walkMin;
  return p;
}

// How many settings differ from the default (shown next to "Options").
export function changedPrefs(p: TravelPrefs): number {
  const q = prefsQuery(p);
  return Object.keys(q).length;
}

// At least one kind of vehicle must stay on, else there is nothing to search for.
export function anyMode(p: TravelPrefs): boolean {
  return p.bus || p.tram || p.sbahn || p.train;
}

export function loadPrefs(): TravelPrefs {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PREFS };
    const fields = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
    const p = prefsFromQuery(fields);
    return anyMode(p) ? p : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS }; // storage blocked or broken
  }
}

export function savePrefs(p: TravelPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefsQuery(p)));
  } catch {
    // Storage blocked: the settings last until the page is closed.
  }
}
