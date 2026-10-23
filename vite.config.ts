import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin runs the Worker (src/worker) inside the Vite dev server,
// so `npm run dev` serves the page and /api/* together on one localhost port.
export default defineConfig({
  plugins: [cloudflare()],
  // MapLibre starts its web worker as an ES module.
  worker: { format: "es" },
  // Serve MapLibre unbundled in dev so it finds its worker file next to itself (see src/web/map.ts).
  optimizeDeps: { exclude: ["maplibre-gl"] },
  // The map plus the two privacy pages. Cloudflare serves them without ".html" (/privacy).
  // Set on the client only: a top-level `input` would also replace the Worker's entry.
  environments: {
    client: {
      build: {
        // Fonts stay real files: the page's CSP only allows fonts from the site itself, not inline data.
        assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
        rolldownOptions: {
          input: ["index.html", "privacy.html", "de/datenschutzerklaerung.html"],
        },
      },
    },
  },
});
