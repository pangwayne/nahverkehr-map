// The route panel: pick a start and a destination (a stop, an address or place, a point on the map, or My
// location) and a time, then see up to 5 connections, open one to see its details and draw it on the map,
// and follow any ride in its trip card.
// Light on Transitous: a search runs only when the button is pressed (or a link / saved route is opened), one
// at a time. An open connection's rides are refreshed through their trips (the same requests a trip card
// makes), once a minute while the details are on screen; the search itself is never repeated by a timer.
// What leaves the phone: the two ends (stop IDs, or positions for addresses, map points and My location),
// the time and the travel settings, only with a search.

import type * as maplibregl from "maplibre-gl";
import { collectNotices } from "./alerts";
import { type Mode, type PlanRequest, PlanError, fetchPlan, fetchTrip, isStale } from "./api";
import { type Followed, dueForRefresh, follow, followEnded, refreshFollowed } from "./follow";
import { berlinDateTime, fromBerlin, planTime } from "./berlintime";
import type { Board } from "./board";
import { badgeTextColor, delayLevel, delayState, formatDelay, modeLabel } from "./departures";
import { type EndRef, type RouteRef, type View, sameEnd } from "./endpoints";
import { getLang, t, onLangChange } from "./i18n";
import { startJourneyMap } from "./journeymap";
import { fitPoints } from "./mapfit";
import { shortName, townName } from "./names";
import { linkTo, previousView, pushView, replaceView, stepBackQuietly } from "./nav";
import {
  type PanelUser,
  ageLine,
  button,
  clock,
  el,
  focusKey,
  focusPanel,
  noticeList,
  openPanel,
  ownsPanel,
  renderPanel,
  shareLink,
  toast,
} from "./panel";
import type { Spot } from "./places";
import {
  type Journey,
  type JourneyLeg,
  type JourneyState,
  type LegStop,
  type Plan,
  type PlanFailure,
  type RideChange,
  type RideLeg,
  type SubmittedSearch,
  type Transfer,
  type WalkLeg,
  departed,
  durationText,
  firstRide,
  isPosition,
  journeyMinutes,
  journeyPath,
  journeyState,
  parsePlan,
  planFailure,
  positionPlace,
  refreshRequest,
  transfersOf,
} from "./plan";
import {
  DEFAULT_PREFS,
  EXTRA_CHOICES,
  TRANSFER_CHOICES,
  type TravelPrefs,
  WALK_CHOICES,
  anyMode,
  changedPrefs,
  loadPrefs,
  prefsFromQuery,
  prefsQuery,
  savePrefs,
} from "./prefs";
import { type SavedRoute, isRouteSaved, isStopSaved, loadSaved, onSavedChange, savableRoute, toggleRoute } from "./saved";
import { ageText, resetStatus, setStatus, setStatusNote, setStatusTitle } from "./status";
import { type SearchItem, attachStopSearch } from "./stopsearch";
import { type Station, findStation, stationIds } from "./stops";
import type { TripRef } from "./tripcard";
import { PLAN_AHEAD_MS, PLAN_MAX_TRANSFERS, PLAN_PAST_MS, isAreaStopId, isInArea, isValidPosition } from "../worker/transitous";

const FETCH_TIMEOUT_MS = 15_000;
const TICK_MS = 10_000; // the age line counts up; an open connection's rides refresh on the minute (follow.ts)
const STALE_AFTER_S = 120;
// A fix less sure than this gets a warning (it still counts): the walk and the stop may then be wrong.
const ROUGH_LOCATION_M = 300;
const FIT_MAX_ZOOM = 16; // a short trip would otherwise zoom in so far that the map shows nothing around it
const RIDE_NOTICES = 2;

export interface RoutePanel {
  open(ends?: { from?: Station | Spot; to?: Station | Spot }): void;
  openSaved(route: SavedRoute): void;
  restore(view: Extract<View, { kind: "route" | "journey" }>): void; // Back / Forward / a link
}

// "My location": the phone's position as one end of a search, sent as it is (see positionPlace).
interface Here {
  here: true;
  lat: number;
  lon: number;
  accuracyM: number; // how far off the phone says it may be
}

type Place = Station | Here | Spot;

const isHere = (p: Place | null): p is Here => p !== null && "here" in p;
const isSpot = (p: Place | null): p is Spot => p !== null && "kind" in p && p.kind === "spot";

interface Field {
  input: HTMLInputElement;
  place: Place | null; // a stop or place picked from the list, or My location; typing afterwards clears it
}

type Outcome =
  | { kind: "none" }
  | { kind: "searching" }
  | {
      kind: "plan";
      plan: Plan;
      fetchedAtMs: number;
      refreshFailed: boolean;
      pageFailed: { failure: PlanFailure; retryAfterS: number | null } | null; // Earlier / Later failed: these connections stay, the buttons try again
    }
  | { kind: "failed"; failure: PlanFailure; retryAfterS: number | null };

