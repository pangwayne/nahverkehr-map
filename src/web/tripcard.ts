// Tap a departure: info card (line, destination, delay, next stop) plus its whole route on the map,
// every stop as a dot (passed stops faded), and the vehicle itself as a moving dot.
// One /api/trip request, only while the card is open, refreshed every 60 s.

import type { FeatureCollection, Point } from "geojson";
import type * as maplibregl from "maplibre-gl";
import { collectNotices } from "./alerts";
import { fetchTrip, isStale } from "./api";
import type { StopRef } from "./board";
import { badgeTextColor, delayLevel, formatCountdown, formatDelay, platformLabel, plannedPlatform } from "./departures";
import type { LonLat } from "./geo";
import { fitPoints } from "./mapfit";
import { goBack, linkTo, previousView, pushView } from "./nav";
import {
  type PanelUser,
  ageLine,
  button,
  clock,
  el,
  focusKey,
  noticeList,
  openPanel,
  ownsPanel,
  renderPanel,
  shareLink,
} from "./panel";
import { t, onLangChange } from "./i18n";
import { shortName } from "./names";
import { ageText, resetStatus, setStatus } from "./status";
import { type RouteStop, type TripProgress, type TripRoute, leaveMs, progressAt, reachMs, tripRoute } from "./trip";
import { type PreparedTrip, type VehiclePosition, prepareRoute, vehicleAt } from "./vehicles";

const POLL_MS = 60_000;
const TICK_MS = 10_000; // countdowns and "passed" stops update
const FRAME_MS = 200; // the vehicle dot moves 5 times per second: smooth enough, light on phones
const FETCH_TIMEOUT_MS = 15_000;
const STALE_AFTER_S = 120;
const UNAVAILABLE_AFTER_S = 180; // older than this, the vehicle dot is hidden (never show old data as live)
const FOCUS_MAX_ZOOM = 16;
const MAX_NOTICES = 3;

const VEHICLE_SOURCE = "trip-vehicle";
const VEHICLE_LAYER = "vehicle-dot";
const STOPS_FIRST_LAYER = "stop-dot"; // the route line goes under the stop layers
const ROUTE_SOURCE = "trip-route";
const ROUTE_STOPS_SOURCE = "trip-stops";

const BUS_COLOR = "#4a5a6a";
const TRAM_COLOR = "#1565c0";

// A departure that was tapped. Line and color are shown until the trip details arrive;
// `focus` is the stop it was tapped at, kept in view together with the vehicle.
export interface TripRef {
  tripId: string;
  line: string;
  color: string;
  focus: LonLat | null;
}

export interface TripCard {
  // `push`: a new browser history entry (not when Back / Forward / a link brings the card back).
  showTrip(ref: TripRef, push?: boolean): void;
}

