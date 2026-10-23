# ÖPNV Bonn live

A mobile-friendly map of Bonn's stops with live departures (trams, buses, regional trains). Tap a
departure to see its route and where the vehicle is right now. Non-commercial hobby project.

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

- **Browser** (`src/web`): the map (MapLibre), stops, departure board and trip card.
- **Cloudflare Worker** (`src/worker`): forwards `/api/stops`, `/api/departures` and `/api/trip` to the
  [Transitous](https://transitous.org/) API and caches the answers, so many visitors asking about the same
  stop share one upstream request. It also adds the security headers to the pages.
- **Vehicle position:** a trip's track line is cut at its stops. If 40% of the time between two stops has
  passed (by the live or timetable times), the dot sits 40% along that piece of track. It is an estimate,
  not GPS.
- **Location:** "Near me" finds the closest stops on your device; the position is not sent anywhere.

## Data and attribution

- Live transit data: [Transitous](https://transitous.org/) - [data sources](https://transitous.org/sources/)
- Map data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Map tiles: [OpenFreeMap](https://openfreemap.org/)

## License

Code: [MIT](LICENSE). Data keeps the licenses of its sources (see links above).
