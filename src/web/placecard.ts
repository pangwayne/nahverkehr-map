// A place on the panel: an address or landmark from the search, or a point held down on the map. It offers
// a route from or to it, and the stops close by (each opens its board). A pin marks it on the map.
// Nothing is fetched for it: the nearby stops come from the stop list already loaded.

import * as maplibregl from "maplibre-gl";
import type { Board } from "./board";
import { linkTo, pushView } from "./nav";
import { t, onLangChange } from "./i18n";
import { shortName } from "./names";
import { type PanelUser, button, el, offsetClearOfPanel, openPanel, ownsPanel, renderPanel, shareLink } from "./panel";
import type { Spot } from "./places";
import { resetStatus, setStatusTitle } from "./status";
import { nearestStations } from "./stops";

const NEAR_M = 700;
const NEAR_LIMIT = 5;
const ZOOM = 16;
const WALK_M_PER_MIN = 80; // a rough walking pace for "about 4 min"

export interface PlaceCard {
  show(spot: Spot, push?: boolean): void;
}

export function startPlaceCard(
  map: maplibregl.Map,
  board: Board,
  onRoute: (spot: Spot, end: "from" | "to") => void,
): PlaceCard {
  const user: PanelUser = { onClose };
  let shown: Spot | null = null;
  let marker: maplibregl.Marker | null = null;

  onLangChange(() => {
    if (shown && ownsPanel(user)) render();
  });
  board.onStationsChange(() => {
    if (shown && ownsPanel(user)) render();
  });

  function onClose(): void {
    shown = null;
    marker?.remove();
    resetStatus();
  }

  function render(): void {
    const spot = shown;
    if (!spot) return;
    const kind = spot.what === "address" ? t().kindAddress : spot.what === "place" ? t().kindPlace : t().kindPin;
    setStatusTitle(spot.name);
    const parts: HTMLElement[] = [el("p", "board-note", kind)];

    const actions = el("div", "board-route");
    for (const [end, text] of [
      ["from", t().routeFromHere],
      ["to", t().routeToHere],
    ] as const) {
      const btn = button("board-route-btn", text, `route-${end}`);
      btn.addEventListener("click", () => onRoute(spot, end));
      actions.append(btn);
    }
    const share = button("board-route-btn", t().share, "share");
    share.addEventListener("click", () => void shareLink(linkTo({ kind: "place", spot }), spot.name));
    actions.append(share);
    parts.push(actions);

    const near = nearestStations(board.stations(), spot.lon, spot.lat, NEAR_M, NEAR_LIMIT);
    parts.push(el("h3", "route-heading", t().stopsNearby));
    if (!board.stations().length) {
      parts.push(el("p", "board-note", board.stationsFailed() ? t().stopsFailed : t().searchLoading));
    } else if (!near.length) {
      parts.push(el("p", "board-note", t().noStopsNearPlace));
    } else {
      const list = el("ul", "near-stops");
      for (const n of near) {
        const li = el("li", "");
        const btn = button("near-stop", "", `stop-${n.station.id}`);
        const minutes = Math.max(1, Math.round(n.distanceM / WALK_M_PER_MIN));
        btn.append(el("span", "near-stop-name", shortName(n.station.name)), el("small", "", t().walkAbout(minutes)));
        btn.addEventListener("click", () => board.showStation(n.station));
        li.append(btn);
        list.append(li);
      }
      parts.push(list);
    }
    renderPanel(user, spot.name, parts);
  }

  return {
    show(spot: Spot, push = true): void {
      if (push) pushView({ kind: "place", spot });
      openPanel(user);
      shown = spot;
      if (!marker) marker = new maplibregl.Marker({ element: el("div", "place-pin") });
      marker.setLngLat([spot.lon, spot.lat]).addTo(map);
      map.easeTo({ center: [spot.lon, spot.lat], zoom: Math.max(map.getZoom(), ZOOM), offset: offsetClearOfPanel() });
      render();
    },
  };
}
