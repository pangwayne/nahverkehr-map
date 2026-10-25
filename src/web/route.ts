// The route panel: pick a start and a destination stop and a time, then see up to 5 connections, open one
// to see its details and draw it on the map, and follow any ride in its trip card.
// Light on Transitous: a search runs only when the button is pressed, one at a time, never by itself.
// Only stop IDs and the time leave the phone; the location button picks the nearest stop on the phone.

import type * as maplibregl from "maplibre-gl";
import { type PlanRequest, PlanError, fetchPlan } from "./api";
import { berlinDateTime, fromBerlin, planTime } from "./berlintime";
import type { Board } from "./board";
import { badgeTextColor, delayState, formatClock } from "./departures";
import { t, onLangChange } from "./i18n";
import { startJourneyMap } from "./journeymap";
import { fitPoints } from "./mapfit";
import { shortName } from "./names";
import { type PanelUser, ageLine, el, focusKey, focusPanel, openPanel, ownsPanel, renderPanel } from "./panel";
import {
  type Journey,
  type JourneyLeg,
  type Plan,
  type PlanFailure,
  type RideLeg,
  type SubmittedSearch,
  durationText,
  firstRide,
  journeyMinutes,
  journeyPath,
  parsePlan,
  planFailure,
  refreshRequest,
} from "./plan";
import { ageText, resetStatus, setStatus, setStatusNote, setStatusTitle } from "./status";
import { attachStopSearch } from "./stopsearch";
import { type Station, nearestStations } from "./stops";
import type { TripRef } from "./tripcard";
import { PLAN_AHEAD_MS, PLAN_PAST_MS } from "../worker/transitous";

const FETCH_TIMEOUT_MS = 15_000;
const TICK_MS = 10_000; // the age line counts up; nothing is fetched again by itself
const STALE_AFTER_S = 120;
const LOCATION_RADIUS_M = 2000;
const FIT_MAX_ZOOM = 16; // a short trip would otherwise zoom in so far that the map shows nothing around it

export interface RoutePanel {
  open(ends?: { from?: Station; to?: Station }): void;
}

interface Field {
  input: HTMLInputElement;
  station: Station | null; // picked from the list; typing afterwards clears it
}

type Outcome =
  | { kind: "none" }
  | { kind: "searching" }
  | { kind: "plan"; plan: Plan; name: string; fetchedAtMs: number; refreshFailed: boolean }
  | { kind: "failed"; failure: PlanFailure; retryAfterS: number | null };