// `onStopTap`: a stop dot on the shown route was tapped (opens that stop's departure board).
export function startTripCard(map: maplibregl.Map, onStopTap: (stop: StopRef) => void): TripCard {
  const user: PanelUser = { onClose: cleanUp };

  let tapped: TripRef | null = null;
  let route: TripRoute | null = null;
  let prepared: PreparedTrip | null = null;
  let progress: TripProgress | null = null;
  let fetchedAtMs: number | null = null;
  let error: string | null = null;
  let generation = 0; // bumps whenever the card changes, so late answers are ignored
  let lastPollMs = 0;
  let lastFrameMs = 0;
  let showEarlier = false; // passed stops folded away until asked
  let needsFocus = false; // move the map once, when the first trip details arrive

  map.on("load", () => {
    addLayers(map);
    requestAnimationFrame(frame);
  });

  // A stop on the route: open its departure board, unless the vehicle or a regular stop dot is on top
  // (a regular stop handles the tap itself; the vehicle needs nothing, its card is already open).
  map.on("click", "trip-stop-dot", (e) => {
    const above = [VEHICLE_LAYER, "stop-hit"].filter((id) => map.getLayer(id));
    if (above.length && map.queryRenderedFeatures(e.point, { layers: above }).length) return;
    const feature = e.features?.[0];
    const props = feature?.properties;
    if (!feature || typeof props?.["name"] !== "string") return;
    const [lon, lat] = (feature.geometry as Point).coordinates as [number, number];
    const stopId = typeof props["stopId"] === "string" && props["stopId"] ? props["stopId"] : null;
    onStopTap({ stopId, name: props["name"], lon, lat });
  });
  map.on("mouseenter", "trip-stop-dot", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "trip-stop-dot", () => (map.getCanvas().style.cursor = ""));

  setInterval(() => {
    if (!tapped || !ownsPanel(user)) return;
    if (document.visibilityState === "visible" && Date.now() - lastPollMs >= POLL_MS) void refresh();
    else update();
  }, TICK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && tapped && Date.now() - lastPollMs >= POLL_MS) void refresh();
  });
  onLangChange(() => {
    if (tapped && ownsPanel(user)) update();
  });

  function open(ref: TripRef): void {
    openPanel(user);
    generation++;
    tapped = ref;
    route = null;
    prepared = null;
    progress = null;
    fetchedAtMs = null;
    error = null;
    showEarlier = false;
    needsFocus = true;
    update();
    void refresh();
  }

  // Called by the panel when it closes or the stop board takes it over.
  function cleanUp(): void {
    generation++;
    tapped = null;
    route = null;
    prepared = null;
    progress = null;
    setRouteData(map, null, null);
    setVehicleData(map, null, false, 0);
    resetStatus();
  }

  // Move the vehicle dot, 5 times per second while a trip is open (the browser pauses this when hidden).
  function frame(nowMs: DOMHighResTimeStamp): void {
    requestAnimationFrame(frame);
    if (!tapped || nowMs - lastFrameMs < FRAME_MS) return;
    lastFrameMs = nowMs;
    const now = Date.now();
    setVehicleData(map, currentVehicle(now), ageS(now) > STALE_AFTER_S, progress?.delaySec ?? 0, tapped.color);
  }

  function ageS(now: number): number {
    return fetchedAtMs === null ? Infinity : Math.max(0, (now - fetchedAtMs) / 1000);
  }

  function currentVehicle(now: number): VehiclePosition | null {
    if (!prepared || ageS(now) > UNAVAILABLE_AFTER_S) return null;
    return vehicleAt(prepared, now);
  }

  // Keep the tapped stop and the vehicle in view together, clear of the panel.
  function focus(): void {
    needsFocus = false;
    const points: LonLat[] = [];
    if (tapped?.focus) points.push(tapped.focus);
    const v = currentVehicle(Date.now());
    if (v) points.push([v.lon, v.lat]);
    if (points.length) fitPoints(map, points, FOCUS_MAX_ZOOM);
  }

  async function refresh(): Promise<void> {
    if (!tapped) return;
    const gen = generation;
    lastPollMs = Date.now();
    try {
      const res = await fetchTrip(tapped.tripId, AbortSignal.timeout(FETCH_TIMEOUT_MS));
      if (gen !== generation) return;
      const r = tripRoute(res.data);
      if (!r) throw new Error("trip has no stops");
      route = r;
      prepared = prepareRoute(tapped.tripId, r);
      fetchedAtMs = res.fetchedAtMs;
      error = isStale(res) ? "stale copy from the Worker" : null;
    } catch (err) {
      if (gen !== generation) return;
      error = String(err);
    }
    update();
    if (needsFocus && route) focus();
  }

  function update(): void {
    if (!tapped) return;
    const now = Date.now();
    progress = route ? progressAt(route.stops, now) : null;
    setRouteData(map, route, progress, tapped.color);
    render(now, progress);
  }

  function render(now: number, progress: TripProgress | null): void {
    if (!tapped) return;
    const statusTitle = route ? `${route.line} → ${shortName(route.headsign)}` : t().line(tapped.line);
    const age = ageS(now);
    setStatus(statusTitle, Number.isFinite(age) ? age : null, error !== null);
    // Panel title: the line badge, then where it goes.
    const title = [
      lineBadge(route?.line ?? tapped.line, route ? routeColor(route) : tapped.color, route?.textColor ?? null),
      el("span", "", route ? shortName(route.headsign) : "…"),
    ];
    const parts: HTMLElement[] = [];
    // Opened from a board or a connection in this tab: a way back to it (the same as the browser's Back).
    const previous = previousView();
    const backLabel =
      previous?.kind === "stop" || previous?.kind === "near"
        ? t().backToDepartures
        : previous?.kind === "journey"
          ? t().routeBackToJourney
          : null;
    if (backLabel) {
      const btn = button("link-button route-back", `← ${backLabel}`, "back");
      btn.addEventListener("click", goBack);
      parts.push(btn);
    }

    if (!route || !progress) {
      parts.push(
        el("p", error ? "board-note board-error" : "board-note", error ? t().tripUnavailable : t().loadingTrip),
      );
      renderPanel(user, title, parts);
      return;
    }

    parts.push(renderSummary(route, progress, now));
    // The dot on the map is worked out, not tracked: say so while it is shown.
    if (!route.cancelled && progress.next !== null) {
      const note = el("p", "trip-estimate");
      note.append(el("strong", "", t().estimatedTitle), document.createTextNode(` ${t().estimatedBody}`));
      parts.push(note);
    }

    if (route.implausibleFrom !== null && !route.cancelled) {
      const from = shortName(route.stops[route.implausibleFrom]!.name);
      parts.push(el("p", "board-note board-warn", t().implausible(from)));
    }

    if (error && age > STALE_AFTER_S) parts.push(el("p", "board-note board-error", t().tripUnavailable));

    const notices = noticeList(collectNotices([route.alerts, ...route.stops.map((s) => s.alerts)], now), MAX_NOTICES);
    if (notices) parts.push(notices);

    // Passed stops are folded away (all but the last one), so the summary stays at the top. Before the
    // start, all earlier stops go: they are cancelled (the trip starts further along its line).
    const firstShown =
      showEarlier || progress.next === null
        ? 0
        : progress.state === "before"
          ? progress.next
          : Math.max(0, progress.next - 1);
    if (firstShown > 0) {
      const folded = route.stops.slice(0, firstShown);
      const served = folded.filter((s) => !s.cancelled).length;
      const label = served > 0 ? t().earlierStops(served) : t().cancelledStops(folded.length);
      const earlierBtn = focusKey(el("button", "link-button", label), "earlier");
      earlierBtn.addEventListener("click", () => {
        showEarlier = true;
        update();
      });
      parts.push(earlierBtn);
    }

    // The stops as a timeline in the line's colour.
    const list = el("ol", "trip-stops");
    list.style.setProperty("--line", routeColor(route));
    for (let i = firstShown; i < route.stops.length; i++) {
      list.append(renderStop(route.stops[i]!, i, progress, route, onStopTap));
    }
    parts.push(list);

    // Stays at the bottom of the panel: data age (never show old data as current) and the whole route.
    const foot = el("div", "trip-foot");
    if (Number.isFinite(age)) {
      const old = age > STALE_AFTER_S;
      foot.append(ageLine(ageText(age, old, error !== null), old || error !== null));
    }
    const actions = el("span", "foot-actions");
    const share = button("link-button", t().share, "share");
    const ref = tapped;
    const shareTitle = `${route.line} → ${shortName(route.headsign)}`;
    share.addEventListener("click", () =>
      void shareLink(linkTo({ kind: "trip", tripId: ref.tripId, line: ref.line, color: ref.color }), shareTitle),
    );
    const zoomBtn = focusKey(el("button", "link-button", t().wholeRoute), "whole-route");
    const shownRoute = route;
    zoomBtn.addEventListener("click", () => fitRoute(map, shownRoute));
    actions.append(share, zoomBtn);
    foot.append(actions);
    parts.push(foot);

    renderPanel(user, title, parts);
  }

  return {
    showTrip(ref: TripRef, push = true): void {
      if (push) pushView({ kind: "trip", tripId: ref.tripId, line: ref.line, color: ref.color });
      open(ref);
    },
  };
}

