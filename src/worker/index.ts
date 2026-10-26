// Cloudflare Worker: handles /api/* requests and adds security headers to the pages.
// The built JS/CSS under /assets/ never reach it (wrangler.jsonc).
// Free plan rule: keep this thin (forward + cache only, no heavy parsing).

import {
  AREA_VERSION,
  DEPARTURES_BUCKET_MS,
  TRIP_BUCKET_MS,
  USER_AGENT,
  bucketStart,
  buildDeparturesUrl,
  buildGeocodeUrl,
  buildPlanUrl,
  buildStopsUrl,
  buildTripUrl,
  isValidDeparturesCursor,
  isValidStopId,
  isValidTripId,
  parseGeocodeQuery,
  parsePlanQuery,
  prefsParams,
} from "./transitous";

// If Transitous fails, serve the last good copy for up to this long (marked as stale).
const STALE_LIMIT_S = 180;
const UPSTREAM_TIMEOUT_MS = 10_000;

// Stops change only with the timetable: one shared copy per day, an old one is fine for a week.
const DAY_S = 86_400;
const STOPS_STALE_LIMIT_S = 7 * DAY_S;
const STOPS_BROWSER_MAX_AGE_S = 6 * 3600;

const LIVE_BROWSER_MAX_AGE_S = 10;

// A route search is shared for its minute (the browser sends whole minutes). Its last good copy is kept
// only briefly: an old plan lists trains that have already left.
const PLAN_FRESH_S = 60;
const PLAN_STALE_LIMIT_S = 120;

// Addresses and places hardly change: one shared answer per typed text for a day.
const GEOCODE_FRESH_S = DAY_S;
const GEOCODE_STALE_LIMIT_S = 7 * DAY_S;
const GEOCODE_BROWSER_MAX_AGE_S = 3600;

// A failed answer is remembered too, so repeated requests for it do not all reach Transitous:
// an unknown stop or trip for a while, an outage only briefly (it may be over soon).
const NOT_FOUND_CACHE_S = 600;
const OUTAGE_CACHE_S = 15;

// Upstream requests per visitor: generous for a person tapping around (a board can fetch up to 13
// at once), low enough to stop a script from making up IDs to get past the shared cache.
// The limits live in wrangler.jsonc: API_LIMIT for stops, departures and trips, PLAN_LIMIT (lower) for
// route searches, which cost Transitous the most and rarely come from the shared cache.
const RATE_LIMITED_RETRY_S = 60;

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
    const limiter = url.pathname === "/api/plan" ? env.PLAN_LIMIT : env.API_LIMIT;
    return withSecurityHeaders(await api(url, upstreamAllowed(request, limiter), ctx, request.headers.get("If-None-Match")));
  },
} satisfies ExportedHandler<Env>;

// Asks the rate limiter, only when an answer has to come from Transitous. The visitor's IP is the
// key (there is nothing else to tell visitors apart); the count lasts one minute and is not logged.
function upstreamAllowed(request: Request, limiter: RateLimit | undefined): () => Promise<boolean> {
  return async () => {
    if (!limiter) return true; // tests and `npm run dev` without the binding
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key: ip });
    return success;
  };
}

