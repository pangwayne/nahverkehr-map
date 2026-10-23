// The stop search in the header: type part of a name, pick a stop, its departure board opens.
// It searches the stop list the board has already loaded, so typing sends nothing anywhere.

import type { Board } from "./board";
import { t, onLangChange } from "./i18n";
import { shortName } from "./names";
import { el } from "./panel";
import { type Station, searchStations } from "./stops";

const MAX_RESULTS = 8;

export function startSearch(board: Board): void {
  const input = document.querySelector<HTMLInputElement>("#search")!;
  const list = document.querySelector<HTMLUListElement>("#search-results")!;
  let results: Station[] = [];
  let active = -1; // the highlighted result (arrow keys), -1 for none

  input.addEventListener("input", () => void update());
  input.addEventListener("focus", () => void update());
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
    } else if (e.key === "Enter") {
      const pick = results[active] ?? results[0];
      if (pick) choose(pick);
    } else if (e.key === "Escape" && !list.hidden) {
      e.stopPropagation(); // close the list only, not the departure board
      input.value = "";
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
        li.id = `search-result-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === active));
        li.addEventListener("click", () => choose(s));
        return li;
      }),
    );
    open();
    if (active >= 0) input.setAttribute("aria-activedescendant", `search-result-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function showNote(text: string): void {
    results = [];
    list.replaceChildren(el("li", "search-note", text));
    open();
  }

  function choose(station: Station): void {
    input.value = "";
    close();
    input.blur(); // hides the phone keyboard, so the board is visible
    board.showStation(station, true);
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
}
