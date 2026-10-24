// The route panel: pick a start and a destination stop and a time, then see up to 5 connections.
// Shown only with ?route=1 while it is being built (see private/handoff.md, routing step R3).
// Light on Transitous: a search runs only when the button is pressed, one at a time, never by itself.
// Only stop IDs and the time leave the phone; "My location" picks the nearest stop on the phone.

import { type PlanRequest, PlanError, fetchPlan } from "./api";
import { berlinDateTime, fromBerlin, planTime } from "./berlintime";
import type { Board } from "./board";
import { badgeTextColor, delayState, formatClock } from "./departures";
import { t, onLangChange } from "./i18n";
import { shortName } from "./names";
import { type PanelUser, ageLine, el, focusKey, focusPanel, openPanel, ownsPanel, renderPanel } from "./panel";
import {
  type Journey,
  type Plan,
  type PlanFailure,
  durationText,
  firstRide,
  parsePlan,
  planFailure,
} from "./plan";
import { ageText, resetStatus, setStatus, setStatusNote, setStatusTitle } from "./status";
import { attachStopSearch } from "./stopsearch";
import { type Station, nearestStations } from "./stops";
import { PLAN_AHEAD_MS, PLAN_PAST_MS } from "../worker/transitous";

const FETCH_TIMEOUT_MS = 15_000;
const TICK_MS = 10_000; // the age line counts up; nothing is fetched again by itself
const STALE_AFTER_S = 120;
const LOCATION_RADIUS_M = 2000;

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

