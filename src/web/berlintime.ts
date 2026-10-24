// Clock times for the route search. Transitous and our /api/plan speak UTC; people pick and read Bonn
// (Europe/Berlin) time, wherever their phone is. Pure functions, unit tested, including the two days a
// year when Berlin's clock jumps.

// The form /api/plan accepts: "2026-10-24T17:00Z" (UTC, whole minutes).
export function planTime(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString().slice(0, 16) + "Z";
}

const berlinParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Berlin's wall clock at `ms`, for filling in the date and time fields: { date: "2026-10-24", time: "19:00" }.
export function berlinDateTime(ms: number): { date: string; time: string } {
  const p = Object.fromEntries(berlinParts.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p["year"]}-${p["month"]}-${p["day"]}`, time: `${p["hour"]}:${p["minute"]}` };
}

// Minutes Berlin is ahead of UTC at `ms` (60 in winter, 120 in summer).
function berlinOffsetMin(ms: number): number {
  const { date, time } = berlinDateTime(ms);
  const wall = Date.parse(`${date}T${time}Z`);
  return Math.round((wall - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

export interface PickedTime {
  ms: number;
  // "twice": the clock passed this time twice (last Sunday of October, 02:00-02:59); the first one is used.
  // "skipped": the clock jumped over it (last Sunday of March, 02:00-02:59); the same time one hour later
  // is used, as the clock shows it after the jump.
  note: "twice" | "skipped" | null;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// A date and time picked in the form ("2026-10-25", "02:30"), read as Berlin time. Null if malformed or
// not a real date.
export function fromBerlin(date: string, time: string): PickedTime | null {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (new Date(wall).toISOString().slice(0, 10) !== date) return null; // "2026-02-30"

  // Berlin is 1 or 2 hours ahead; try the offsets in force half a day either side and keep the ones
  // that really show this wall time.
  const offsets = [...new Set([berlinOffsetMin(wall - 12 * 3600_000), berlinOffsetMin(wall + 12 * 3600_000)])];
  const fits = offsets
    .map((off) => wall - off * 60_000)
    .filter((ms) => berlinOffsetMin(ms) * 60_000 === wall - ms)
    .sort((a, b) => a - b);
  if (fits.length === 1) return { ms: fits[0]!, note: null };
  if (fits.length > 1) return { ms: fits[0]!, note: "twice" };
  // In the gap: read with the offset from before the jump, which lands just after it.
  return { ms: wall - Math.min(...offsets) * 60_000, note: "skipped" };
}
