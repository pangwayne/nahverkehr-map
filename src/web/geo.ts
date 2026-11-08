// Small geometry helpers. Coordinates are [lon, lat] like GeoJSON/MapLibre.

export type LonLat = [lon: number, lat: number];

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

// Decode a Google encoded polyline into [lon, lat] points.
export function decodePolyline(encoded: string, precision = 5): LonLat[] {
  const factor = 10 ** precision;
  const points: LonLat[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push([lon / factor, lat / factor]);
  }
  return points;
}

export function distanceM(a: LonLat, b: LonLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Compass bearing from a to b in degrees (0 = north, 90 = east).
export function bearingDeg(a: LonLat, b: LonLat): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Cumulative distance from the first point to each point, in meters.
export function cumulativeDistances(points: LonLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1]! + distanceM(points[i - 1]!, points[i]!));
  }
  return cum;
}

// The point `meters` along the line, plus the bearing of the piece it lies on.
export function pointAlong(
  points: LonLat[],
  cum: number[],
  meters: number,
): { at: LonLat; bearing: number } {
  if (points.length === 1) return { at: points[0]!, bearing: 0 };
  const total = cum[cum.length - 1]!;
  const target = Math.min(Math.max(meters, 0), total);

  // Find the piece [i, i+1] that contains the target distance.
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1]! < target) i++;

  const a = points[i]!;
  const b = points[i + 1]!;
  const pieceLength = cum[i + 1]! - cum[i]!;
  const t = pieceLength > 0 ? (target - cum[i]!) / pieceLength : 0;
  return {
    at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    bearing: bearingDeg(a, b),
  };
}