// `ifNoneMatch`: the browser's If-None-Match header; the stop list answers 304 when it still has that copy.
async function api(
  url: URL,
  allowed: () => Promise<boolean>,
  ctx: ExecutionContext,
  ifNoneMatch: string | null = null,
): Promise<Response> {
  const base = `${url.origin}${url.pathname}`;

  if (url.pathname === "/api/health") {
    return Response.json({ ok: true, time: new Date().toISOString() });
  }

  if (url.pathname === "/api/stops") {
    // The list is ~370 KB even compressed. A browser that still has today's copy is told so (304) instead of
    // getting it again. Trimming the list here would cost more CPU time than the free plan allows.
    return cachedProxy(ctx, allowed, {
      upstreamUrl: buildStopsUrl(),
      bucketKey: `${base}?area=${AREA_VERSION}&fresh`,
      latestKey: `${base}?area=${AREA_VERSION}&latest`,
      failKey: `${base}?area=${AREA_VERSION}&failed`,
      freshS: DAY_S,
      staleS: STOPS_STALE_LIMIT_S,
      browserMaxAgeS: STOPS_BROWSER_MAX_AGE_S,
      ifNoneMatch,
    });
  }

  if (url.pathname === "/api/geocode") {
    const q = parseGeocodeQuery(url.searchParams);
    if (!q) return Response.json({ error: "invalid search" }, { status: 400 });
    const key = new URLSearchParams({ text: q.text, lang: q.lang });
    return cachedProxy(ctx, allowed, {
      upstreamUrl: buildGeocodeUrl(q),
      bucketKey: `${base}?${key}&fresh`,
      latestKey: `${base}?${key}&latest`,
      failKey: `${base}?${key}&failed`,
      freshS: GEOCODE_FRESH_S,
      staleS: GEOCODE_STALE_LIMIT_S,
      browserMaxAgeS: GEOCODE_BROWSER_MAX_AGE_S,
    });
  }

  if (url.pathname === "/api/departures") {
    const stopId = url.searchParams.get("stopId") ?? "";
    if (!isValidStopId(stopId)) {
      return Response.json({ error: "invalid stopId" }, { status: 400 });
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !isValidDeparturesCursor(cursor, Date.now())) {
      return Response.json({ error: "invalid cursor" }, { status: 400 });
    }
    const start = bucketStart(Date.now(), DEPARTURES_BUCKET_MS);
    const id = encodeURIComponent(stopId) + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    return cachedProxy(ctx, allowed, {
      upstreamUrl: buildDeparturesUrl(stopId, cursor),
      bucketKey: `${base}?stopId=${id}&bucket=${start}`,
      latestKey: `${base}?stopId=${id}&latest`,
      failKey: `${base}?stopId=${id}&failed`,
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
    return cachedProxy(ctx, allowed, {
      upstreamUrl: buildTripUrl(tripId),
      bucketKey: `${base}?tripId=${id}&bucket=${start}`,
      latestKey: `${base}?tripId=${id}&latest`,
      failKey: `${base}?tripId=${id}&failed`,
      freshS: TRIP_BUCKET_MS / 1000,
      staleS: STALE_LIMIT_S,
      browserMaxAgeS: LIVE_BROWSER_MAX_AGE_S,
    });
  }

  if (url.pathname === "/api/plan") {
    const q = parsePlanQuery(url.searchParams, Date.now());
    if (!q) return Response.json({ error: "invalid route search" }, { status: 400 });
    // Built from the checked fields only, so extra or reordered parameters share one cache entry. Travel
    // settings change the answer, so they are part of it (defaults are left out).
    const key = new URLSearchParams({ from: q.from, to: q.to, time: q.time, arriveBy: q.arriveBy ? "1" : "0" });
    if (q.cursor) key.set("cursor", q.cursor);
    for (const [name, value] of Object.entries(prefsParams(q.prefs))) key.set(name, value);
    return cachedProxy(ctx, allowed, {
      upstreamUrl: buildPlanUrl(q),
      bucketKey: `${base}?${key}&fresh`,
      latestKey: `${base}?${key}&latest`,
      failKey: `${base}?${key}&failed`,
      freshS: PLAN_FRESH_S,
      staleS: PLAN_STALE_LIMIT_S,
      browserMaxAgeS: PLAN_FRESH_S,
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
  failKey: string; // a recent failure, so it is not asked for again right away
  freshS: number;
  staleS: number;
  browserMaxAgeS: number;
  ifNoneMatch?: string | null; // set: answers carry an ETag, and a matching request gets 304
}

export type Failure = "notFound" | "outage";

// A 4xx answer means Transitous does not know the ID (made up, or a trip that is long gone).
// Everything else (5xx, too many requests, timeouts) may be over soon.
export function failureKind(status: number | null): Failure {
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429 ? "notFound" : "outage";
}

async function cachedProxy(ctx: ExecutionContext, allowed: () => Promise<boolean>, opts: ProxyOptions): Promise<Response> {
  const cache = caches.default;
  const bucketKey = new Request(opts.bucketKey);
  const latestKey = new Request(opts.latestKey);
  const failKey = new Request(opts.failKey);

  const hit = await cache.match(bucketKey);
  if (hit) return forClient(hit, "HIT", opts.browserMaxAgeS, opts.ifNoneMatch);

  // Failed a moment ago: answer the same way without asking Transitous again.
  const failed = await cache.match(failKey);
  if (failed) return failedAnswer(cache, latestKey, failed.headers.get("X-Failure") as Failure, opts.browserMaxAgeS);

  if (!(await allowed())) {
    const last = await cache.match(latestKey);
    if (last) return forClient(last, "STALE", opts.browserMaxAgeS);
    return Response.json(
      { error: "too many requests" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(RATE_LIMITED_RETRY_S) } },
    );
  }

  let status: number | null = null;
  try {
    const upstream = await fetch(opts.upstreamUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    status = upstream.status;
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
    return forClient(stored(0), "MISS", opts.browserMaxAgeS, opts.ifNoneMatch);
  } catch (err) {
    const kind = failureKind(status);
    // The details go to the Cloudflare logs only, not to the public answer.
    console.error("upstream failed", opts.upstreamUrl, err);
    // Stored as a plain 200 marker; the real status is set when answering.
    const marker = new Response(null, {
      headers: {
        "Cache-Control": `public, max-age=${kind === "notFound" ? NOT_FOUND_CACHE_S : OUTAGE_CACHE_S}`,
        "X-Failure": kind,
      },
    });
    ctx.waitUntil(cache.put(failKey, marker));
    return failedAnswer(cache, latestKey, kind, opts.browserMaxAgeS);
  }
}

// The last good copy if there is one; else 404 for an unknown ID, 502 for an outage.
async function failedAnswer(cache: Cache, latestKey: Request, kind: Failure, maxAgeS: number): Promise<Response> {
  const last = await cache.match(latestKey);
  if (last) return forClient(last, "STALE", maxAgeS);
  return kind === "notFound"
    ? Response.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: "upstream unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
}

// Copy a cached response for the browser: short browser cache, plus debug headers. With `ifNoneMatch`
// (undefined: no ETags for this kind), the copy gets an ETag from when it was fetched, and a browser that
// already has that copy gets an empty 304 instead.
function forClient(
  res: Response,
  cacheState: "HIT" | "MISS" | "STALE",
  maxAgeS: number,
  ifNoneMatch?: string | null,
): Response {
  const fetchedAt = res.headers.get("X-Fetched-At");
  const etag = ifNoneMatch !== undefined && fetchedAt ? `"${fetchedAt}"` : null;
  const headers = { "Cache-Control": `public, max-age=${maxAgeS}`, "X-Cache": cacheState };
  if (etag && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ...headers, ETag: etag, "X-Fetched-At": fetchedAt! } });
  }
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  if (etag) out.headers.set("ETag", etag);
  return out;
}