function routeColor(route: TripRoute): string {
  return route.color ?? (route.mode === "BUS" ? BUS_COLOR : TRAM_COLOR);
}

function lineBadge(line: string, color: string, textColor: string | null): HTMLElement {
  const badge = el("span", "line", line);
  badge.style.backgroundColor = color;
  badge.style.color = badgeTextColor(color, textColor);
  return badge;
}

// Two chips: how late it is, and where it is now.
function renderSummary(route: TripRoute, p: TripProgress, now: number): HTMLElement {
  const box = el("div", "trip-chips");
  if (route.cancelled) {
    box.append(el("span", "chip verylate", t().tripCancelled));
  } else if (!route.realTime) {
    box.append(el("span", "chip unknown", t().noLiveData));
  } else if (onTimetable(route, p.next ?? route.stops.length - 1)) {
    box.append(el("span", "chip unknown", t().timetableOnlyCap));
  } else {
    const min = Math.round(p.delaySec / 60);
    const text = min === 0 ? t().onTime : min > 0 ? t().minLate(min) : t().minEarly(-min);
    box.append(el("span", `chip ${delayLevel(p.delaySec, true)}`, text));
  }
  box.append(el("span", "chip where", nextText(route, p, now)));
  return box;
}

function nextText(route: TripRoute, p: TripProgress, now: number): string {
  if (p.next === null) {
    const last = route.stops[route.stops.length - 1];
    return last ? t().tripEndedAt(shortName(last.name)) : t().tripEnded;
  }
  const s = route.stops[p.next]!;
  const label = platformLabel(s.stopId, route.mode, s);
  const platform = label ? ` (${label})` : "";
  const name = shortName(s.name);
  if (p.state === "before") return t().startsAt(`${name}${platform}`, formatCountdown(leaveMs(s)!, now));
  if (p.state === "atStop") return t().atStopNow(`${name}${platform}`, formatCountdown(leaveMs(s)!, now));
  return t().nextStop(`${name}${platform}`, formatCountdown(reachMs(s)!, now));
}

