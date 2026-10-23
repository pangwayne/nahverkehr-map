# Nahverkehr Bonn

A mobile-friendly map of Bonn's stops with live departures (trams, buses, regional trains). Search for a
stop or tap one on the map, then tap a departure to see its route and where the vehicle is right now.
German by default, with an English switch. Non-commercial hobby project.

Vehicle positions are **estimated** from live delay predictions, not GPS. No free feed for Bonn
provides real vehicle coordinates.

Live at <https://nahverkehr.pangwayne.com>.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm run dev        # page + Worker at http://localhost:5173
npm run build      # generate Cloudflare types, typecheck, production build
npm run deploy     # build + deploy to Cloudflare (needs `npx wrangler login` once)
```

## How it works

- **Browser** (`src/web`): the map (MapLibre), stop search, departure board and trip card. All texts are
  in `src/web/i18n.ts` (German and English); the language choice is kept in the browser only.
- **Cloudflare Worker** (`src/worker`): forwards `/api/stops`, `/api/departures` and `/api/trip` to the
  [Transitous](https://transitous.org/) API and caches the answers, so many visitors asking about the same
  stop share one upstream request. It also adds the security headers to the pages.
- **Vehicle position:** a trip's track line is cut at its stops. If 40% of the time between two stops has
  passed (by the live or timetable times), the dot sits 40% along that piece of track. It is an estimate,
  not GPS.
- **Stop search:** runs in the browser on the stop list already loaded; what you type is not sent anywhere.
- **Location:** "In der Nähe" (Near me) finds the closest stops on your device; the position is not sent anywhere.

## Data and attribution

- Live transit data: [Transitous](https://transitous.org/) - [data sources](https://transitous.org/sources/)
- Map data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Map tiles: [OpenFreeMap](https://openfreemap.org/)
- Font: [Hanken Grotesk](https://github.com/marcologous/hanken-grotesk) (SIL Open Font License)

## License

Code: [MIT](LICENSE). Data keeps the licenses of its sources (see links above).
