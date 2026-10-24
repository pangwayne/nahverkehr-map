// The stop search in the header: type part of a name, pick a stop, its departure board opens.

import type { Board } from "./board";
import { focusPanel } from "./panel";
import { attachStopSearch } from "./stopsearch";

export function startSearch(board: Board): void {
  const input = document.querySelector<HTMLInputElement>("#search")!;
  attachStopSearch({
    input,
    list: document.querySelector<HTMLUListElement>("#search-results")!,
    board,
    clearOnEscape: true,
    onPick(station) {
      input.value = "";
      board.showStation(station, true);
      focusPanel(); // keyboard users land on the board; on phones it also hides the keyboard
    },
  });
}