// `openTrip`: a ride in a connection's details was tapped (opens its trip card, which can come back here).
export function startRoute(board: Board, map: maplibregl.Map, openTrip: (ref: TripRef) => void): RoutePanel {
  const user: PanelUser = { onClose };
  const journeyMap = startJourneyMap(map);
  map.on("load", () => journeyMap.addLayers());
  let detail: Journey | null = null; // the connection whose details are open (kept while its trip card is open)
  let followed: Followed | null = null;
  // Each connection of the answer on screen that has been opened, kept current: opening it again (from the
  // list, or back from a ride's trip card) goes on with its times and its refresh state.
  let follows = new Map<string, Followed>();
  let goneShown = 0; // connections listed as already left, at the last redraw
  let detailSeq = 0;
  let pinned: Journey | null = null; // the connection someone was following when they asked for alternatives
  let built: ReturnType<typeof buildForm> | null = null;
  let outcome: Outcome = { kind: "none" };
  let lastSearch: SubmittedSearch | null = null; // the search whose answer is on screen
  // On a phone the form fills the sheet, so after a search that found connections it folds into one summary
  // button. `found`: the last answer had connections; `folded`: the user has not opened the form since.
  let found = false;
  let folded = false;
  let controller: AbortController | null = null;
  let timeNote: string | null = null; // "this time happens twice" and the like
  let fieldError: string | null = null;
  let locateSeq = 0; // number of the latest location lookup; an older one's answer is ignored
  let locating: { place: Place | null; text: string } | null = null; // a lookup is pending: From as it was
  let prefs: TravelPrefs = loadPrefs();
  let announce: () => string = () => ""; // the last result announcement, in the language shown
  let pendingKey: string | null = null; // a connection to open once its search has answered (a link, Back)
  let pendingPage: string | null = null; // the earlier / later page that next search from the form asks for
  // Number of the latest link / saved route being filled in (that waits for the stop list). Closing, opening
  // the panel again or any edit in the form counts up, and the older filling-in then changes nothing.
  let restoreSeq = 0;

  onLangChange(() => {
    if (!built) return;
    applyTexts();
    built.announce.textContent = announce();
    if (!ownsPanel(user)) return;
    if (detail) showDetails(detail, false, false);
    else showList();
  });
  onSavedChange(() => {
    if (!ownsPanel(user) || !built) return;
    if (detail) showDetails(detail, false, false);
    else render();
  });
  setInterval(() => {
    if (!ownsPanel(user)) return;
    const now = Date.now();
    if (detail && followed && document.visibilityState === "visible" && dueForRefresh(followed, now)) {
      void refreshDetail();
    } else if (!detail && outcome.kind === "plan" && goneCount(outcome.plan, now) !== goneShown) {
      render(); // a connection has left meanwhile: it moves down to the ones already gone
    } else if (outcome.kind === "plan" || followed) renderStatus();
  }, TICK_MS);

  function open(ends: { from?: Station | Spot; to?: Station | Spot } = {}): void {
    restoreSeq++;
    built ??= buildForm();
    if (ends.from) {
      cancelLocate(false);
      pick(built.from, ends.from);
    }
    if (ends.to) pick(built.to, ends.to);
    if (ends.from || ends.to) folded = false; // opened from a board to plan something new: show the form
    if (built.isNow) fillNow();
    setDateBounds();
    openPanel(user);
    applyTexts();
    showList();
    pushView({ kind: "route", route: currentRef() });
    focusPanel();
  }

  // The route as the address shows it: the search on screen, else what the form holds so far.
  function currentRef(): RouteRef {
    if (lastSearch && outcome.kind === "plan") return refOf(lastSearch);
    const b = built!;
    return {
      from: b.from.place ? endRef(b.from.place) : null,
      to: b.to.place ? endRef(b.to.place) : null,
      time: null,
      arriveBy: false,
      prefs: prefsQuery(prefs),
    };
  }

  // The form and the connections. `focusOn`: the option to give focus back to (coming back from details).
  function showList(focusOn?: string): void {
    const b = built!;
    detail = null;
    followed = null;
    detailSeq++;
    journeyMap.show(null);
    renderPanel(user, t().routeTitle, [b.fold, b.form, b.results]);
    render();
    if (focusOn) {
      refocus(b.body, focusOn);
      document.activeElement?.scrollIntoView({ block: "nearest" });
    }
  }

  // One connection in full, and drawn on the map. `fit`: also move the map to show all of it.
  // `follow`: it was just opened (not redrawn): start keeping it current.
  function showDetails(j: Journey, fit = true, start = true): void {
    if (start) {
      detailSeq++;
      // Only rides have live times to follow; walking all the way has nothing to refresh.
      const rides = j.legs.some((l) => l.kind === "ride" && l.tripId !== null);
      followed = rides ? (follows.get(j.key) ?? startFollowing(j)) : null;
      if (followed) j = followed.journey;
    }
    // Walking directions someone opened stay open when the same connection is drawn again (a refresh).
    const opened =
      detail?.key === j.key
        ? [...document.querySelectorAll<HTMLElement>("#board-body details.walk-steps[open]")].map((d) => d.dataset["walk"])
        : [];
    detail = j;
    const title = lastSearch ? searchName(lastSearch) : routeName();
    renderPanel(user, title, detailNodes(j));
    for (const k of opened) {
      const d = document.querySelector<HTMLDetailsElement>(`#board-body details.walk-steps[data-walk="${k}"]`);
      if (d) d.open = true;
    }
    journeyMap.show(j, lastSearch ? { from: endName(lastSearch.from), to: endName(lastSearch.to) } : undefined);
    if (fit) {
      document.querySelector("#board")!.scrollTop = 0; // the list may have been scrolled down
      fitPoints(map, journeyPath(j), FIT_MAX_ZOOM);
    }
    renderStatus();
  }

  // A connection was tapped in the list: its own history entry, so Back returns to the list.
  function openDetails(j: Journey): void {
    if (lastSearch) pushView({ kind: "journey", route: refOf(lastSearch), key: j.key });
    showDetails(j);
  }

  // The list at once; the history steps back with it (or, without an entry for the list, gets one).
  function backToList(): void {
    const key = detail ? optionKey(detail) : undefined;
    const back = previousView()?.kind === "route";
    showList(key);
    if (back) stepBackQuietly();
    else if (lastSearch) replaceView({ kind: "route", route: refOf(lastSearch) });
  }

  function onClose(): void {
    restoreSeq++;
    controller?.abort();
    controller = null;
    if (outcome.kind === "searching") outcome = { kind: "none" };
    cancelLocate(true);
    journeyMap.show(null);
    detailSeq++;
    followed = null;
    resetStatus();
  }

  // Opening a connection is no refresh: it keeps the age and a failed refresh of the answer it came from.
  function startFollowing(j: Journey): Followed {
    const f =
      outcome.kind === "plan"
        ? follow(j, outcome.fetchedAtMs, outcome.refreshFailed, Date.now())
        : follow(j, Date.now(), false, Date.now());
    follows.set(j.key, f);
    return f;
  }

  // Fresh times for the open connection (follow.ts). Failures keep the last times with their age.
  async function refreshDetail(): Promise<void> {
    const f = followed;
    if (!detail || !f || f.busy) return;
    const mine = ++detailSeq;
    const done = refreshFollowed(f, (id) => fetchTrip(id, AbortSignal.timeout(FETCH_TIMEOUT_MS)));
    renderDetailFoot(); // "loading" (busy is set by now)
    await done;
    const next = f.journey;
    // The list shows the fresh times too, when going back to it.
    if (outcome.kind === "plan") {
      outcome.plan = { ...outcome.plan, journeys: outcome.plan.journeys.map((x) => (x.key === next.key ? next : x)) };
    }
    if (pinned?.key === next.key) pinned = next;
    if (mine !== detailSeq || followed !== f || !ownsPanel(user)) return;
    showDetails(next, false, false);
  }

  // Other connections from now, between the same two ends with the same settings. The one being followed
  // stays at the top of the list until another is opened.
  function findAlternatives(): void {
    if (!lastSearch) return;
    pinned = detail;
    const request: PlanRequest = { ...lastSearch.request, time: planTime(Date.now()), arriveBy: false, cursor: null };
    const next: SubmittedSearch = { ...lastSearch, request, isNow: true };
    // This entry becomes the new list (not a step back: Back would then land on the old search).
    replaceView({ kind: "route", route: refOf(next) });
    showList();
    void search(null, false, next);
  }

  function detailNodes(j: Journey): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const back = button("link-button route-back", `← ${t().routeBack}`, "back");
    back.addEventListener("click", backToList);
    nodes.push(back);

    const summary = el("p", "route-summary");
    summary.append(clock(j.depMs, j.schedDepMs), " ", ...arrow(), " ", clock(j.arrMs, j.schedArrMs));
    const facts = [durationText(journeyMinutes(j) * 60_000), j.transfers ? t().routeTransfers(j.transfers) : t().routeDirect];
    summary.append(` · ${facts.join(" · ")}`);
    nodes.push(summary);

    const chips = el("div", "trip-chips");
    if (j.legs.some((l) => l.kind === "ride")) {
      const state = journeyState(j);
      const s = stateText(state);
      chips.append(el("span", `chip ${s.level}`, s.text));
      if (state.tight && state.kind !== "missed") chips.append(el("span", "chip late", t().tightChange));
    }
    if (departed(j, Date.now())) chips.append(el("span", "chip unknown", t().departedAlready));
    const other = otherStop(j, lastSearch);
    if (other) chips.append(el("span", "chip unknown", t().fromNeighbourStop(other)));
    if (chips.childElementCount) nodes.push(chips);

    if (followed?.changes.length) {
      const box = el("p", "board-note board-warn route-changes");
      box.append(el("strong", "", `${t().changedSinceSearch} `), followed.changes.map(changeText).join(" · "));
      box.setAttribute("role", "status");
      nodes.push(box);
    }

    const list = el("ol", "journey-legs");
    const changes = transfersOf(j);
    j.legs.forEach((leg, i) => {
      const change = leg.kind === "ride" ? changes.find((c) => c.ride === leg) : undefined;
      const walkBefore = j.legs[i - 1]?.kind === "walk";
      // A change without a walk shown (same platform or next to it): its own line with the time to spare.
      if (change && !walkBefore) list.append(transferItem(change));
      list.append(legItem(j, leg, i, changes));
    });
    nodes.push(list);
    if (followed) nodes.push(el("p", "data-note", t().dataNote));

    const foot = el("div", "route-foot route-detail-foot");
    foot.append(el("span", "route-age"));
    const actions = el("span", "foot-actions");
    const refresh = button("link-button", t().routeRefresh, "refresh");
    refresh.addEventListener("click", () => void refreshDetail());
    const alternatives = button("link-button", t().routeAlternatives, "alternatives");
    alternatives.addEventListener("click", findAlternatives);
    const whole = button("link-button", t().wholeRoute, "whole");
    whole.addEventListener("click", () => fitPoints(map, journeyPath(j), FIT_MAX_ZOOM));
    // Walking all the way has no live times: nothing to refresh.
    actions.append(...(followed ? [refresh] : []), alternatives, ...routeActions(j.key), whole);
    foot.append(actions);
    nodes.push(foot);
    return nodes;
  }

  // Share and save for the search on screen (`key`: a connection, for a link that opens it).
  function routeActions(key?: string): HTMLElement[] {
    if (!lastSearch) return [];
    const ref = refOf(lastSearch);
    const share = button("link-button", t().share, "share");
    share.addEventListener("click", () => {
      const view: View = key ? { kind: "journey", route: shared(ref), key } : { kind: "route", route: shared(ref) };
      const hasHere = ref.from?.kind === "here" || ref.to?.kind === "here";
      void shareLink(linkTo(view), searchName(lastSearch!), hasHere ? t().shareWithoutLocation : undefined);
    });
    const savable = savableRoute(ref);
    if (!savable) return [share];
    const on = isRouteSaved(savable);
    const save = button("link-button", on ? `★ ${t().routeSaved}` : t().routeSave, "save-route");
    save.setAttribute("aria-pressed", String(on));
    save.addEventListener("click", () => {
      const now = toggleRoute(savable);
      toast(now ? t().routeSavedToast : t().routeRemovedToast);
    });
    return [share, save];
  }

  function transferItem(c: Transfer): HTMLElement {
    const li = el("li", `journey-leg change ${c.level}`);
    li.append(el("span", "", transferText(c)));
    return li;
  }

  function legItem(j: Journey, leg: JourneyLeg, i: number, changes: Transfer[]): HTMLElement {
    if (leg.kind === "walk") return walkItem(j, leg, i, changes);
    const li = el("li", leg.cancelled || j.cancelled ? "journey-leg ride cancelled" : "journey-leg ride");
    li.style.setProperty("--line", rideColor(leg));
    li.append(legStop(leg.from.ms, leg.from.schedMs, leg.from));

    const mid = el("div", "journey-ride");
    if (leg.staySeated) mid.append(el("p", "journey-seated", t().routeStaySeated(leg.line)));
    const head = el("p", "journey-line");
    head.append(lineBadge(leg), el("span", "journey-headsign", shortName(leg.headsign)));
    mid.append(head);
    const facts = el("p", "route-info");
    const kind = modeLabel(leg.mode, leg.line);
    facts.append(...(kind ? [el("strong", "", kind), " · "] : []), t().routeStops(leg.stopsBetween + 1));
    const state = delayState((leg.from.ms - leg.from.schedMs) / 1000, leg.realTime, leg.cancelled);
    facts.append(" · ", el("span", `state ${state.level}`, state.text));
    mid.append(facts);
    const notices = noticeList(collectNotices([leg.alerts], Date.now()), RIDE_NOTICES);
    if (notices) mid.append(notices);
    if (leg.tripId) {
      const tripId = leg.tripId;
      const open = button("link-button", t().routeShowRide, `ride-${tripId}`);
      open.addEventListener("click", () =>
        openTrip({ tripId, line: leg.line, color: rideColor(leg), focus: [leg.from.lon, leg.from.lat] }),
      );
      mid.append(open);
    }
    li.append(mid, legStop(leg.to.ms, leg.to.schedMs, leg.to));
    return li;
  }

  // A walk: how long, where to, the change it makes (time to spare), and the directions when there are some.
  function walkItem(j: Journey, leg: WalkLeg, i: number, changes: Transfer[]): HTMLElement {
    const li = el("li", "journey-leg walk");
    const head = el("div", "walk-head");
    const icon = el("span", "route-walk");
    icon.insertAdjacentHTML("afterbegin", WALK_ICON);
    head.append(icon, el("span", "", t().routeWalkMin(leg.minutes)));
    const last = i === j.legs.length - 1;
    const first = i === 0;
    if (first && isPosition(leg.from)) head.append(el("span", "journey-to", t().routeWalkFrom(endName(lastSearch?.from ?? null))));
    const to = isPosition(leg.to) ? endName(lastSearch?.to ?? null) : shortName(leg.to.name);
    if (last || first || isPosition(leg.to)) head.append(el("span", "journey-to", t().routeWalkTo(to)));
    if (leg.schematic) head.append(el("span", "journey-to", `(${t().walkStraight})`));
    li.append(head);

    const next = j.legs[i + 1];
    const change = next?.kind === "ride" ? changes.find((c) => c.ride === next) : undefined;
    if (change) li.append(el("p", `walk-change ${change.level}`, transferText(change)));

    if (leg.steps.length > 1 || leg.steps.some((s) => s.kind === "stairs" || s.kind === "elevator")) {
      const details = el("details", "walk-steps");
      details.dataset["walk"] = String(i);
      details.append(focusKey(el("summary", "", t().walkDirections(leg.steps.length)), `walk-steps-${i}`));
      const ol = el("ol", "");
      for (const step of leg.steps) ol.append(el("li", `step ${step.kind}`, stepText(step)));
      details.append(ol);
      li.append(details);
    }
    const show = button("link-button", t().walkOnMap, `walk-${i}`);
    show.addEventListener("click", () => fitPoints(map, leg.path, 18));
    li.append(show);
    return li;
  }

  // The form is built once and kept, so typed text, picks and focus survive redraws and language switches.
  function buildForm() {
    const form = document.createElement("form");
    form.className = "route-form";
    form.id = "route-form";
    form.noValidate = true;

    // The folded form: what was searched, and a way to change it. Filled in by renderFold().
    const fold = focusKey(el("button", "route-fold") as HTMLButtonElement, "fold");
    fold.type = "button";
    fold.setAttribute("aria-controls", form.id);
    fold.addEventListener("click", () => {
      folded = !folded;
      render();
      if (!folded) fromState.input.focus();
    });

    const from = stopField("route-from");
    const to = stopField("route-to");
    const fromState: Field = { input: from.input, place: null };
    const toState: Field = { input: to.input, place: null };

    const locate = iconButton("route-locate", LOCATE_ICON);
    locate.addEventListener("click", () => void useLocation());
    from.row.append(locate);
    const swap = iconButton("route-swap", SWAP_ICON);
    swap.addEventListener("click", () => {
      restoreSeq++;
      cancelLocate(true);
      const a = fromState.place;
      const aText = fromState.input.value;
      setField(fromState, toState.place, toState.input.value);
      setField(toState, a, aText);
      renderHere();
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

    const options = prefsBox();

    // While My location is in a field: that searching sends it, and a warning when the fix is rough.
    const hereNote = el("p", "route-here");
    hereNote.setAttribute("aria-live", "polite");

    const error = el("p", "route-error");
    error.id = "route-error";
    error.setAttribute("aria-live", "polite");

    const submit = el("button", "route-submit") as HTMLButtonElement;
    submit.type = "submit";
    form.append(from.wrap, to.wrap, hereNote, when, options.box, error, submit);
    // Typing, picking a time or a setting: the user's own edits win over a link still being filled in.
    form.addEventListener("input", () => restoreSeq++);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      restoreSeq++;
      pinned = null;
      void search(null);
    });

    // Results: kept apart from the form so a redraw never touches what the user is typing.
    const results = el("div", "route-results");
    const announceEl = el("p", "sr-only");
    announceEl.setAttribute("aria-live", "polite");
    const body = el("div", "");
    results.append(announceEl, body);

    const state = {
      fold,
      form,
      results,
      body,
      announce: announceEl,
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
      hereNote,
      submit,
      options,
      isNow: true,
    };

    const picked = () => {
      restoreSeq++;
      fieldError = null;
      render();
    };
    // Typing or picking a start ends a pending location lookup: the user's choice wins.
    attachStopSearchField(board, fromState, from.list, picked, () => cancelLocate(false));
    attachStopSearchField(board, toState, to.list, picked);
    // After the stop search has cleared the field's place (typing replaces My location).
    for (const input of [from.input, to.input]) input.addEventListener("input", () => renderHere());
    return state;
  }

  // Travel settings: folded under "Options", with how many differ from the default.
  function prefsBox() {
    const box = el("details", "route-prefs") as HTMLDetailsElement;
    const summary = el("summary", "");
    box.append(summary);
    const inner = el("div", "route-prefs-body");
    const modes = el("fieldset", "route-prefs-modes");
    const modesLegend = el("legend", "");
    modes.append(modesLegend);
    const checks = (["bus", "tram", "sbahn", "train"] as const).map((key) => {
      const label = el("label", "pref-check");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.addEventListener("change", () => {
        const next = { ...prefs, [key]: input.checked };
        if (!anyMode(next)) {
          input.checked = true;
          showFieldError(t().prefsNeedMode, input);
          return;
        }
        setPrefs(next);
      });
      const text = el("span", "");
      label.append(input, text);
      modes.append(label);
      return { key, input, text };
    });
    const select = (id: string, values: readonly (number | null)[], onPick: (v: number | null) => void) => {
      const wrap = el("label", "pref-select") as HTMLLabelElement;
      wrap.htmlFor = id;
      const text = el("span", "");
      const sel = document.createElement("select");
      sel.id = id;
      sel.className = "route-input";
      sel.addEventListener("change", () => onPick(values[sel.selectedIndex] ?? null));
      wrap.append(text, sel);
      return { wrap, text, sel, values };
    };
    const transfers = select("pref-transfers", TRANSFER_CHOICES, (v) => setPrefs({ ...prefs, maxTransfers: v }));
    const extra = select("pref-extra", EXTRA_CHOICES, (v) => setPrefs({ ...prefs, extraMin: v ?? 0 }));
    const walk = select("pref-walk", WALK_CHOICES, (v) => setPrefs({ ...prefs, walkMin: v ?? DEFAULT_PREFS.walkMin }));
    const reset = button("link-button", "", "prefs-reset");
    reset.addEventListener("click", () => setPrefs({ ...DEFAULT_PREFS }));
    inner.append(modes, transfers.wrap, extra.wrap, walk.wrap, el("p", "route-prefs-note"), reset);
    box.append(inner);
    return { box, summary, modesLegend, checks, transfers, extra, walk, reset, note: inner.querySelector("p")! };
  }

  function setPrefs(next: TravelPrefs, remember = true): void {
    prefs = next;
    if (remember) savePrefs(prefs);
    fieldError = null;
    applyPrefs();
    render();
  }

  // The settings box as `prefs` says, in the current language.
  function applyPrefs(): void {
    if (!built) return;
    const o = built.options;
    const x = t();
    const n = changedPrefs(prefs);
    o.summary.textContent = n ? x.prefsChanged(n) : x.prefsTitle;
    o.modesLegend.textContent = x.prefsModes;
    const names = { bus: x.modeBus, tram: x.prefsTram, sbahn: x.modeSBahn, train: x.prefsTrain };
    for (const c of o.checks) {
      c.input.checked = prefs[c.key];
      c.text.textContent = names[c.key];
    }
    const fill = (s: typeof o.transfers, label: string, text: (v: number | null) => string, current: number | null) => {
      s.text.textContent = label;
      s.sel.replaceChildren(...s.values.map((v) => el("option", "", text(v))));
      s.sel.selectedIndex = Math.max(0, s.values.indexOf(current));
    };
    fill(o.transfers, x.prefsTransfers, (v) => (v === null ? x.prefsDefaultMax(PLAN_MAX_TRANSFERS) : v === 0 ? x.prefsDirectOnly : x.prefsAtMost(v)), prefs.maxTransfers);
    fill(o.extra, x.prefsExtra, (v) => (v ? `+ ${v} min` : x.prefsNormal), prefs.extraMin);
    fill(o.walk, x.prefsWalk, (v) => x.prefsUpTo(v ?? 0), prefs.walkMin);
    o.note.textContent = x.prefsNote;
    o.reset.textContent = x.prefsReset;
    o.reset.hidden = n === 0;
  }

  function pick(field: Field, place: Station | Spot): void {
    setField(field, place, isSpot(place) ? place.name : shortName(place.name));
  }

  function setField(field: Field, place: Place | null, text: string): void {
    field.place = place;
    field.input.value = text;
    field.input.removeAttribute("aria-invalid");
  }

  function fillNow(): void {
    if (!built) return;
    const { date, time } = berlinDateTime(Date.now());
    built.date.value = date;
    built.time.value = time;
  }

  // The date picker offers only days the Worker accepts (2 hours back to 7 days ahead, Bonn dates).
  function setDateBounds(): void {
    if (!built) return;
    built.date.min = berlinDateTime(Date.now() - PLAN_PAST_MS).date;
    built.date.max = berlinDateTime(Date.now() + PLAN_AHEAD_MS).date;
  }

  // The phone's position as the start: Transitous then plans the walk to whichever stop works best. While the
  // position is being found, From is empty and holds nothing, so a search cannot go out with the old start.
  // Each lookup has a number: when the user moves on (types or picks a start, swaps, closes the panel, opens
  // it from a board), the lookup is cancelled, and its late answer changes nothing.
  async function useLocation(): Promise<void> {
    const b = built!;
    if (!window.isSecureContext || !("geolocation" in navigator)) {
      showFieldError(t().needsHttps, b.from.input);
      return;
    }
    cancelLocate(false);
    const mine = ++locateSeq;
    locating = { place: b.from.place, text: b.from.input.value };
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
      const { latitude: lat, longitude: lon } = pos.coords;
      releaseLocate();
      if (isInArea(lat, lon)) {
        setField(b.from, { here: true, lat, lon, accuracyM: pos.coords.accuracy }, t().routeHere);
        fieldError = null;
        render();
      } else {
        setField(b.from, before.place, before.text);
        showFieldError(t().routeOutsideArea, b.from.input);
      }
    } catch (err) {
      if (!current()) return;
      releaseLocate();
      setField(b.from, before.place, before.text);
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
    if (restore) setField(built.from, before.place, before.text);
  }

  // Always null, so a check can say `return refuse(...)`.
  function refuse(text: string, input: HTMLInputElement): null {
    showFieldError(text, input);
    return null;
  }

  function showFieldError(text: string, input: HTMLElement): void {
    fieldError = text;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    render();
  }

  // `cursor`: an earlier/later page of the last search; `again`: refresh it. Both use only the submitted
  // search, never the form, so unsent edits in the form stay as they are. `given`: a search made elsewhere
  // (alternatives, a link). None of them: a new search from the form.
  async function search(cursor: string | null, again = false, given?: SubmittedSearch): Promise<void> {
    const b = built!;
    let submitted: SubmittedSearch;
    if (given) {
      submitted = given;
    } else if (cursor !== null || again) {
      if (!lastSearch) return;
      const request = again ? refreshRequest(lastSearch, Date.now()) : { ...lastSearch.request, cursor };
      if (!request) {
        // A chosen time that is now too far back: keep the connections, send nothing, and open the form at the
        // date, where the reason is shown and a new time can be picked.
        if (outcome.kind === "plan") outcome = { ...outcome, refreshFailed: true, pageFailed: null };
        folded = false;
        render();
        showFieldError(t().routeTimeRange, b.date);
        return;
      }
      submitted = { ...lastSearch, request };
    } else {
      const page = pendingPage; // used once, by this search only
      pendingPage = null;
      const request = checkForm();
      if (!request) return;
      // A link to a connection found with "Later": the same page of the same search.
      if (page) request.cursor = page;
      // checkForm only passes with both ends picked
      const from = b.from.place!;
      const to = b.to.place!;
      submitted = {
        request,
        isNow: b.isNow,
        from: placeName(from),
        to: placeName(to),
        ends: { from: endRef(from), to: endRef(to) },
      };
    }
    const { request } = submitted;
    const fromForm = cursor === null && !again && !given;

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
      // New times for every connection: they are followed afresh when opened (the pinned one goes on).
      const keep = pinned ? follows.get(pinned.key) : undefined;
      follows = new Map(keep ? [[keep.journey.key, keep]] : []);
      // A stale copy (first search, page or refresh) is shown, but marked: the latest try for news failed.
      outcome = {
        kind: "plan",
        plan: parsePlan(res.data, request.prefs?.["walk"] !== undefined),
        fetchedAtMs: res.fetchedAtMs,
        refreshFailed: isStale(res),
        pageFailed: null,
      };
      const n = outcome.plan.journeys.length + (outcome.plan.walk ? 1 : 0);
      announce = () => (n ? t().routeFound(n) : t().routeNone);
      b.announce.textContent = announce();
      found = n > 0;
      if (fromForm || given) folded = found; // fold only when there is something to look at
      if (ownsPanel(user) && !detail) {
        const route = refOf(submitted);
        replaceView(pendingKey === null ? { kind: "route", route } : { kind: "journey", route, key: pendingKey });
      }
    } catch (err) {
      if (controller !== mine) return;
      // Anything that is not a refusal from the Worker (a bug while reading the answer, say) counts as "no
      // answer", so the panel never stays at "Searching...".
      const failure = err instanceof PlanError ? err : new PlanError(null, null);
      // A refresh that fails keeps the connections on screen, marked as not refreshed. A failed page keeps
      // them too, with the reason next to Earlier / Later, which try again.
      if (again && previous.kind === "plan") {
        outcome = { ...previous, refreshFailed: true, pageFailed: null };
      } else if (cursor !== null && previous.kind === "plan") {
        const pageFailed = { failure: planFailure(failure.status, navigator.onLine), retryAfterS: failure.retryAfterS };
        outcome = { ...previous, pageFailed };
        announce = () => failureText(pageFailed.failure, pageFailed.retryAfterS);
        b.announce.textContent = announce();
      } else {
        const failed = { failure: planFailure(failure.status, navigator.onLine), retryAfterS: failure.retryAfterS };
        outcome = { kind: "failed", ...failed };
        // A failed search from the form keeps the form open; a failed page keeps the fold as it was.
        if (fromForm || given) folded = found = false;
        announce = () => failureText(failed.failure, failed.retryAfterS);
        b.announce.textContent = announce();
      }
    } finally {
      clearTimeout(timer);
      if (controller === mine) controller = null;
    }
    render();
    if (!ownsPanel(user)) return;
    // A connection asked for by a link or Back: open it now that its search has answered.
    if (pendingKey !== null) {
      const key = pendingKey;
      pendingKey = null;
      const j = outcome.kind === "plan" ? findJourney(outcome.plan, key) : undefined;
      if (j) {
        showDetails(j);
        return;
      }
      toast(t().journeyGone);
    }
    if (keep) refocus(b.body, keep);
    else if (fromForm || given) {
      // Folded, the summary and the heading both fit at the top: show both instead of scrolling half of it away.
      if (!b.form.hidden) b.body.querySelector<HTMLElement>("h3")?.focus();
      else {
        document.querySelector("#board")!.scrollTop = 0;
        b.body.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
      }
    }
  }

  // The form as a request, or null after pointing at what is missing or wrong.
  function checkForm(): PlanRequest | null {
    const b = built!;
    fieldError = null;
    timeNote = null;
    setDateBounds(); // the panel may have stayed open past midnight
    for (const input of [b.from.input, b.to.input, b.date, b.time]) input.removeAttribute("aria-invalid");
    const from = b.from.place;
    const to = b.to.place;
    if (locating) return refuse(t().routeLocating, b.from.input);
    if (!from) return refuse(t().routePickFrom, b.from.input);
    if (!to) return refuse(t().routePickTo, b.to.input);
    if (placeParam(from) === placeParam(to)) return refuse(t().routeSameStop, b.to.input);
    // A stop outside the area (opened from a trip card): the Worker plans only inside it.
    for (const [place, input] of [[from, b.from.input], [to, b.to.input]] as const) {
      const sent = placeParam(place);
      if (!isAreaStopId(sent) && !isValidPosition(sent)) return refuse(t().routeStopOutside, input);
    }

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
    return {
      from: placeParam(from),
      to: placeParam(to),
      time: planTime(ms),
      arriveBy: b.arrive.input.checked,
      cursor: null,
      prefs: prefsQuery(prefs),
    };
  }

  function applyTexts(): void {
    const b = built!;
    const x = t();
    b.fromLabel.textContent = x.routeFrom;
    b.toLabel.textContent = x.routeTo;
    if (!locating) b.from.input.placeholder = x.routeFromHint;
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
    for (const field of [b.from, b.to]) if (isHere(field.place)) field.input.value = x.routeHere;
    applyPrefs();
  }

  function render(): void {
    if (!built || !ownsPanel(user) || detail) return;
    const b = built;
    const searching = outcome.kind === "searching";
    b.submit.disabled = searching;
    b.submit.textContent = searching ? t().routeSearching : t().routeSearch;
    b.now.setAttribute("aria-pressed", String(b.isNow));
    b.error.textContent = fieldError ?? timeNote ?? "";
    b.error.classList.toggle("note", fieldError === null);
    b.results.setAttribute("aria-busy", String(searching));

    renderFold();
    renderHere();

    // Focus inside the results (Earlier, Later, Refresh) comes back after the redraw.
    const key = focusedKey(b.body);
    b.body.replaceChildren(...resultNodes());
    if (key) refocus(b.body, key);
    renderStatus();
  }

  function renderHere(): void {
    if (!built) return;
    const b = built;
    const here = [b.from.place, b.to.place].find(isHere);
    if (!here) {
      b.hereNote.replaceChildren();
      return;
    }
    const x = t();
    const more = el("a", "", x.routeHereMore) as HTMLAnchorElement;
    more.href = `${x.privacyUrl}#location`;
    more.target = "_blank";
    more.rel = "noopener";
    b.hereNote.replaceChildren(x.routeHereNote, " ", more);
    if (here.accuracyM > ROUGH_LOCATION_M) {
      b.hereNote.prepend(el("strong", "route-rough", x.routeHereRough(distanceText(here.accuracyM))), " ");
    }
  }

  // The summary button shows while connections are on screen; the form hides behind it when folded. It
  // describes the submitted search, not the form, which may hold edits that were not sent.
  function renderFold(): void {
    const b = built!;
    const show = found && lastSearch !== null;
    const hide = show && folded;
    b.fold.hidden = !show;
    b.form.hidden = hide;
    b.fold.setAttribute("aria-expanded", String(!hide));
    if (!lastSearch) return;
    const s = lastSearch;
    const text = el("span", "route-fold-text");
    text.append(el("b", "", endName(s.from)), " ", ...arrow(), " ", el("b", "", endName(s.to)), ` · ${whenText(s)}`);
    const n = Object.keys(s.request.prefs ?? {}).length;
    if (n) text.append(` · ${t().prefsChanged(n)}`);
    b.fold.replaceChildren(text, el("span", "route-fold-action", hide ? t().routeEdit : t().routeFoldHide));
  }

  function resultNodes(): HTMLElement[] {
    if (outcome.kind === "none") return savedRoutesNodes();
    if (outcome.kind === "searching") return [el("p", "board-note", t().routeSearching)];
    if (outcome.kind === "failed") {
      return [el("p", "board-note board-error", failureText(outcome.failure, outcome.retryAfterS)), ...savedRoutesNodes()];
    }

    const { plan } = outcome;
    const now = Date.now();
    const heading = el("h3", "route-heading", t().routeResults);
    heading.tabIndex = -1;
    const nodes: HTMLElement[] = [heading];

    if (pinned) {
      const followedOne = pinned;
      nodes.push(el("p", "route-subheading", t().routeYourJourney));
      const list = el("ul", "route-options pinned");
      list.append(journeyOption(followedOne, () => openDetails(followedOne), now, lastSearch));
      nodes.push(list);
      nodes.push(el("p", "route-subheading", t().routeOthersNow));
    }

    if (!plan.journeys.length && !plan.walk) {
      nodes.push(el("p", "board-note", t().routeNone));
      // Strict settings may be why: say so, with a way to search again without them.
      if (lastSearch && Object.keys(lastSearch.request.prefs ?? {}).length) {
        nodes.push(el("p", "board-note", t().prefsMaybeWhy));
        const relax = button("route-page", t().prefsResetSearch, "relax");
        relax.addEventListener("click", () => {
          setPrefs({ ...DEFAULT_PREFS });
          void search(null, false, { ...lastSearch!, request: { ...lastSearch!.request, prefs: {}, cursor: null } });
        });
        nodes.push(relax);
      }
    } else {
      // Connections that have already left (an arrive-by search, or a list left open) go below the others,
      // marked, so they are not taken for something still to catch.
      const coming = plan.journeys.filter((j) => !departed(j, now));
      const gone = plan.journeys.filter((j) => departed(j, now));
      goneShown = gone.length;
      const list = el("ul", "route-options");
      const walk = plan.walk;
      if (walk) list.append(walkOption(walk, () => openDetails(walk)));
      for (const j of coming) list.append(journeyOption(j, () => openDetails(j), now, lastSearch));
      if (list.childElementCount) nodes.push(list);
      if (gone.length) {
        nodes.push(el("p", "route-subheading", t().departedHeading));
        const past = el("ul", "route-options past");
        for (const j of gone) past.append(journeyOption(j, () => openDetails(j), now, lastSearch));
        nodes.push(past);
      }
    }

    const pager = el("div", "route-pager");
    if (plan.earlier) pager.append(pagerButton(t().routeEarlier, "earlier", plan.earlier));
    if (plan.later) pager.append(pagerButton(t().routeLater, "later", plan.later));
    if (pager.childElementCount) nodes.push(pager);
    const failed = outcome.pageFailed;
    if (failed) nodes.push(el("p", "board-note board-error", failureText(failed.failure, failed.retryAfterS)));

    const foot = el("div", "route-foot");
    foot.append(el("span", "route-age"));
    const actions = el("span", "foot-actions");
    const refresh = button("link-button", t().routeRefresh, "refresh");
    refresh.addEventListener("click", () => void search(null, true));
    actions.append(refresh, ...routeActions());
    foot.append(actions);
    nodes.push(foot);
    return nodes;
  }

  // Saved routes under an empty form: one tap fills it in and searches.
  function savedRoutesNodes(): HTMLElement[] {
    const routes = loadSaved().routes;
    if (!routes.length) return [];
    const nodes: HTMLElement[] = [el("h3", "route-heading", t().savedRoutes)];
    const list = el("ul", "saved-routes");
    routes.forEach((r, i) => {
      const li = el("li", "");
      const btn = button("saved-route", `${endRefName(r.from)} → ${endRefName(r.to)}`, `saved-${i}`);
      btn.addEventListener("click", () => openSaved(r));
      li.append(btn);
      list.append(li);
    });
    nodes.push(list);
    return nodes;
  }

  function pagerButton(text: string, key: string, cursor: string): HTMLElement {
    const btn = button("route-page", text, key);
    btn.addEventListener("click", () => void search(cursor));
    return btn;
  }

  // Status line and the age line under the connections or details (fresh: green; old or not refreshed: red).
  function renderStatus(): void {
    const title = outcome.kind === "plan" && lastSearch ? searchName(lastSearch) : routeName();
    if (detail && followed) {
      const ageS = Math.max(0, (Date.now() - followed.fetchedAtMs) / 1000);
      setStatus(title, ageS, followed.failed);
      renderDetailFoot();
      return;
    }
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

  // The age line under an open connection: how old its rides' times are, and that they refresh by themselves.
  function renderDetailFoot(): void {
    if (!followed) return;
    const ageS = Math.max(0, (Date.now() - followed.fetchedAtMs) / 1000);
    const old = ageS > STALE_AFTER_S;
    const slot = document.querySelector("#board-body .route-age");
    const text = followed.busy
      ? `${ageText(ageS, old)} · ${t().loading}`
      : followed.failed
        ? ageText(ageS, old, true)
        : followEnded(followed, Date.now())
          ? `${ageText(ageS, old)} · ${t().followEnded}`
          : `${ageText(ageS, old)} · ${t().everyMinute}`;
    slot?.replaceChildren(ageLine(text, old || followed.failed));
  }

  function routeName(): string {
    const b = built!;
    const from = b.from.place;
    const to = b.to.place;
    return from && to ? `${endName(placeName(from))} → ${endName(placeName(to))}` : t().routeTitle;
  }

  // Fill the form from route ends (a saved route, a link). Stops are looked up in the stop list; My location
  // is asked for again. Returns false when an end cannot be used (an unknown stop), null when something newer
  // happened while the stop list was loading (see restoreSeq): then nothing is filled in.
  async function fillEnds(ends: { from: EndRef | null; to: EndRef | null }): Promise<boolean | null> {
    const mine = ++restoreSeq;
    await board.stationsReady;
    if (mine !== restoreSeq || !ownsPanel(user)) return null;
    const b = built!;
    let ok = true;
    const toPlace = (e: EndRef | null): Place | null => {
      if (!e || e.kind === "here") return null;
      if (e.kind === "spot") return e;
      const station = findStation(board.stations(), e.id);
      if (!station) ok = false;
      return station;
    };
    cancelLocate(false);
    for (const [field, end] of [
      [b.from, ends.from],
      [b.to, ends.to],
    ] as const) {
      const place = toPlace(end);
      setField(field, place, place ? (isSpot(place) ? place.name : shortName((place as Station).name)) : "");
    }
    return ok;
  }

  // A saved route: fill in the form and search (with My location: find it first, then the user searches).
  function openSaved(r: SavedRoute): void {
    built ??= buildForm();
    openPanel(user);
    applyTexts();
    pushView({ kind: "route", route: { from: r.from, to: r.to, time: null, arriveBy: false, prefs: r.prefs } });
    void (async () => {
      const ok = await fillEnds(r);
      if (ok === null) return;
      setPrefs(prefsFromQuery(r.prefs), false);
      built!.isNow = true;
      built!.arrive.input.checked = false;
      built!.depart.input.checked = true;
      fillNow();
      folded = false;
      pinned = null;
      showList();
      if (!ok) {
        showFieldError(t().savedStopGone, built!.from.input);
        return;
      }
      if (r.from.kind === "here" || r.to.kind === "here") {
        if (r.from.kind === "here") void useLocation();
        return;
      }
      void search(null);
    })();
  }

  // Back / Forward / a link: the search (and connection) of that history entry. The one on screen is reused
  // when it is the same search; else the form is filled in and the search runs again (a link carries the
  // search, not the connection's times, so these are fresh).
  function restore(view: Extract<View, { kind: "route" | "journey" }>): void {
    built ??= buildForm();
    openPanel(user);
    applyTexts();
    const key = view.kind === "journey" ? view.key : null;
    if (lastSearch && outcome.kind === "plan" && sameRoute(refOf(lastSearch), view.route)) {
      const j = key ? findJourney(outcome.plan, key) : undefined;
      if (j) showDetails(j);
      else showList(detail ? optionKey(detail) : undefined);
      return;
    }
    showList();
    void (async () => {
      const ok = await fillEnds(view.route);
      if (ok === null) return;
      setPrefs(prefsFromQuery(view.route.prefs), false);
      const b = built!;
      b.arrive.input.checked = view.route.arriveBy;
      b.depart.input.checked = !view.route.arriveBy;
      b.isNow = view.route.time === null;
      if (view.route.time) {
        const ms = Date.parse(view.route.time); // a real time (parseViewHash checks)
        const { date, time } = berlinDateTime(ms);
        b.date.value = date;
        b.time.value = time;
        if (ms < Date.now() - PLAN_PAST_MS) {
          b.isNow = true; // an old link: from now instead, and said so
          toast(t().linkFromNow);
        }
      }
      if (b.isNow) fillNow();
      folded = false;
      render();
      if (!ok) {
        showFieldError(t().savedStopGone, b.from.input);
        return;
      }
      if (!b.from.place || !b.to.place) {
        // A link without the start (it was "My location" for whoever shared it): ask for one.
        if (!b.from.place) showFieldError(t().routePickFrom, b.from.input);
        return;
      }
      pendingKey = key;
      // A page only while the planner still has it (the Worker takes cursors from 2 hours back); an older
      // link starts at the first page, and its connection is then most likely gone (said so).
      const page = view.route.page;
      pendingPage = page && Number(page.split("|")[1]) * 1000 >= Date.now() - PLAN_PAST_MS ? page : null;
      void search(null);
    })();
  }

  return { open, openSaved, restore };
}

