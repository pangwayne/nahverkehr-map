// Browser history for the panel: every stop, trip, place, route search and connection that is opened gets
// its own history entry, so Back (the button, or the phone's back gesture) steps back inside the app instead
// of leaving it, and Forward goes on again. The address shows the open view after "#", so a reload or a
// copied link opens it again (endpoints.ts says what goes into it).
//
// Entries carry their depth: 0 is the empty map. Closing the panel goes back to depth 0, so after a close,
// Back leaves the site as expected instead of reopening things one by one.

import { type View, parseViewHash, viewHash } from "./endpoints";

interface Entry {
  app: "nahverkehr";
  depth: number;
  view: View | null;
}

type Handler = (view: View | null) => void;

let handler: Handler = () => {};
let restoring = false; // a view is being opened because of Back / Forward / a reload: do not add entries
let closing = false; // Close went back to depth 0; that step's popstate needs no action
let quiet = false; // a step back whose view the app already shows (stepBackQuietly)
// The views of this tab's entries by depth, as far as this page has seen them (lost on reload).
const seen: (View | null)[] = [];
let lastDepth = 0; // the depth of the entry on screen

function current(): Entry | null {
  const s = history.state as Partial<Entry> | null;
  const entry = s && s.app === "nahverkehr" && typeof s.depth === "number" ? (s as Entry) : null;
  if (entry) lastDepth = entry.depth;
  return entry;
}

const depth = (): number => current()?.depth ?? 0;

function urlFor(view: View | null): string {
  const hash = viewHash(view);
  return `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`;
}

// Called once at start with what to do when Back / Forward lands on an entry (null: nothing open).
export function startNav(onView: Handler): void {
  handler = onView;
  window.addEventListener("popstate", () => {
    // A link pasted into the address bar of this tab: an entry without our state, after the one on screen.
    if (!current() && location.hash) {
      const view = parseViewHash(location.hash);
      const depth = lastDepth + 1;
      history.replaceState({ app: "nahverkehr", depth, view } satisfies Entry, "", urlFor(view));
      seen[depth] = view;
    }
    const entry = current();
    if (quiet) {
      quiet = false;
      if (entry) seen[entry.depth] = entry.view;
      return;
    }
    if (closing && (entry?.depth ?? 0) === 0) {
      closing = false;
      return;
    }
    closing = false;
    if (entry) seen[entry.depth] = entry.view;
    run(entry?.view ?? null);
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
  history.pushState({ app: "nahverkehr", depth: d, view } satisfies Entry, "", urlFor(view));
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
  history.replaceState({ app: "nahverkehr", depth: d, view } satisfies Entry, "", urlFor(view));
}

// The panel was closed: back to the empty map (depth 0), or, on a page opened with a link, a fresh empty entry.
export function closeViews(): void {
  if (restoring) return;
  const d = depth();
  if (d > 0) {
    closing = true;
    history.go(-d);
  } else if (location.hash) {
    history.replaceState({ app: "nahverkehr", depth: 0, view: null } satisfies Entry, "", urlFor(null));
  }
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
  const entry = current();
  if (entry) {
    seen[entry.depth] = entry.view;
    return entry.view;
  }
  history.replaceState({ app: "nahverkehr", depth: 0, view: null } satisfies Entry, "", urlFor(null));
  if (fromHash) {
    seen[1] = fromHash;
    history.pushState({ app: "nahverkehr", depth: 1, view: fromHash } satisfies Entry, "", urlFor(fromHash));
  }
  return fromHash;
}

// A link to `view` for someone else.
export function linkTo(view: View): string {
  return `${location.origin}${urlFor(view)}`;
}
