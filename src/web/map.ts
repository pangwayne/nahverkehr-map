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

// Bonn Hauptbahnhof area. MapLibre uses [lon, lat].
const BONN_CENTER: [number, number] = [7.0982, 50.7374];
const START_ZOOM = 13;

// MapLibre's own button labels in German. Set when the map starts; a language switch updates them on the next visit.
const MAP_TEXTS_DE: Record<string, string> = {
  "NavigationControl.ZoomIn": "Vergrößern",
  "NavigationControl.ZoomOut": "Verkleinern",
  "NavigationControl.ResetBearing": "Nach Norden ausrichten",
  "AttributionControl.ToggleAttribution": "Quellenangaben ein- oder ausblenden",
};

// No pan limit: a tapped regional train can be far outside Bonn (RB26 runs Köln - Mainz).
export function createMap(container: HTMLElement): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: BONN_CENTER,
    zoom: START_ZOOM,
    ...(getLang() === "de" ? { locale: MAP_TEXTS_DE } : {}),
    attributionControl: {
      compact: true,
      customAttribution: '<a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous data sources</a>',
    },
  });

  // No MapLibre locate button: "My location" is the only way the app asks for the location (one-off, no tracking).
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  return map;
}