// The stop's name is a button that opens its departure board, like its dot on the map.
function renderStop(
  s: RouteStop,
  i: number,
  p: TripProgress,
  route: TripRoute,
  onStopTap: (stop: StopRef) => void,
): HTMLElement {
  const passed = p.next === null || i < p.next;
  const classes = ["trip-stop", passed ? "passed" : "", i === p.next ? "next" : "", s.cancelled ? "cancelled" : ""];
  const li = el("li", classes.filter(Boolean).join(" "));

  // The time that matters for a passenger: departure, or arrival at the last stop. With live data, the planned
  // time is struck through in front when it moved.
  const leave = leaveMs(s);
  const sched = s.schedDepMs ?? s.schedArrMs;
  const time = el("span", "time");
  if (leave !== null) time.append(clock(leave, route.realTime && !s.cancelled && sched !== null ? sched : leave));
  li.append(time);
  li.append(el("span", "stop-dot")); // on the timeline: grey when passed, ringed for the next stop

  const name = focusKey(el("button", "name", shortName(s.name)), `stop-${i}`);
  (name as HTMLButtonElement).type = "button";
  const platform = platformLabel(s.stopId, route.mode, s);
  const planned = plannedPlatform(s.stopId, route.mode, s);
  if (platform) {
    name.append(
      el("small", planned ? "platform-change" : "", ` ${planned ? t().platformChanged(platform, planned) : platform}`),
    );
  }
  name.addEventListener("click", () => onStopTap({ stopId: s.stopId, name: s.name, lon: s.lon, lat: s.lat }));
  li.append(name);

  if (route.realTime && !s.cancelled && onTimetable(route, i)) {
    li.append(el("span", "delay timetable", t().timetable));
    return li;
  }
  const delaySec = leave !== null && sched !== null ? (leave - sched) / 1000 : 0;
  const delay = route.realTime && !s.cancelled ? formatDelay(delaySec) : "";
  li.append(el("span", delay ? `delay ${delayLevel(delaySec, true)}` : "delay", s.cancelled ? t().cancelled : delay));
  return li;
}

// Stop `i` shows timetable times because the live ones looked wrong (Phase 4.8).
function onTimetable(route: TripRoute, i: number): boolean {
  return route.implausibleFrom !== null && i >= route.implausibleFrom;
}

function fitRoute(map: maplibregl.Map, route: TripRoute): void {
  if (route.path.length >= 2) fitPoints(map, route.path);
}

// Ring color shows punctuality (section 5.3 of the guidelines); grey when unknown or old.
function ringColor(realTime: boolean, delaySec: number, stale: boolean): string {
  if (stale || !realTime) return "#9e9e9e";
  const late = Math.abs(delaySec);
  if (late < 60) return "#2e7d32";
  if (late < 300) return "#f57c00";
  return "#c62828";
}

function setVehicleData(
  map: maplibregl.Map,
  v: VehiclePosition | null,
  stale: boolean,
  delaySec: number,
  fallbackColor = TRAM_COLOR,
): void {
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: v
      ? [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [v.lon, v.lat] },
            properties: {
              line: v.line,
              isTram: v.mode !== "BUS",
              fill: v.color ?? (v.mode === "BUS" ? BUS_COLOR : fallbackColor),
              ring: ringColor(v.realTime, delaySec, stale),
              // Schedule-only and old data is drawn faded ("estimated").
              opacity: stale || !v.realTime ? 0.45 : 1,
            },
          },
        ]
      : [],
  };
  map.getSource<maplibregl.GeoJSONSource>(VEHICLE_SOURCE)?.setData(data);
}