// `openTrip`: a ride in a connection's details was tapped (opens its trip card, which can come back here).
export function startRoute(board: Board, map: maplibregl.Map, openTrip: (ref: TripRef) => void): RoutePanel {
  const user: PanelUser = { onClose };
  const journeyMap = startJourneyMap(map);
  map.on("load", () => journeyMap.addLayers());
  let detail: Journey | null = null; // the connection whose details are open (kept while its trip card is open)
  let built: ReturnType<typeof buildForm> | null = null;
  let outcome: Outcome = { kind: "none" };
  let lastSearch: SubmittedSearch | null = null; // the search whose answer is on screen
  let controller: AbortController | null = null;
  let timeNote: string | null = null; // "this time happens twice" and the like
  let fieldError: string | null = null;
  let locateSeq = 0; // number of the latest location lookup; an older one's answer is ignored
  let locating: { station: Station | null; text: string } | null = null; // a lookup is pending: From as it was

  onLangChange(() => {
    if (!built) return;
    applyTexts();
    if (!ownsPanel(user)) return;
    if (detail) showDetails(detail, false);
    else showList();
  });
  setInterval(() => {
    if (ownsPanel(user) && outcome.kind === "plan") renderStatus();
  }, TICK_MS);

  function open(ends: { from?: Station; to?: Station } = {}): void {
    built ??= buildForm();
    if (ends.from) {
      cancelLocate(false);
      pick(built.from, ends.from);
    }
    if (ends.to) pick(built.to, ends.to);
    if (built.isNow) fillNow();
    openPanel(user);
    applyTexts();
    showList();
    focusPanel();
  }

  // The form and the connections. `focusOn`: the option to give focus back to (coming back from details).
  function showList(focusOn?: string): void {
    const b = built!;
    detail = null;
    journeyMap.show(null);
    renderPanel(user, t().routeTitle, [b.form, b.results]);
    render();
    if (focusOn) {
      refocus(b.body, focusOn);
      document.activeElement?.scrollIntoView({ block: "nearest" });
    }
  }

  // One connection in full, and drawn on the map. `fit`: also move the map to show all of it.
  function showDetails(j: Journey, fit = true): void {
    detail = j;
    const title = outcome.kind === "plan" ? outcome.name : routeName();
    renderPanel(user, title, detailNodes(j));
    journeyMap.show(j);
    if (fit) {
      document.querySelector("#board")!.scrollTop = 0; // the list may have been scrolled down
      fitPoints(map, journeyPath(j), FIT_MAX_ZOOM);
    }
    renderStatus();
  }

  // Back from a ride's trip card.
  function backToJourney(): void {
    if (!detail) return;
    openPanel(user);
    showDetails(detail);
    focusPanel();
  }

  function onClose(): void {
    controller?.abort();
    controller = null;
    if (outcome.kind === "searching") outcome = { kind: "none" };
    cancelLocate(true);
    journeyMap.show(null);
    resetStatus();
  }

  function detailNodes(j: Journey): HTMLElement[] {
    const back = focusKey(el("button", "link-button route-back", `← ${t().routeBack}`) as HTMLButtonElement, "back");
    back.type = "button";
    back.addEventListener("click", () => showList(optionKey(j)));

    const summary = el("p", "route-summary");
    summary.append(clock(j.depMs, j.schedDepMs), " ", ...arrow(), " ", clock(j.arrMs, j.schedArrMs));
    const facts = [durationText(journeyMinutes(j) * 60_000), j.transfers ? t().routeTransfers(j.transfers) : t().routeDirect];
    summary.append(` · ${facts.join(" · ")}`);

    const list = el("ol", "journey-legs");
    j.legs.forEach((leg, i) => list.append(legItem(leg, i === j.legs.length - 1, j.cancelled)));

    const foot = el("div", "route-foot");
    foot.append(el("span", "route-age"));
    const whole = focusKey(el("button", "link-button", t().wholeRoute) as HTMLButtonElement, "whole");
    whole.type = "button";
    whole.addEventListener("click", () => fitPoints(map, journeyPath(j), FIT_MAX_ZOOM));
    foot.append(whole);
    return [back, summary, list, foot];
  }

  function legItem(leg: JourneyLeg, last: boolean, cancelled: boolean): HTMLElement {
    if (leg.kind === "walk") {
      const li = el("li", "journey-leg walk");
      const icon = el("span", "route-walk");
      icon.insertAdjacentHTML("afterbegin", WALK_ICON);
      li.append(icon, el("span", "", t().routeWalkMin(leg.minutes)));
      if (last) li.append(el("span", "journey-to", t().routeWalkTo(shortName(leg.to.name))));
      return li;
    }
    const li = el("li", leg.cancelled || cancelled ? "journey-leg ride cancelled" : "journey-leg ride");
    li.style.setProperty("--line", rideColor(leg));
    li.append(legStop(leg.from.ms, leg.from.schedMs, leg.from.name, leg.from.platform));

    const mid = el("div", "journey-ride");
    if (leg.staySeated) mid.append(el("p", "journey-seated", t().routeStaySeated(leg.line)));
    const head = el("p", "journey-line");
    head.append(lineBadge(leg), el("span", "journey-headsign", shortName(leg.headsign)));
    mid.append(head);
    const facts = el("p", "route-info", t().routeStops(leg.stopsBetween + 1));
    const state = delayState((leg.from.ms - leg.from.schedMs) / 1000, leg.realTime, leg.cancelled);
    facts.append(" · ", el("span", `state ${state.level}`, state.text));
    mid.append(facts);
    if (leg.tripId) {
      const tripId = leg.tripId;
      const open = focusKey(el("button", "link-button", t().routeShowRide) as HTMLButtonElement, `ride-${tripId}`);
      open.type = "button";
      open.addEventListener("click", () =>
        openTrip({
          tripId,
          line: leg.line,
          color: rideColor(leg),
          focus: [leg.from.lon, leg.from.lat],
          back: { label: () => t().routeBackToJourney, run: backToJourney },
        }),
      );
      mid.append(open);
    }
    li.append(mid, legStop(leg.to.ms, leg.to.schedMs, leg.to.name, leg.to.platform));
    return li;
  }

  // The form is built once and kept, so typed text, picks and focus survive redraws and language switches.
  function buildForm() {
    const form = document.createElement("form");
    form.className = "route-form";
    form.noValidate = true;

    const from = stopField("route-from");
    const to = stopField("route-to");
    const fromState: Field = { input: from.input, station: null };
    const toState: Field = { input: to.input, station: null };

    const locate = iconButton("route-locate", LOCATE_ICON);
    locate.addEventListener("click", () => void useLocation());
    from.row.append(locate);
    const swap = iconButton("route-swap", SWAP_ICON);
    swap.addEventListener("click", () => {
      cancelLocate(true);
      const a = fromState.station;
      const aText = fromState.input.value;
      setField(fromState, toState.station, toState.input.value);
      setField(toState, a, aText);
    });
    to.row.append(swap);

    // When: leave at / arrive by, a date and time (Bonn time), and "Now".
    const when = el("fieldset", "route-when");
    const legend = el("legend", "sr-only");
    const modes = el("div", "route-modes");
    const depart = radio("route-mode", "0", true);
    const arrive = radio("route-mode", "1", false);
    modes.append(depart.label, arrive.label);
    const date = document.createElement("input");
    date.type = "date";
    date.id = "route-date";
    date.className = "route-input";
    const time = document.createElement("input");
    time.type = "time";
    time.id = "route-time";
    time.className = "route-input";
    const now = el("button", "route-now") as HTMLButtonElement;
    now.type = "button";
    now.addEventListener("click", () => {
      state.isNow = true;
      fillNow();
      render();
    });
    for (const input of [date, time]) {
      input.addEventListener("input", () => {
        state.isNow = false;
        input.removeAttribute("aria-invalid");
        render();
      });
    }
    const dateLabel = el("label", "sr-only") as HTMLLabelElement;
    dateLabel.htmlFor = date.id;
    const timeLabel = el("label", "sr-only") as HTMLLabelElement;
    timeLabel.htmlFor = time.id;
    const moment = el("div", "route-moment");
    moment.append(dateLabel, date, timeLabel, time, now);
    when.append(legend, modes, moment);

    const error = el("p", "route-error");
    error.id = "route-error";
    error.setAttribute("aria-live", "polite");

    const submit = el("button", "route-submit") as HTMLButtonElement;
    submit.type = "submit";
    form.append(from.wrap, to.wrap, when, error, submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void search(null);
    });

    // Results: kept apart from the form so a redraw never touches what the user is typing.
    const results = el("div", "route-results");
    const announce = el("p", "sr-only");
    announce.setAttribute("aria-live", "polite");
    const body = el("div", "");
    results.append(announce, body);

    const state = {
      form,
      results,
      body,
      announce,
      from: fromState,
      to: toState,
      fromLabel: from.label,
      toLabel: to.label,
      locate,
      swap,
      legend,
      depart,
      arrive,
      date,
      time,
      dateLabel,
      timeLabel,
      now,
      error,
      submit,
      isNow: true,
    };

    const picked = () => {
      fieldError = null;
      render();
    };
    // Typing or picking a start ends a pending location lookup: the user's choice wins.
    attachStopSearchField(board, fromState, from.list, picked, () => cancelLocate(false));
    attachStopSearchField(board, toState, to.list, picked);
    return state;
  }

  function pick(field: Field, station: Station): void {
    setField(field, station, shortName(station.name));
  }

  function setField(field: Field, station: Station | null, text: string): void {
    field.station = station;
    field.input.value = text;
    field.input.removeAttribute("aria-invalid");
  }

  function fillNow(): void {
    if (!built) return;
    const { date, time } = berlinDateTime(Date.now());
    built.date.value = date;
    built.time.value = time;
  }

  // The nearest stop as the start. While the position is being found, From is empty and holds no stop, so a
  // search cannot go out with the old start. Each lookup has a number: when the user moves on (types or picks
  // a start, swaps, closes the panel, opens it from a board), the lookup is cancelled, and its late answer
  // changes nothing.
  async function useLocation(): Promise<void> {
    const b = built!;
    if (!window.isSecureContext || !("geolocation" in navigator)) {
      showFieldError(t().needsHttps, b.from.input);
      return;
    }
    cancelLocate(false);
    const mine = ++locateSeq;
    locating = { station: b.from.station, text: b.from.input.value };
    const before = locating;
    b.locate.disabled = true;
    setField(b.from, null, "");
    b.from.input.placeholder = t().findingYou;
    const current = () => mine === locateSeq;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15_000,
          maximumAge: 30_000,
        }),
      );
      if (!current()) return;
      await board.stationsReady;
      if (!current()) return;
      const near = nearestStations(board.stations(), pos.coords.longitude, pos.coords.latitude, LOCATION_RADIUS_M, 1);
      const station = near[0]?.station;
      releaseLocate();
      if (station) {
        pick(b.from, station);
        fieldError = null;
        render();
      } else {
        setField(b.from, before.station, before.text);
        showFieldError(t().routeNoStopNear, b.from.input);
      }
    } catch (err) {
      if (!current()) return;
      releaseLocate();
      setField(b.from, before.station, before.text);
      const denied = (err as GeolocationPositionError).code === 1;
      showFieldError(denied ? t().routeLocationDenied : t().routeLocationFailed, b.from.input);
    }
  }

  // Ends the waiting state of a lookup (button, placeholder); the lookup itself may still answer later.
  function releaseLocate(): void {
    locating = null;
    if (!built) return;
    built.locate.disabled = false;
    built.from.input.placeholder = t().routeFromHint;
  }

  // Cancels a pending lookup at once. `restore`: put back the start it emptied (swap, close); not when the
  // user is already typing or picking a new one.
  function cancelLocate(restore: boolean): void {
    if (!locating || !built) return;
    const before = locating;
    locateSeq++;
    releaseLocate();
    if (restore) setField(built.from, before.station, before.text);
  }

  // Always null, so a check can say `return refuse(...)`.
  function refuse(text: string, input: HTMLInputElement): null {
    showFieldError(text, input);
    return null;
  }

  function showFieldError(text: string, input: HTMLInputElement): void {
    fieldError = text;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    render();
  }

  // `cursor`: an earlier/later page of the last search; `again`: refresh it. Both use only the submitted
  // search, never the form, so unsent edits in the form stay as they are. Neither: a new search from the form.
  async function search(cursor: string | null, again = false): Promise<void> {
    const b = built!;
    let submitted: SubmittedSearch;
    if (cursor !== null || again) {
      if (!lastSearch) return;
      const request = again ? refreshRequest(lastSearch, Date.now()) : { ...lastSearch.request, cursor };
      if (!request) {
        // A chosen time that is now too far back: say so, keep the connections, send nothing.
        if (outcome.kind === "plan") outcome = { ...outcome, refreshFailed: true };
        fieldError = t().routeTimeRange;
        render();
        return;
      }
      submitted = { ...lastSearch, request };
    } else {
      const request = checkForm();
      if (!request) return;
      submitted = { request, isNow: b.isNow, name: routeName() };
    }
    const { request, name } = submitted;

    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const timer = setTimeout(() => mine.abort(new DOMException("timeout", "TimeoutError")), FETCH_TIMEOUT_MS);
    const previous = outcome;
    // "Searching..." replaces the results; Earlier / Later / Refresh get focus back once the answer is here.
    const keep = focusedKey(b.body);
    outcome = { kind: "searching" };
    render();
    try {
      const res = await fetchPlan(request, mine.signal);
      if (controller !== mine) return;
      lastSearch = submitted;
      outcome = { kind: "plan", plan: parsePlan(res.data), name, fetchedAtMs: res.fetchedAtMs, refreshFailed: false };
      const n = outcome.plan.journeys.length + (outcome.plan.walk ? 1 : 0);
      b.announce.textContent = n ? t().routeFound(n) : t().routeNone;
    } catch (err) {
      if (controller !== mine) return;
      // Anything that is not a refusal from the Worker (a bug while reading the answer, say) counts as "no
      // answer", so the panel never stays at "Searching...".
      const failure = err instanceof PlanError ? err : new PlanError(null, null);
      // A refresh that fails keeps the connections on screen, marked as not refreshed.
      if (again && previous.kind === "plan") {
        outcome = { ...previous, refreshFailed: true };
      } else {
        outcome = { kind: "failed", failure: planFailure(failure.status, navigator.onLine), retryAfterS: failure.retryAfterS };
        b.announce.textContent = failureText(outcome.failure, outcome.retryAfterS);
      }
    } finally {
      clearTimeout(timer);
      if (controller === mine) controller = null;
    }
    render();
    if (!ownsPanel(user)) return;
    if (keep) refocus(b.body, keep);
    else if (cursor === null && !again) b.body.querySelector<HTMLElement>("h3")?.focus();
  }

  // The form as a request, or null after pointing at what is missing or wrong.
  function checkForm(): PlanRequest | null {
    const b = built!;
    fieldError = null;
    timeNote = null;
    for (const input of [b.from.input, b.to.input, b.date, b.time]) input.removeAttribute("aria-invalid");
    const from = b.from.station;
    const to = b.to.station;
    if (locating) return refuse(t().routeLocating, b.from.input);
    if (!from) return refuse(t().routePickFrom, b.from.input);
    if (!to) return refuse(t().routePickTo, b.to.input);
    if (from.id === to.id) return refuse(t().routeSameStop, b.to.input);

    let ms = Date.now();
    if (b.isNow) {
      fillNow(); // the form shows the time actually searched, not the one from when the panel opened
    } else {
      const picked = fromBerlin(b.date.value, b.time.value);
      if (!picked) return refuse(t().routeBadTime, b.time);
      if (picked.ms < Date.now() - PLAN_PAST_MS || picked.ms > Date.now() + PLAN_AHEAD_MS) {
        return refuse(t().routeTimeRange, b.date);
      }
      ms = picked.ms;
      if (picked.note === "twice") timeNote = t().routeTimeTwice;
      if (picked.note === "skipped") timeNote = t().routeTimeSkipped(berlinDateTime(ms).time);
    }
    return { from: from.planStopId, to: to.planStopId, time: planTime(ms), arriveBy: b.arrive.input.checked, cursor: null };
  }

  function applyTexts(): void {
    const b = built!;
    const x = t();
    b.fromLabel.textContent = x.routeFrom;
    b.toLabel.textContent = x.routeTo;
    b.from.input.placeholder = x.routeFromHint;
    b.to.input.placeholder = x.routeToHint;
    b.locate.setAttribute("aria-label", x.routeUseLocation);
    b.locate.title = x.routeUseLocation;
    b.swap.setAttribute("aria-label", x.routeSwap);
    b.swap.title = x.routeSwap;
    b.legend.textContent = x.routeWhen;
    b.depart.text.textContent = x.routeDepart;
    b.arrive.text.textContent = x.routeArrive;
    b.dateLabel.textContent = x.routeDate;
    b.timeLabel.textContent = x.routeTime;
    b.now.textContent = x.routeNow;
  }

  function render(): void {
    if (!built || !ownsPanel(user)) return;
    const b = built;
    const searching = outcome.kind === "searching";
    b.submit.disabled = searching;
    b.submit.textContent = searching ? t().routeSearching : t().routeSearch;
    b.now.setAttribute("aria-pressed", String(b.isNow));
    b.error.textContent = fieldError ?? timeNote ?? "";
    b.error.classList.toggle("note", fieldError === null);
    b.results.setAttribute("aria-busy", String(searching));

    // Focus inside the results (Earlier, Later, Refresh) comes back after the redraw.
    const key = focusedKey(b.body);
    b.body.replaceChildren(...resultNodes());
    if (key) refocus(b.body, key);
    renderStatus();
  }

  function resultNodes(): HTMLElement[] {
    if (outcome.kind === "none") return [];
    if (outcome.kind === "searching") return [el("p", "board-note", t().routeSearching)];
    if (outcome.kind === "failed") {
      return [el("p", "board-note board-error", failureText(outcome.failure, outcome.retryAfterS))];
    }

    const { plan } = outcome;
    const heading = el("h3", "route-heading", t().routeResults);
    heading.tabIndex = -1;
    const nodes: HTMLElement[] = [heading];
    if (!plan.journeys.length && !plan.walk) {
      nodes.push(el("p", "board-note", t().routeNone));
    } else {
      const list = el("ul", "route-options");
      const walk = plan.walk;
      if (walk) list.append(walkOption(walk, () => showDetails(walk)));
      for (const j of plan.journeys) list.append(journeyOption(j, () => showDetails(j)));
      nodes.push(list);
    }

    const pager = el("div", "route-pager");
    if (plan.earlier) pager.append(pagerButton(t().routeEarlier, "earlier", plan.earlier));
    if (plan.later) pager.append(pagerButton(t().routeLater, "later", plan.later));
    if (pager.childElementCount) nodes.push(pager);

    const foot = el("div", "route-foot");
    foot.append(el("span", "route-age"));
    const refresh = focusKey(el("button", "link-button", t().routeRefresh) as HTMLButtonElement, "refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => void search(null, true));
    foot.append(refresh);
    nodes.push(foot);
    return nodes;
  }

  function pagerButton(text: string, key: string, cursor: string): HTMLElement {
    const btn = focusKey(el("button", "route-page", text) as HTMLButtonElement, key);
    btn.type = "button";
    btn.addEventListener("click", () => void search(cursor));
    return btn;
  }

  // Status line and the age line under the connections or details (fresh: green; old or not refreshed: red).
  function renderStatus(): void {
    const title = outcome.kind === "plan" ? outcome.name : routeName();
    if (outcome.kind === "plan") {
      const ageS = Math.max(0, (Date.now() - outcome.fetchedAtMs) / 1000);
      const old = ageS > STALE_AFTER_S;
      setStatus(title, ageS, outcome.refreshFailed);
      const slot = document.querySelector("#board-body .route-age");
      slot?.replaceChildren(ageLine(ageText(ageS, old, outcome.refreshFailed), old || outcome.refreshFailed));
    } else if (outcome.kind === "searching") {
      setStatus(title, null, false);
    } else if (outcome.kind === "failed") {
      setStatusNote(title);
    } else {
      setStatusTitle(title);
    }
  }

  function routeName(): string {
    const b = built!;
    const from = b.from.station;
    const to = b.to.station;
    return from && to ? `${shortName(from.name)} → ${shortName(to.name)}` : t().routeTitle;
  }

  return { open };
}