// Wires one From/To field to the shared stop search (the same combobox as the header search), with the place
// search for addresses and landmarks, and saved stops while it is empty.
// `onEdit`: the user typed in or picked for this field (before the change is applied).
function attachStopSearchField(
  board: Board,
  field: Field,
  list: HTMLUListElement,
  onChange: () => void,
  onEdit?: () => void,
): void {
  const set = (place: Place, text: string) => {
    onEdit?.();
    field.place = place;
    field.input.value = text;
    field.input.removeAttribute("aria-invalid");
    onChange();
  };
  attachStopSearch({
    input: field.input,
    list,
    board,
    clearOnEscape: false,
    onType() {
      onEdit?.();
      field.place = null;
      field.input.removeAttribute("aria-invalid");
    },
    openOnFocus: () => field.place === null,
    onPick: (station) => set(station, shortName(station.name)),
    onPickSpot: (spot) => set(spot, spot.name),
    emptyItems: (): SearchItem[] =>
      loadSaved()
        .stops.map((s) => findStation(board.stations(), s.id))
        .filter((s): s is Station => s !== null && isStopSaved(stationIds(s)))
        .map((s) => ({ label: shortName(s.name), sub: t().saved, kind: "saved" as const, run: () => set(s, shortName(s.name)) })),
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

// What is sent for a route end: a stop ID, or a position (My location, an address, a point on the map).
function placeParam(p: Place): string {
  if (isHere(p) || isSpot(p)) return positionPlace(p.lat, p.lon);
  return p.planStopId;
}

// A route end's name as shown; null for My location (named in the language shown at the time).
function placeName(p: Place): string | null {
  if (isHere(p)) return null;
  return isSpot(p) ? p.name : shortName(p.name);
}

function endRef(p: Place): EndRef {
  if (isHere(p)) return { kind: "here" };
  if (isSpot(p)) return p;
  return { kind: "stop", id: p.id, name: shortName(p.name) };
}

function endRefName(e: EndRef): string {
  return e.kind === "here" ? t().routeHere : e.name;
}

function refOf(s: SubmittedSearch): RouteRef {
  return {
    from: s.ends.from,
    to: s.ends.to,
    time: s.isNow ? null : s.request.time,
    arriveBy: s.request.arriveBy,
    prefs: s.request.prefs ?? {},
    ...(s.request.cursor ? { page: s.request.cursor } : {}),
  };
}

// For a link: My location is left out (shareableView does the same for whole views).
function shared(r: RouteRef): RouteRef {
  const strip = (e: EndRef | null) => (e?.kind === "here" ? null : e);
  return { ...r, from: strip(r.from), to: strip(r.to) };
}

// A connection of an answer by its key: one with rides, or walking all the way.
function findJourney(plan: Plan, key: string): Journey | undefined {
  return plan.journeys.find((x) => x.key === key) ?? (plan.walk?.key === key ? plan.walk : undefined);
}

function sameRoute(a: RouteRef, b: RouteRef): boolean {
  const ends = (x: EndRef | null, y: EndRef | null) => (x === null && y === null) || sameEnd(x, y);
  return (
    ends(a.from, b.from) &&
    ends(a.to, b.to) &&
    a.time === b.time &&
    a.arriveBy === b.arriveBy &&
    (a.page ?? null) === (b.page ?? null) &&
    JSON.stringify(Object.entries(a.prefs).sort()) === JSON.stringify(Object.entries(b.prefs).sort())
  );
}

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

// A line badge with what kind of vehicle it is in front: a small icon for the eye, the word for screen
// readers. A bus with a train-like name (RE5X, a replacement bus) reads "Bus" before it is opened.
function rideChip(leg: RideLeg): HTMLElement {
  const chip = el("span", "route-ride");
  const icon = el("span", "mode-icon");
  icon.insertAdjacentHTML("afterbegin", modeIcon(leg.mode));
  icon.setAttribute("aria-hidden", "true");
  const kind = modeLabel(leg.mode, leg.line);
  chip.append(icon);
  if (kind) chip.append(srOnly(`${kind} `));
  chip.append(lineBadge(leg));
  return chip;
}

function modeIcon(mode: Mode): string {
  if (mode === "BUS" || mode === "ODM" || mode === "COACH") return BUS_ICON;
  if (mode === "TRAM" || mode === "SUBWAY" || mode === "FUNICULAR") return TRAM_ICON;
  return TRAIN_ICON;
}

// A stop in the details: the time (planned struck through when different), its name with the town spelled
// out ("Köln Dasselstr./Süd Bf"), and the platform (a changed one marked).
function legStop(ms: number, schedMs: number, s: LegStop): HTMLElement {
  const row = el("div", "journey-stop");
  row.append(clock(ms, schedMs), el("span", "journey-stop-dot"));
  const label = el("span", "journey-stop-name", townName(s.name));
  if (s.platform) {
    const text = s.plannedPlatform ? t().platformChanged(s.platform, s.plannedPlatform) : s.platform;
    label.append(el("small", s.plannedPlatform ? "platform-change" : "", ` ${text}`));
  }
  row.append(label);
  return row;
}

// A journey searched from a stop that leaves from another one without a walk shown in between (Transitous
// counts close stops with similar names as the same place: "Bonn Hbf" may mean the buses at Colmantstr.):
// that stop's name with its platform, so it is not missed. Null when it leaves where it was asked to.
function otherStop(j: Journey, search: SubmittedSearch | null): string | null {
  const first = j.legs[0];
  if (!search || search.ends.from.kind !== "stop" || first?.kind !== "ride") return null;
  const name = shortName(first.from.name);
  if (name === search.ends.from.name) return null;
  return [name, first.from.platform].filter(Boolean).join(" · ");
}

// The state of a whole journey in words, with its colour level.
function stateText(s: JourneyState): { text: string; level: string } {
  const delay = formatDelay(s.delaySec);
  switch (s.kind) {
    case "cancelled":
      return { text: t().cancelled, level: "verylate" };
    case "missed":
      return { text: t().connectionAtRisk, level: "verylate" };
    case "timetable":
      return { text: t().timetableOnly, level: "unknown" };
    case "partial":
      return delay ? { text: t().partlyLiveDelay(delay), level: delayLevel(s.delaySec, true) } : { text: t().partlyLive, level: "unknown" };
    default:
      return delay ? { text: t().liveDelay(delay), level: delayLevel(s.delaySec, true) } : { text: t().onTimeShort, level: "ontime" };
  }
}

function transferText(c: Transfer): string {
  const spare = Math.floor(c.slackS / 60);
  const walk = Math.ceil(c.walkS / 60);
  if (c.level === "missed") return t().changeMissed(walk);
  return c.level === "tight" ? t().changeTight(spare, walk) : t().changeTime(spare, walk);
}

function changeText(c: RideChange): string {
  const fmt = (m: number) => (m ? formatDelay(m * 60) : t().onTimeShort);
  switch (c.kind) {
    case "cancelled":
      return t().rideNowCancelled(c.line);
    case "noLive":
      return t().rideNoLive(c.line);
    case "arrival":
      return t().rideArrivalChanged(c.line, fmt(c.afterMin), fmt(c.beforeMin));
    case "platform":
      return t().ridePlatformChanged(c.line, c.platform ?? "");
    case "arrPlatform":
      return t().rideArrPlatformChanged(c.line, c.platform ?? "");
    default:
      return t().rideDelayChanged(c.line, fmt(c.afterMin), fmt(c.beforeMin));
  }
}

// How many connections have left by `nowMs` (they are listed apart).
function goneCount(plan: Plan, nowMs: number): number {
  return plan.journeys.filter((j) => departed(j, nowMs)).length;
}

function stepText(s: { kind: string; street: string; distanceM: number }): string {
  const m = `${Math.max(1, Math.round(s.distanceM))} m`;
  const x = t();
  switch (s.kind) {
    case "stairs":
      return x.stepStairs;
    case "elevator":
      return x.stepElevator;
    case "left":
      return s.street ? x.stepLeftInto(s.street, m) : x.stepLeft(m);
    case "right":
      return s.street ? x.stepRightInto(s.street, m) : x.stepRight(m);
    case "uturn":
      return x.stepUturn(m);
    default:
      return s.street ? x.stepAlong(s.street, m) : x.stepStraight(m);
  }
}

// One connection, as a button that opens its details: times (live, planned struck through when different),
// duration, the chain of lines and walks, then where it starts, the changes and the state of the whole
// journey (all its rides, not just the first). Inside a button only spans are allowed.
function journeyOption(j: Journey, onOpen: () => void, nowMs: number, search: SubmittedSearch | null): HTMLElement {
  const li = el("li", "");
  const gone = departed(j, nowMs);
  const classes = ["route-option", j.cancelled ? "cancelled" : "", gone ? "past" : ""].filter(Boolean).join(" ");
  const btn = focusKey(el("button", classes) as HTMLButtonElement, optionKey(j));
  btn.type = "button";
  btn.addEventListener("click", onOpen);
  li.append(btn);
  // Screen readers hear "21:46 bis 22:16, 30 min, Zug RB26, 8 min Fußweg, Stadtbahn 16, ab ...": the arrow and
  // the "›" are hidden from them, a hidden word and commas take their place.
  const top = el("span", "route-times");
  top.append(clock(j.depMs, j.schedDepMs), ...arrow(), clock(j.arrMs, j.schedArrMs));
  top.append(srOnly(", "), el("span", "route-duration", durationText(journeyMinutes(j) * 60_000)));
  btn.append(top);

  const chain = el("span", "route-chain");
  chain.append(srOnly(", "));
  j.legs.forEach((leg, i) => {
    if (i > 0) chain.append(hidden(el("span", "route-sep", "›")), srOnly(", "));
    chain.append(leg.kind === "walk" ? walkChip(leg.minutes) : rideChip(leg));
  });
  btn.append(chain);

  const ride = firstRide(j);
  const details: string[] = [];
  if (gone) details.push(t().departedAlready);
  const other = otherStop(j, search);
  if (other) details.push(t().fromNeighbourStop(other));
  else if (ride) details.push(t().routeFromStop([shortName(ride.from.name), ride.from.platform].filter(Boolean).join(" · ")));
  details.push(j.transfers ? t().routeTransfers(j.transfers) : t().routeDirect);
  const info = el("span", "route-info");
  info.append(srOnly(", "), details.join(" · "));
  const state = journeyState(j);
  const s = stateText(state);
  info.append(" · ", el("span", `state ${s.level}`, s.text));
  if (state.tight && state.kind !== "missed") info.append(" · ", el("span", "state late", t().tightChange));
  const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride");
  if (rides.some((r) => collectNotices([r.alerts], nowMs).length)) info.append(" · ", el("span", "state late", t().noticeShort));
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

// "450 m", "1.2 km" ("1,2 km" in German).
function distanceText(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  const km = (m / 1000).toFixed(1);
  return `${getLang() === "de" ? km.replace(".", ",") : km} km`;
}

// A submitted search's ends keep My location as null, so its name follows a language switch.
const endName = (name: string | null): string => name ?? t().routeHere;
const searchName = (s: SubmittedSearch): string => `${endName(s.from)} → ${endName(s.to)}`;

// When a submitted search leaves or arrives, for the folded summary: "jetzt", "ab 21:39", "an 26. Okt. 08:15".
function whenText(s: SubmittedSearch): string {
  if (s.isNow) return t().routeFoldNow;
  const ms = Date.parse(s.request.time);
  const { date, time } = berlinDateTime(ms);
  // "26. Okt." / "26 Oct" (British order, not the US "Oct 26")
  const dayFormat = new Intl.DateTimeFormat(getLang() === "de" ? "de-DE" : "en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Berlin",
  });
  const day = date === berlinDateTime(Date.now()).date ? "" : `${dayFormat.format(ms)} `;
  return s.request.arriveBy ? t().routeFoldArrive(day + time) : t().routeFoldDepart(day + time);
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
const BUS_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 21v-3M16 21v-3"/><circle cx="8" cy="14.5" r=".5"/><circle cx="16" cy="14.5" r=".5"/></svg>';
const TRAM_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="6" width="14" height="13" rx="3"/><path d="M12 6V2M8 2h8M5 13h14M8 22l1-3M16 22l-1-3"/></svg>';
const TRAIN_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a2 2 0 0 1 2 2v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2zM4 11h16M12 3v8M7 22l2-4M17 22l-2-4"/></svg>';