function setRouteData(
  map: maplibregl.Map,
  route: TripRoute | null,
  progress: TripProgress | null,
  fallbackColor = TRAM_COLOR,
): void {
  const color = route?.color ?? (route?.mode === "BUS" ? BUS_COLOR : fallbackColor);
  const passed = (i: number) => progress !== null && (progress.next === null || i < progress.next);
  const line: FeatureCollection = {
    type: "FeatureCollection",
    features:
      route && route.path.length >= 2
        ? [{ type: "Feature", geometry: { type: "LineString", coordinates: route.path }, properties: { color } }]
        : [],
  };
  const stops: FeatureCollection = {
    type: "FeatureCollection",
    features: route
      ? route.stops.map((s, i) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
          properties: { stopId: s.stopId ?? "", name: s.name, label: shortName(s.name), color, passed: passed(i), next: progress?.next === i },
        }))
      : [],
  };
  map.getSource<maplibregl.GeoJSONSource>(ROUTE_SOURCE)?.setData(line);
  map.getSource<maplibregl.GeoJSONSource>(ROUTE_STOPS_SOURCE)?.setData(stops);
}

function addLayers(map: maplibregl.Map): void {
  const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
  map.addSource(ROUTE_SOURCE, { type: "geojson", data: empty });
  map.addSource(ROUTE_STOPS_SOURCE, { type: "geojson", data: empty });
  map.addSource(VEHICLE_SOURCE, { type: "geojson", data: empty });

  const underStops = map.getLayer(STOPS_FIRST_LAYER) ? STOPS_FIRST_LAYER : undefined;

  map.addLayer(
    {
      id: "trip-route-casing",
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 16, 11] },
    },
    underStops,
  );
  map.addLayer(
    {
      id: "trip-route-line",
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 7],
        "line-opacity": 0.9,
      },
    },
    underStops,
  );

  map.addLayer({
    id: "trip-stop-dot",
    type: "circle",
    source: ROUTE_STOPS_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, ["case", ["get", "next"], 5, 3], 16, ["case", ["get", "next"], 8, 6]],
      "circle-color": "#ffffff",
      "circle-stroke-color": ["get", "color"],
      "circle-stroke-width": ["case", ["get", "next"], 3, 2],
      "circle-opacity": ["case", ["get", "passed"], 0.5, 1],
      "circle-stroke-opacity": ["case", ["get", "passed"], 0.4, 1],
    },
  });
  map.addLayer({
    id: "trip-stop-label",
    type: "symbol",
    source: ROUTE_STOPS_SOURCE,
    minzoom: 13,
    layout: {
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-anchor": "left",
      "text-offset": [0.9, 0],
      "text-optional": true,
    },
    paint: {
      "text-color": "#37474f",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
      "text-opacity": ["case", ["get", "passed"], 0.5, 1],
    },
  });

  // The vehicle on top of everything: yellow halo, dot with punctuality ring, line number.
  map.addLayer({
    id: "vehicle-selected",
    type: "circle",
    source: VEHICLE_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 9, 14, 15, 17, 20],
      "circle-color": "#ffd54f",
      "circle-opacity": ["*", 0.85, ["get", "opacity"]],
    },
  });

  // Trams and trains are drawn a bit larger than buses.
  const radius: maplibregl.ExpressionSpecification = [
    "interpolate",
    ["linear"],
    ["zoom"],
    11,
    ["case", ["get", "isTram"], 5, 4],
    14,
    ["case", ["get", "isTram"], 10, 8],
    17,
    ["case", ["get", "isTram"], 14, 12],
  ];
  map.addLayer({
    id: VEHICLE_LAYER,
    type: "circle",
    source: VEHICLE_SOURCE,
    paint: {
      "circle-radius": radius,
      "circle-color": ["get", "fill"],
      "circle-opacity": ["get", "opacity"],
      "circle-stroke-color": ["get", "ring"],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 14, 3],
      "circle-stroke-opacity": ["get", "opacity"],
    },
  });
  map.addLayer({
    id: "vehicle-label",
    type: "symbol",
    source: VEHICLE_SOURCE,
    minzoom: 12.5,
    layout: {
      "text-field": ["get", "line"],
      "text-font": ["Noto Sans Bold"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 13, 9, 17, 13],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "rgba(0, 0, 0, 0.6)",
      "text-halo-width": 1,
    },
  });
}