// Wires one From/To field to the shared stop search (the same combobox as the header search).
// `onEdit`: the user typed in or picked for this field (before the change is applied).
function attachStopSearchField(
  board: Board,
  field: Field,
  list: HTMLUListElement,
  onChange: () => void,
  onEdit?: () => void,
): void {
  attachStopSearch({
    input: field.input,
    list,
    board,
    clearOnEscape: false,
    onType() {
      onEdit?.();
      field.station = null;
      field.input.removeAttribute("aria-invalid");
    },
    openOnFocus: () => field.station === null,
    onPick(station) {
      onEdit?.();
      field.station = station;
      field.input.value = shortName(station.name);
      field.input.removeAttribute("aria-invalid");
      onChange();
    },
  });
}

function focusedKey(box: HTMLElement): string | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement && box.contains(active) ? active.dataset["focus"] : undefined;
}

function refocus(box: HTMLElement, key: string): void {
  box.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function failureText(failure: PlanFailure, retryAfterS: number | null): string {
  switch (failure) {
    case "offline":
      return t().routeOffline;
    case "unknownStop":
      return t().routeUnknownStop;
    case "tooMany":
      return t().routeTooMany(retryAfterS ?? 60);
    default:
      return t().routeUnavailable;
  }
}

const optionKey = (j: Journey) => `j-${j.key}`;

function rideColor(leg: RideLeg): string {
  return leg.color ?? (leg.mode === "BUS" ? "#4a5a6a" : "#1565c0");
}

function lineBadge(leg: RideLeg): HTMLElement {
  const color = rideColor(leg);
  const badge = el("span", "line", leg.line);
  badge.style.backgroundColor = color;
  badge.style.color = badgeTextColor(color, leg.textColor);
  return badge;
}

// A stop in the details: the time (planned struck through when different), its name and platform.
function legStop(ms: number, schedMs: number, name: string, platform: string | null): HTMLElement {
  const row = el("div", "journey-stop");
  row.append(clock(ms, schedMs), el("span", "journey-stop-dot"));
  const label = el("span", "journey-stop-name", shortName(name));
  if (platform) label.append(el("small", "", ` ${platform}`));
  row.append(label);
  return row;
}

// One connection, as a button that opens its details: times (live, planned struck through when different),
// duration, the chain of lines and walks, then where it starts, the changes and the live state of the first
// ride. Inside a button only spans are allowed; the classes lay them out.
function journeyOption(j: Journey, onOpen: () => void): HTMLElement {
  const li = el("li", "");
  const btn = focusKey(
    el("button", j.cancelled ? "route-option cancelled" : "route-option") as HTMLButtonElement,
    optionKey(j),
  );
  btn.type = "button";
  btn.addEventListener("click", onOpen);
  li.append(btn);
  // Screen readers hear "21:46 bis 22:16, 30 min, RB26, 8 min Fußweg, 16, ab ...": the arrow and the "›"
  // are hidden from them, a hidden word and commas take their place.
  const top = el("span", "route-times");
  top.append(clock(j.depMs, j.schedDepMs), ...arrow(), clock(j.arrMs, j.schedArrMs));
  top.append(srOnly(", "), el("span", "route-duration", durationText(journeyMinutes(j) * 60_000)));
  btn.append(top);

  const chain = el("span", "route-chain");
  chain.append(srOnly(", "));
  j.legs.forEach((leg, i) => {
    if (i > 0) chain.append(hidden(el("span", "route-sep", "›")), srOnly(", "));
    chain.append(leg.kind === "walk" ? walkChip(leg.minutes) : lineBadge(leg));
  });
  btn.append(chain);

  const ride = firstRide(j);
  const details: string[] = [];
  if (ride) details.push(t().routeFromStop([shortName(ride.from.name), ride.from.platform].filter(Boolean).join(" · ")));
  details.push(j.transfers ? t().routeTransfers(j.transfers) : t().routeDirect);
  const info = el("span", "route-info");
  info.append(srOnly(", "), details.join(" · "));
  if (ride) {
    const state = delayState((ride.from.ms - ride.from.schedMs) / 1000, ride.realTime, j.cancelled);
    info.append(" · ", el("span", `state ${state.level}`, state.text));
  }
  btn.append(info);
  return li;
}

function walkOption(j: Journey, onOpen: () => void): HTMLElement {
  const li = el("li", "");
  const btn = focusKey(el("button", "route-option walk") as HTMLButtonElement, optionKey(j));
  btn.type = "button";
  btn.addEventListener("click", onOpen);
  li.append(btn);
  const leg = j.legs[0];
  const top = el("span", "route-times");
  top.append(el("b", "", t().routeWalkAll), srOnly(", "));
  top.append(el("span", "route-duration", durationText(journeyMinutes(j) * 60_000)));
  btn.append(top);
  if (leg?.kind === "walk") {
    const chain = el("span", "route-chain");
    chain.append(srOnly(", "), walkChip(leg.minutes));
    btn.append(chain);
  }
  return li;
}

// The "→" between two times: seen, but read as "bis" / "to".
function arrow(): HTMLElement[] {
  return [hidden(el("span", "route-arrow", "→")), srOnly(` ${t().routeUntil} `)];
}

function srOnly(text: string): HTMLElement {
  return el("span", "sr-only", text);
}

function hidden(node: HTMLElement): HTMLElement {
  node.setAttribute("aria-hidden", "true");
  return node;
}

function clock(ms: number, schedMs: number): HTMLElement {
  const span = el("span", "route-clock");
  if (Math.abs(ms - schedMs) >= 60_000) {
    const planned = el("s", "");
    planned.append(el("span", "sr-only", `${t().routePlanned} `), formatClock(schedMs));
    span.append(planned, " ");
  }
  span.append(el("b", "", formatClock(ms)));
  return span;
}

function walkChip(minutes: number): HTMLElement {
  const chip = el("span", "route-walk");
  chip.insertAdjacentHTML("afterbegin", WALK_ICON);
  // The bare number is for the eye; screen readers get "8 min Fußweg" once.
  chip.append(hidden(el("span", "", `${minutes}`)), srOnly(t().routeWalkMin(minutes)));
  return chip;
}

function stopField(id: string) {
  const wrap = el("div", "route-field");
  const label = el("label", "route-label") as HTMLLabelElement;
  label.htmlFor = id;
  const row = el("div", "route-row");
  const input = document.createElement("input");
  input.id = id;
  input.type = "text";
  input.className = "route-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-describedby", "route-error");
  const list = document.createElement("ul");
  list.id = `${id}-results`;
  list.className = "stop-list";
  row.append(input);
  wrap.append(label, row, list);
  return { wrap, label, row, input, list };
}

function iconButton(className: string, svg: string): HTMLButtonElement {
  const btn = el("button", `route-icon ${className}`) as HTMLButtonElement;
  btn.type = "button";
  btn.insertAdjacentHTML("afterbegin", svg);
  return btn;
}

function radio(name: string, value: string, checked: boolean) {
  const label = el("label", "route-mode");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  const text = el("span", "");
  label.append(input, text);
  return { label, input, text };
}

const LOCATE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>';
const SWAP_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/></svg>';
const WALK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 3v3M7 12l3-4 4 1 2 4M11 15l-1-4"/></svg>';
