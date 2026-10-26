// The stop search in the header: type part of a name, pick a stop, its departure board opens. It also finds
// addresses and places (a separate, explicit step in the list), and while empty it offers the saved stops and
// routes and the three cities.

import type { Board } from "./board";
import { t } from "./i18n";
import { shortName } from "./names";
import { focusPanel } from "./panel";
import type { Spot } from "./places";
import { type SavedRoute, clearSaved, loadSaved } from "./saved";
import { type SearchItem, attachStopSearch } from "./stopsearch";

// The three cities this app is about, as map shortcuts ([lon, lat], around each main station).
const CITIES: { name: string; center: [number, number] }[] = [
  { name: "Bonn", center: [7.0982, 50.7374] },
  { name: "Köln", center: [6.9583, 50.9413] },
  { name: "Düsseldorf", center: [6.7946, 51.22] },
];

export interface SearchActions {
  flyTo(center: [number, number]): void;
  showPlace(spot: Spot): void;
  openRoute(route: SavedRoute): void;
}

export function startSearch(board: Board, actions: SearchActions): void {
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
    onPickSpot(spot) {
      input.value = "";
      actions.showPlace(spot);
      focusPanel();
    },
    emptyItems(): SearchItem[] {
      const saved = loadSaved();
      const items: SearchItem[] = [];
      for (const s of saved.stops) {
        const station = board.stations().find((x) => x.id === s.id);
        if (!station) continue;
        items.push({
          label: shortName(station.name),
          sub: t().saved,
          kind: "saved",
          run: () => {
            board.showStation(station, true);
            focusPanel();
          },
        });
      }
      for (const r of saved.routes) {
        const name = (e: SavedRoute["from"]) => (e.kind === "here" ? t().routeHere : e.name);
        items.push({ label: `${name(r.from)} → ${name(r.to)}`, sub: t().savedRoute, kind: "route", run: () => actions.openRoute(r) });
      }
      for (const c of CITIES) {
        items.push({ label: c.name, sub: t().cityShortcut, kind: "city", run: () => actions.flyTo(c.center) });
      }
      if (saved.stops.length || saved.routes.length) {
        items.push({
          label: t().clearSaved,
          kind: "action",
          run: () => {
            if (window.confirm(t().clearSavedConfirm)) clearSaved();
          },
        });
      }
      return items;
    },
  });
}
