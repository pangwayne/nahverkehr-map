// Cloudflare Worker: handles /api/* requests and adds security headers to the pages.
// The built JS/CSS under /assets/ never reach it (wrangler.jsonc).
// Free plan rule: keep this thin (forward + cache only, no heavy parsing).

import {
  DEPARTURES_BUCKET_MS,
  TRIP_BUCKET_MS,
  USER_AGENT,
  bucketStart,
  buildDeparturesUrl,
  buildStopsUrl,
  buildTripUrl,
  isValidStopId,
  isValidTripId,
} from "./transitous";

// If Transitous fails, serve the last good copy for up to this long (marked as stale).
const STALE_LIMIT_S = 180;
const UPSTREAM_TIMEOUT_MS = 10_000;

// Stops change only with the timetable: one shared copy per day, an old one is fine for a week.
const DAY_S = 86_400;
const STOPS_STALE_LIMIT_S = 7 * DAY_S;
const STOPS_BROWSER_MAX_AGE_S = 6 * 3600;

const LIVE_BROWSER_MAX_AGE_S = 10;

// Sent with every page and API answer.
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // Location only for this site itself ("My location"); nothing else is used.
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=(), payment=(), usb=()",
};

// What a page may load: our own files, OpenFreeMap (tiles, fonts, icons) and the portrait on
// www.pangwayne.com. MapLibre needs blob: for its worker and images. The nonce lets Cloudflare's injected
// bot-check script run (Cloudflare copies it from this header), while any other inline script is blocked.
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org https://www.pangwayne.com",
    "connect-src 'self' https://tiles.openfreemap.org",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return withPageHeaders(await env.ASSETS.fetch(request));
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withSecurityHeaders(
        Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } }),
      );
    }
    return withSecurityHeaders(await api(url, ctx));
  },
} satisfies ExportedHandler<Env>;

async function api(url: URL, ctx: ExecutionContext): Promise<Response> {
  const base = `${url.origin}${url.pathname}`;

  if (url.pathname === "/api/health") {
    return Response.json({ ok: true, time: new Date().toISOString() });
  }

  if (url.pathname === "/api/stops") {
    return cachedProxy(ctx, {
      upstreamUrl: buildStopsUrl(),
      bucketKey: `${base}?fresh`,
      latestKey: `${base}?latest`,
      freshS: DAY_S,
      staleS: STOPS_STALE_LIMIT_S,
      browserMaxAgeS: STOPS_BROWSER_MAX_AGE_S,
    });
  }

  if (url.pathname === "/api/departures") {
    const stopId = url.searchParams.get("stopId") ?? "";
    if (!isValidStopId(stopId)) {
      return Response.json({ error: "invalid stopId" }, { status: 400 });
    }
    const start = bucketStart(Date.now(), DEPARTURES_BUCKET_MS);
    const id = encodeURIComponent(stopId);
    return cachedProxy(ctx, {
      upstreamUrl: buildDeparturesUrl(stopId),
      bucketKey: `${base}?stopId=${id}&bucket=${start}`,
      latestKey: `${base}?stopId=${id}&latest`,
      freshS: DEPARTURES_BUCKET_MS / 1000,
      staleS: STALE_LIMIT_S,
      browserMaxAgeS: LIVE_BROWSER_MAX_AGE_S,
    });
  }

  if (url.pathname === "/api/trip") {
    const tripId = url.searchParams.get("tripId") ?? "";
    if (!isValidTripId(tripId)) {
      return Response.json({ error: "invalid tripId" }, { status: 400 });
    }
    const start = bucketStart(Date.now(), TRIP_BUCKET_MS);
    const id = encodeURIComponent(tripId);
    return cachedProxy(ctx, {
      upstreamUrl: buildTripUrl(tripId),
      bucketKey: `${base}?tripId=${id}&bucket=${start}`,
      latestKey: `${base}?tripId=${id}&latest`,
      freshS: TRIP_BUCKET_MS / 1000,
      staleS: STALE_LIMIT_S,
      browserMaxAgeS: LIVE_BROWSER_MAX_AGE_S,
    });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

// Copy a response so its headers can be changed (responses from fetch/ASSETS are read-only).
function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}

// `npm run dev` injects CSS as inline styles, which the CSP would block. Build, preview and tests keep it.
const VITE_DEV = (import.meta as { env?: { MODE?: string } }).env?.MODE === "development";

function withPageHeaders(res: Response): Response {
  const out = withSecurityHeaders(res);
  if (!VITE_DEV && out.headers.get("Content-Type")?.startsWith("text/html")) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    out.headers.set("Content-Security-Policy", contentSecurityPolicy(btoa(String.fromCharCode(...bytes))));
  }
  return out;
}

interface ProxyOptions {
  upstreamUrl: string;
  bucketKey: string; // shared by everyone in the same time bucket
  latestKey: string; // last good copy, used when Transitous fails
  freshS: number;
  staleS: number;
  browserMaxAgeS: number;
}

async function cachedProxy(ctx: ExecutionContext, opts: ProxyOptions): Promise<Response> {
  const cache = caches.default;
  const bucketKey = new Request(opts.bucketKey);
  const latestKey = new Request(opts.latestKey);

  const hit = await cache.match(bucketKey);
  if (hit) return forClient(hit, "HIT", opts.browserMaxAgeS);

  try {
    const upstream = await fetch(opts.upstreamUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) throw new Error(`Transitous answered ${upstream.status}`);

    // Buffer the bytes without parsing them (cheap), so we can store two copies and answer.
    const body = await upstream.arrayBuffer();
    const fetchedAt = new Date().toISOString();
    const stored = (maxAge: number) =>
      new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${maxAge}`,
          "X-Fetched-At": fetchedAt,
        },
      });

    ctx.waitUntil(cache.put(bucketKey, stored(opts.freshS)));
    ctx.waitUntil(cache.put(latestKey, stored(opts.staleS)));
    return forClient(stored(0), "MISS", opts.browserMaxAgeS);
  } catch (err) {
    const last = await cache.match(latestKey);
    if (last) return forClient(last, "STALE", opts.browserMaxAgeS);
    // The details go to the Cloudflare logs only, not to the public answer.
    console.error("upstream failed", opts.upstreamUrl, err);
    return Response.json(
      { error: "upstream unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// Copy a cached response for the browser: short browser cache, plus debug headers.
function forClient(res: Response, cacheState: "HIT" | "MISS" | "STALE", maxAgeS: number): Response {
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", `public, max-age=${maxAgeS}`);
  out.headers.set("X-Cache", cacheState);
  return out;
}