export function startRoute(board: Board): RoutePanel {
  const user: PanelUser = { onClose };
  let built: ReturnType<typeof buildForm> | null = null;
  let outcome: Outcome = { kind: "none" };
  let lastRequest: PlanRequest | null = null;
  let lastName = ""; // "Bonn Hbf → K-Neumarkt" of the last search, for the status line
  let controller: AbortController | null = null;
  let timeNote: string | null = null; // "this time happens twice" and the like
  let fieldError: string | null = null;

  onLangChange(() => {
    if (!built) return;
    applyTexts();
    if (!ownsPanel(user)) return;
    renderPanel(user, t().routeTitle, [built.form, built.results]);
    render();
  });
  setInterval(() => {
    if (ownsPanel(user) && outcome.kind === "plan") renderStatus();
  }, TICK_MS);

  function open(ends: { from?: Station; to?: Station } = {}): void {
    built ??= buildForm();
    if (ends.from) pick(built.from, ends.from);
    if (ends.to) pick(built.to, ends.to);
    if (built.isNow) fillNow();
    openPanel(user);
    renderPanel(user, t().routeTitle, [built.form, built.results]);
    applyTexts();
    render();
    focusPanel();
  }

  function onClose(): void {
    controller?.abort();
    controller = null;
    if (outcome.kind === "searching") outcome = { kind: "none" };
    resetStatus();
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
    attachStopSearchField(board, fromState, from.list, picked);
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

  async function useLocation(): Promise<void> {
    const b = built!;
    if (!window.isSecureContext || !("geolocation" in navigator)) {
      showFieldError(t().needsHttps, b.from.input);
      return;
    }
    b.locate.disabled = true;
    const before = { station: b.from.station, text: b.from.input.value };
    b.from.input.value = "";
    b.from.input.placeholder = t().findingYou;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15_000,
          maximumAge: 30_000,
        }),
      );
      await board.stationsReady;
      const near = nearestStations(board.stations(), pos.coords.longitude, pos.coords.latitude, LOCATION_RADIUS_M, 1);
      const station = near[0]?.station;
      if (station) {
        pick(b.from, station);
        fieldError = null;
        render();
      } else {
        setField(b.from, before.station, before.text);
        showFieldError(t().routeNoStopNear, b.from.input);
      }
    } catch (err) {
      setField(b.from, before.station, before.text);
      const denied = (err as GeolocationPositionError).code === 1;
      showFieldError(denied ? t().routeLocationDenied : t().routeLocationFailed, b.from.input);
    } finally {
      b.locate.disabled = false;
      b.from.input.placeholder = t().routeFromHint;
    }
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

  // `cursor`: an earlier/later page of the last search; null for a new search from the form.
  async function search(cursor: string | null, again = false): Promise<void> {
    const b = built!;
    let request: PlanRequest;
    if (cursor !== null || again) {
      if (!lastRequest) return;
      request = again ? lastRequest : { ...lastRequest, cursor };
    } else {
      const checked = checkForm();
      if (!checked) return;
      request = checked;
    }
    const name = cursor !== null || again ? lastName : routeName();

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
      lastRequest = request;
      lastName = name;
      outcome = { kind: "plan", plan: parsePlan(res.data), name, fetchedAtMs: res.fetchedAtMs, refreshFailed: false };
      const n = outcome.plan.journeys.length + (outcome.plan.walk ? 1 : 0);
      b.announce.textContent = n ? t().routeFound(n) : t().routeNone;
    } catch (err) {
      if (controller !== mine || !(err instanceof PlanError)) return;
      // A refresh that fails keeps the connections on screen, marked as not refreshed.
      if (again && previous.kind === "plan") {
        outcome = { ...previous, refreshFailed: true };
      } else {
        outcome = { kind: "failed", failure: planFailure(err.status, navigator.onLine), retryAfterS: err.retryAfterS };
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
    if (!from) return refuse(t().routePickFrom, b.from.input);
    if (!to) return refuse(t().routePickTo, b.to.input);
    if (from.id === to.id) return refuse(t().routeSameStop, b.to.input);

    let ms = Date.now();
    if (!b.isNow) {
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
      if (plan.walk) list.append(walkOption(plan.walk));
      for (const j of plan.journeys) list.append(journeyOption(j));
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

  // Status line and the age line under the connections (fresh: green; old or not refreshed: red).
  function renderStatus(): void {
    const b = built!;
    const title = outcome.kind === "plan" ? outcome.name : routeName();
    if (outcome.kind === "plan") {
      const ageS = Math.max(0, (Date.now() - outcome.fetchedAtMs) / 1000);
      const old = ageS > STALE_AFTER_S;
      setStatus(title, ageS, outcome.refreshFailed);
      const slot = b.body.querySelector(".route-age");
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
function attachStopSearchField(board: Board, field: Field, list: HTMLUListElement, onChange: () => void): void {
  attachStopSearch({
    input: field.input,
    list,
    board,
    clearOnEscape: false,
    onType() {
      field.station = null;
      field.input.removeAttribute("aria-invalid");
    },
    openOnFocus: () => field.station === null,
    onPick(station) {
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

// One connection: times (live, planned struck through when different), duration, the chain of lines and
// walks, then where it starts, the changes and the live state of the first ride.
function journeyOption(j: Journey): HTMLElement {
  const li = el("li", j.cancelled ? "route-option cancelled" : "route-option");
  const top = el("div", "route-times");
  top.append(clock(j.depMs, j.schedDepMs), el("span", "route-arrow", "→"), clock(j.arrMs, j.schedArrMs));
  top.append(el("span", "route-duration", durationText(j.arrMs - j.depMs)));
  li.append(top);

  const chain = el("div", "route-chain");
  j.legs.forEach((leg, i) => {
    if (i > 0) chain.append(el("span", "route-sep", "›"));
    if (leg.kind === "walk") {
      chain.append(walkChip(leg.minutes));
    } else {
      const color = leg.color ?? (leg.mode === "BUS" ? "#4a5a6a" : "#1565c0");
      const badge = el("span", "line", leg.line);
      badge.style.backgroundColor = color;
      badge.style.color = badgeTextColor(color, leg.textColor);
      chain.append(badge);
    }
  });
  li.append(chain);

  const ride = firstRide(j);
  const details: string[] = [];
  if (ride) details.push(t().routeFromStop([shortName(ride.from.name), ride.from.platform].filter(Boolean).join(" · ")));
  details.push(j.transfers ? t().routeTransfers(j.transfers) : t().routeDirect);
  const info = el("p", "route-info", details.join(" · "));
  if (ride) {
    const state = delayState((ride.from.ms - ride.from.schedMs) / 1000, ride.realTime, j.cancelled);
    info.append(" · ", el("span", `state ${state.level}`, state.text));
  }
  li.append(info);
  return li;
}

function walkOption(j: Journey): HTMLElement {
  const li = el("li", "route-option walk");
  const top = el("div", "route-times");
  top.append(el("b", "", t().routeWalkAll), el("span", "route-duration", durationText(j.arrMs - j.depMs)));
  li.append(top);
  const leg = j.legs[0];
  if (leg?.kind === "walk") {
    const chain = el("div", "route-chain");
    chain.append(walkChip(leg.minutes));
    li.append(chain);
  }
  return li;
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
  chip.append(el("span", "", `${minutes}`), el("span", "sr-only", ` ${t().routeWalkMin(minutes)}`));
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
