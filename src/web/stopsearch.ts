// A stop search field with a drop-down list (ARIA combobox): type part of a name, pick a stop with a tap or
// with the arrow keys and Enter. Used by the header search and by the route panel's From and To fields.
// Stops are searched in the stop list the board has already loaded, so typing sends nothing anywhere.
// Addresses and places (where the field takes them) are a separate, explicit step: the last row of the list
// ("Adresse oder Ort suchen") sends the typed text to the place search, and only when chosen.

import { fetchGeocode } from "./api";
import type { Board } from "./board";
import { getLang, t, onLangChange } from "./i18n";
import { shortName } from "./names";
import { el } from "./panel";
import { type Spot, matchesToSpots } from "./places";
import { type Station, searchStations } from "./stops";

const MAX_RESULTS = 8;
const PLACE_MIN_CHARS = 3;
const PLACE_TIMEOUT_MS = 10_000;

// One row of the list. `run` is what choosing it does; `stay`: the list stays open (a search starts).
export interface SearchItem {
  label: string;
  sub?: string;
  kind: "stop" | "place" | "address" | "pin" | "action" | "saved" | "route" | "city";
  run(): void;
  stay?: boolean;
  idle?: boolean; // a row that only informs ("searching...", "nothing found"): Enter does not pick it
}

export interface StopSearchOptions {
  input: HTMLInputElement;
  list: HTMLUListElement; // needs an id (aria-controls, option ids)
  board: Board;
  onPick(station: Station): void;
  onPickSpot?(spot: Spot): void; // set: the list offers the place search (addresses, landmarks)
  emptyItems?(): SearchItem[]; // what the list offers while the field is empty (saved stops, cities)
  onType?(): void; // the text changed by typing, so an earlier pick no longer matches it
  openOnFocus?(): boolean; // false: focusing the field does not open the list (it already holds a pick)
  clearOnEscape: boolean; // Escape with the list open also empties the field
}

export interface StopSearch {
  close(): void;
}

// Place answers already fetched in this tab, by language and text (the same text twice asks once).
const placeCache = new Map<string, Spot[]>();

export function attachStopSearch(o: StopSearchOptions): StopSearch {
  const { input, list, board } = o;
  let items: SearchItem[] = [];
  let active = -1; // the highlighted row (arrow keys), -1 for none
  let localCount = 0; // how many of the rows are stops found locally (Enter picks the first)
  // The place search for the current text: its answer, or that it is on its way / failed.
  let places: { text: string; state: "loading" | "failed" | Spot[] } | null = null;
  let placeSeq = 0;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);
  list.setAttribute("role", "listbox");
  list.hidden = true;

  input.addEventListener("input", () => {
    o.onType?.();
    void update();
  });
  input.addEventListener("focus", () => {
    if (o.openOnFocus?.() ?? true) void update();
  });
  input.addEventListener("blur", () => {
    // Wait a moment, so a tap on a result still lands before the list closes.
    setTimeout(close, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = (active + step + items.length) % items.length;
      render();
    } else if (e.key === "Enter" && !list.hidden) {
      // The highlighted row; else the first stop found; else the first address or place found; else the
      // place search, if offered (and not just running).
      const pick =
        items[active] ??
        (localCount
          ? items[0]
          : (items.find((i) => i.kind === "address" || i.kind === "place") ??
            items.find((i) => i.kind === "action" && !i.idle)));
      if (!pick) return;
      e.preventDefault(); // inside a form: pick the stop, do not send the form
      choose(pick);
    } else if (e.key === "Escape" && !list.hidden) {
      e.stopPropagation(); // close the list only, not the panel
      if (o.clearOnEscape) input.value = "";
      close();
    }
  });
  // Tapping a result: mousedown comes before the input's blur.
  list.addEventListener("mousedown", (e) => e.preventDefault());
  onLangChange(() => {
    if (!list.hidden) void update();
  });
  // Still waiting for the stop list: "loading" turns into "couldn't load", then into results.
  board.onStationsChange(() => {
    if (document.activeElement === input) void update();
  });

  async function update(): Promise<void> {
    const query = input.value;
    if (!query.trim()) {
      const extra = o.emptyItems?.() ?? [];
      places = null;
      if (!extra.length) {
        close();
        return;
      }
      items = extra;
      localCount = 0;
      active = -1;
      render();
      return;
    }
    if (places && places.text !== query.trim()) places = null; // the text changed: that answer is for other text
    if (!board.stations().length) {
      showNote(board.stationsFailed() ? t().stopsFailed : t().searchLoading);
      return; // onStationsChange runs this again
    }
    const found = searchStations(board.stations(), query, MAX_RESULTS);
    items = found.map((s) => ({ label: shortName(s.name), kind: "stop" as const, run: () => o.onPick(s) }));
    localCount = items.length;
    if (o.onPickSpot && query.trim().length >= PLACE_MIN_CHARS) items.push(...placeItems(query.trim()));
    active = -1;
    render();
  }

  // The place search rows: the button to start it, "searching...", its answer, or what went wrong.
  function placeItems(text: string): SearchItem[] {
    if (!places || places.text !== text) {
      return [
        {
          label: t().placeSearch(text),
          sub: t().placeSearchNote,
          kind: "action",
          stay: true,
          run: () => void searchPlaces(text),
        },
      ];
    }
    if (places.state === "loading") return [{ label: t().placeSearching, kind: "action", stay: true, idle: true, run: () => {} }];
    if (places.state === "failed") {
      return [{ label: t().placeFailed, kind: "action", stay: true, run: () => void searchPlaces(text) }];
    }
    if (!places.state.length) return [{ label: t().placeNone, kind: "action", stay: true, idle: true, run: () => {} }];
    return places.state.map((spot) => ({
      label: spot.name,
      sub: spot.what === "address" ? t().kindAddress : t().kindPlace,
      kind: spot.what,
      run: () => o.onPickSpot!(spot),
    }));
  }

  async function searchPlaces(text: string): Promise<void> {
    const lang = getLang();
    const key = `${lang}|${text.toLowerCase()}`;
    const mine = ++placeSeq;
    const cached = placeCache.get(key);
    if (cached) {
      places = { text, state: cached };
      void update();
      return;
    }
    places = { text, state: "loading" };
    void update();
    try {
      const res = await fetchGeocode(text, lang, AbortSignal.timeout(PLACE_TIMEOUT_MS));
      const spots = matchesToSpots(res.data);
      placeCache.set(key, spots);
      if (mine !== placeSeq) return; // a newer search is on its way
      places = { text, state: spots };
    } catch {
      if (mine !== placeSeq) return;
      places = { text, state: "failed" };
    }
    if (document.activeElement === input && input.value.trim() === text) void update();
  }

  function render(): void {
    if (!items.length) {
      showNote(t().searchNone);
      return;
    }
    list.replaceChildren(
      ...items.map((item, i) => {
        const li = el("li", `search-result kind-${item.kind}${i === active ? " active" : ""}`);
        li.append(el("span", "search-label", item.label));
        if (item.sub) li.append(el("small", "search-sub", item.sub));
        li.id = `${list.id}-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === active));
        li.addEventListener("click", () => choose(item));
        return li;
      }),
    );
    open();
    if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function showNote(text: string): void {
    items = [];
    localCount = 0;
    list.replaceChildren(el("li", "search-note", text));
    open();
  }

  function choose(item: SearchItem): void {
    if (item.stay) {
      item.run();
      return;
    }
    close();
    item.run();
  }

  function open(): void {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function close(): void {
    list.hidden = true;
    items = [];
    active = -1;
    localCount = 0;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  return { close };
}
