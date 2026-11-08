// Browser history and links at start, with or without the map. The overview's address,
// reload, Back / Forward and pasted links work in both cases; panels (stop, trip, place, route) need the
// map, so without it a panel link says so and the overview stays. No DOM here: main.ts passes in what opens
// and closes panels.

import { type View, parseLiveHash, parseViewHash } from "./endpoints";
import { t } from "./i18n";
import { dropView, initialView, run, startNav } from "./nav";

export interface NavHandlers {
  open: ((view: View) => void) | null; // null: no map, no panels
  close: () => void;
  toast: (text: string) => void;
}

export function startNavigation(h: NavHandlers): void {
  startNav((view) => {
    if (!view) {
      h.close();
    } else if (h.open) {
      h.open(view);
    } else {
      h.toast(t().panelNeedsMap);
      dropView(); // Back / Forward or a pasted link landed on a panel entry: it becomes the overview
    }
  });
  const linked = parseViewHash(location.hash);
  // A link that cannot be read (cut off, or a date that does not exist): the empty map, and said so. A live
  // overview link was read by the live map already and stays in the address.
  if (!linked && !parseLiveHash(location.hash) && location.hash.length > 1) h.toast(t().linkBroken);
  // Without the map a panel link opens nothing: the page starts on the overview (its address too), and says
  // why. A reload of a panel entry goes through run(), which says it once.
  const first = initialView(h.open ? linked : null);
  if (first) run(first);
  else if (linked && !h.open) h.toast(t().panelNeedsMap);
}
