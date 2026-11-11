// Browser history for the panel: every stop, trip, place, route search and connection that is opened gets
// its own history entry, so Back (the button, or the phone's back gesture) steps back inside the app instead
// of leaving it, and Forward goes on again. The address shows the open view after "#", so a reload or a
// copied link opens it again (endpoints.ts says what goes into it).
//
// Entries carry their depth: 0 is the empty map. Closing the panel goes back to depth 0, so after a close,
// Back leaves the site as expected instead of reopening things one by one.
//
// The live overview's state (city, kinds, picked line) is not a panel: changing it adds no entry. With no
// panel open the address shows it (#city=..., nothing for the overview as a first visit shows it), so copying
// the address or reloading keeps it; every entry also carries it, so a reload with a panel open keeps it too.

import { type LiveRef, type View, liveHash, parseLiveHash, parseViewHash, viewHash } from "./endpoints";

interface Entry {
  app: "nahverkehr";
  depth: number;
  view: View | null;
  live?: LiveRef | null; // the overview's state when this entry was last on screen
}

type Handler = (view: View | null) => void;

let handler: Handler = () => {};
let restoring = false; // a view is being opened because of Back / Forward / a reload: do not add entries
let closing = false; // Close went back to depth 0; that step's popstate needs no action
let quiet = false; // a step back whose view the app already shows (stepBackQuietly)
// The views of this tab's entries by depth, as far as this page has seen them (lost on reload).
const seen: (View | null)[] = [];
let lastDepth = 0; // the depth of the entry on screen
let live: LiveRef | null = null; // the overview's current state (setLive)
let onLiveLink: (ref: LiveRef) => void = () => {};

function current(): Entry | null {
  const s = history.state as Partial<Entry> | null;
  const entry = s && s.app === "nahverkehr" && typeof s.depth === "number" ? (s as Entry) : null;
  if (entry) lastDepth = entry.depth;
  return entry;
}

const depth = (): number => current()?.depth ?? 0;

// No panel open: the overview's state, if there is one.
function urlFor(view: View | null): string {
  const hash = view ? viewHash(view) : live ? liveHash(live) : "";
  return `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`;
}

const entry = (depth: number, view: View | null): Entry => ({ app: "nahverkehr", depth, view, live });

// The overview's state changed (another city, kind or line): the entry on screen follows, no new one. Any
// entry without a panel shows the overview in its address, whatever its depth (a pasted overview link sits
// above depth 0).
export function setLive(ref: LiveRef): void {
  live = ref;
  const now = current();
  if (!now) return; // before startNav: initialView writes it
  history.replaceState(entry(now.depth, now.view), "", now.view ? location.href : urlFor(null));
}

// The overview state a reload of this entry should restore (a panel's address does not carry it).
export function savedLive(): LiveRef | null {
  const s = (history.state as Partial<Entry> | null)?.live;
  return s ? parseLiveHash(liveHash(s)) : null; // checked like a link
}

// What to do with an overview link pasted into the address bar of this tab.
export function onLiveLinkPasted(fn: (ref: LiveRef) => void): void {
  onLiveLink = fn;
}

// Called once at start with what to do when Back / Forward lands on an entry (null: nothing open).
export function startNav(onView: Handler): void {
  handler = onView;
  window.addEventListener("popstate", () => {
    // A link pasted into the address bar of this tab: an entry without our state, after the one on screen.
    // An overview link changes the overview (and closes any panel); a panel link opens its view.
    if (!current() && location.hash) {
      const pastedLive = parseLiveHash(location.hash);
      if (pastedLive) {
        live = pastedLive;
        onLiveLink(pastedLive);
      }
      const view = pastedLive ? null : parseViewHash(location.hash);
      const depth = lastDepth + 1;
      history.replaceState(entry(depth, view), "", urlFor(view));
      seen[depth] = view;
    }
    const at = current();
    // Back / Forward to the empty map: the address shows the overview as it is now (Back is for panels, it
    // does not undo a city or kind choice).
    if (at && !at.view && at.live !== live) history.replaceState(entry(at.depth, null), "", urlFor(null));
    const entryNow = current();
    if (quiet) {
      quiet = false;
      if (entryNow) seen[entryNow.depth] = entryNow.view;
      return;
    }
    if (closing && !entryNow?.view) {
      closing = false;
      return;
    }
    closing = false;
    if (entryNow) seen[entryNow.depth] = entryNow.view;
    run(entryNow?.view ?? null);
  });
}

// Opens `view` without adding a history entry (Back / Forward / a reload / a link).
export function run(view: View | null): void {
  restoring = true;
  try {
    handler(view);
  } finally {
    restoring = false;
  }
}

// A new view was opened by the user: a new entry after the current one.
export function pushView(view: View): void {
  if (restoring) return;
  const now = current();
  if (now && JSON.stringify(now.view) === JSON.stringify(view)) return; // the same again (a refresh)
  const d = depth() + 1;
  seen[d] = view;
  seen.length = d + 1;
  history.pushState(entry(d, view), "", urlFor(view));
}

// The open view changed in place (a new search in the open route panel): the entry follows, no new one.
export function replaceView(view: View): void {
  if (restoring) return;
  const d = depth();
  if (d === 0) {
    pushView(view); // the empty map is never replaced: it is where Close and Back end
    return;
  }
  seen[d] = view;
  history.replaceState(entry(d, view), "", urlFor(view));
}

// The panel was closed: back to the nearest entry without a panel (the empty map at depth 0, or a pasted
// overview link above it), or, on a page opened with a link, a fresh empty entry.
export function closeViews(): void {
  if (restoring) return;
  const now = current();
  const d = now?.depth ?? 0;
  if (now?.view && d > 0) {
    let to = d - 1;
    while (to > 0 && seen[to] !== null) to--; // unknown (after a reload) counts as a panel: on to depth 0
    closing = true;
    history.go(to - d);
  } else if (`${location.pathname}${location.search}${location.hash}` !== urlFor(null)) {
    history.replaceState(entry(d, null), "", urlFor(null));
  }
}

// The entry on screen holds a view the page cannot open (no map): it becomes an overview entry, with the
// overview's address. Works while a view is being restored (unlike closeViews), adds no entry.
export function dropView(): void {
  const now = current();
  if (!now?.view) return;
  seen[now.depth] = null;
  history.replaceState(entry(now.depth, null), "", urlFor(null));
}

// The view one step back, if this page has seen it (so an in-panel "back" link can say where it goes).
export function previousView(): View | null {
  const d = depth();
  return d > 1 ? (seen[d - 1] ?? null) : null;
}

export function goBack(): void {
  history.back();
}

// One step back in the history for a view the app has already put on screen itself (the list behind a
// connection's details), so nothing is opened twice.
export function stepBackQuietly(): void {
  quiet = true;
  history.back();
}

// At start: the view in this entry (a reload keeps it), else one from the address (a link), else none.
// A link's view becomes its own entry on top of an empty one, so Close and Back behave as usual.
export function initialView(fromHash: View | null): View | null {
  const now = current();
  if (now) {
    seen[now.depth] = now.view;
    return now.view;
  }
  history.replaceState(entry(0, null), "", urlFor(null));
  if (fromHash) {
    seen[1] = fromHash;
    history.pushState(entry(1, fromHash), "", urlFor(fromHash));
  }
  return fromHash;
}

// A link to `view` for someone else.
export function linkTo(view: View): string {
  return `${location.origin}${urlFor(view)}`;
}
