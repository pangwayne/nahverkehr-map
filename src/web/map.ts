import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre v6 runs a web worker and looks for its file next to its own module.
// Dev: maplibre-gl is excluded from Vite's pre-bundling (vite.config.ts), so that lookup just works.
// Production: the bundler moves the module, so let Vite bundle the worker and pass its URL.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { getLang } from "./i18n";

if (!import.meta.env.DEV) maplibregl.setWorkerUrl(workerUrl);

// Free vector tiles, no key or sign-up. Attribution for OSM/OpenFreeMap comes from the style itself.
const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

// First visit: Bonn Hauptbahnhof area. MapLibre uses [lon, lat].
const BONN_CENTER: [number, number] = [7.0982, 50.7374];
const START_ZOOM = 13;

// Later visits start where the map was left. Kept in this browser only (localStorage), never sent.
const VIEW_KEY = "view";

interface View {
  center: [number, number];
  zoom: number;
}

function savedView(): View | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as unknown;
    if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    const [lon, lat, zoom] = v as number[];
    if (Math.abs(lon!) > 180 || Math.abs(lat!) > 85 || zoom! < 0 || zoom! > 22) return null;
    return { center: [lon!, lat!], zoom: zoom! };
  } catch {
    return null; // storage blocked (private mode, say) or broken: start at Bonn
  }
}

function saveView(map: maplibregl.Map): void {
  const c = map.getCenter();
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify([round(c.lng), round(c.lat), Math.round(map.getZoom() * 100) / 100]));
  } catch {
    // Storage blocked: the next visit starts at Bonn again.
  }
}

// MapLibre's own button labels in German. Set when the map starts; a language switch updates them on the next visit.
const MAP_TEXTS_DE: Record<string, string> = {
  "NavigationControl.ZoomIn": "Vergrößern",
  "NavigationControl.ZoomOut": "Verkleinern",
  "NavigationControl.ResetBearing": "Nach Norden ausrichten",
  "AttributionControl.ToggleAttribution": "Quellenangaben ein- oder ausblenden",
};

// No pan limit: a tapped regional train can be far outside the stop area (RB26 runs Köln - Mainz).
export function createMap(container: HTMLElement): maplibregl.Map {
  const view = savedView();
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: view?.center ?? BONN_CENTER,
    zoom: view?.zoom ?? START_ZOOM,
    ...(getLang() === "de" ? { locale: MAP_TEXTS_DE } : {}),
    attributionControl: {
      compact: true,
      customAttribution: '<a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous data sources</a>',
    },
  });

  // No MapLibre locate button: "My location" is the only way the app asks for the location (one-off, no tracking).
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.on("moveend", () => saveView(map));

  return map;
}
