// A stop search field with a drop-down list (ARIA combobox): type part of a name, pick a stop with a tap or
// with the arrow keys and Enter. Used by the header search and by the route panel's From and To fields.
// It searches the stop list the board has already loaded, so typing sends nothing anywhere.

import type { Board } from "./board";
import { t, onLangChange } from "./i18n";
import { shortName } from "./names";
import { el } from "./panel";
import { type Station, searchStations } from "./stops";

const MAX_RESULTS = 8;

export interface StopSearchOptions {
  input: HTMLInputElement;
  list: HTMLUListElement; // needs an id (aria-controls, option ids)
  board: Board;
  onPick(station: Station): void;
  onType?(): void; // the text changed by typing, so an earlier pick no longer matches it
  openOnFocus?(): boolean; // false: focusing the field does not open the list (it already holds a pick)
  clearOnEscape: boolean; // Escape with the list open also empties the field
}

export interface StopSearch {
  close(): void;
}

export function attachStopSearch(o: StopSearchOptions): StopSearch {
  const { input, list, board } = o;
  let results: Station[] = [];
  let active = -1; // the highlighted result (arrow keys), -1 for none

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
      if (!results.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = (active + step + results.length) % results.length;
      render();
    } else if (e.key === "Enter" && !list.hidden) {
      const pick = results[active] ?? results[0];
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
    if (list.hidden) return;
    if (board.stations().length) render();
    else void update(); // the "loading" note, in the new language
  });
  // Still waiting for the stop list: "loading" turns into "couldn't load", then into results.
  board.onStationsChange(() => {
    if (document.activeElement === input) void update();
  });

  async function update(): Promise<void> {
    const query = input.value;
    if (!query.trim()) {
      close();
      return;
    }
    if (!board.stations().length) {
      showNote(board.stationsFailed() ? t().stopsFailed : t().searchLoading);
      return; // onStationsChange runs this again
    }
    results = searchStations(board.stations(), query, MAX_RESULTS);
    active = -1;
    render();
  }

  function render(): void {
    if (!results.length) {
      showNote(t().searchNone);
      return;
    }
    list.replaceChildren(
      ...results.map((s, i) => {
        const li = el("li", i === active ? "search-result active" : "search-result", shortName(s.name));
        li.id = `${list.id}-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === active));
        li.addEventListener("click", () => choose(s));
        return li;
      }),
    );
    open();
    if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function showNote(text: string): void {
    results = [];
    list.replaceChildren(el("li", "search-note", text));
    open();
  }

  function choose(station: Station): void {
    close();
    o.onPick(station);
  }

  function open(): void {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function close(): void {
    list.hidden = true;
    results = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  return { close };
}
