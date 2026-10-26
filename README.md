# Nahverkehr Rheinland

A mobile-friendly map of the stops in Bonn, Köln, Düsseldorf and the towns around them, with live
departures (trams, Stadtbahn, buses, regional trains). Search for a stop or an address, or tap a stop on the
map, then tap a departure to see its route and where the vehicle is right now. Or plan a route between stops,
addresses, places or points on the map and follow each ride on the map.
German by default, with an English switch. Non-commercial hobby project.

Vehicle positions are **estimated** from live delay predictions, not GPS. No free feed for this area
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

The tests are kept outside this repository, so `npm test` does not run in a fresh clone.

## How it works

- **Browser** (`src/web`): the map (MapLibre), stop search, departure board and trip card. All texts are
  in `src/web/i18n.ts` (German and English); the language choice is kept in the browser only.
- **Cloudflare Worker** (`src/worker`): forwards `/api/stops`, `/api/departures`, `/api/trip`, `/api/plan`
  and `/api/geocode` to the [Transitous](https://transitous.org/) API and caches the answers, so many visitors
  asking about the same stop share one upstream request. Failed answers are remembered briefly too, and each
  visitor may cause at most 100 upstream requests a minute (route searches: 10). It checks every value and
  builds the Transitous request itself, so it is not an open proxy. It also adds the security headers to the
  pages. The stop list (about 370 KB compressed) carries an ETag: a browser that still has today's copy gets an
  empty 304 instead of the list again. (Trimming the list in the Worker would need more CPU time than the
  free plan allows.)
- **Vehicle position:** a trip's track line is cut at its stops. If 40% of the time between two stops has
  passed (by the live or timetable times), the dot sits 40% along that piece of track. It is an estimate,
  not GPS.
- **Departure board:** each row shows the countdown and the clock time (the planned time struck through
  when it moved), the platform for trains (Bonn/Köln and Düsseldorf numbering, a changed platform marked),
  and a mark when the feed has a notice for it; the notices themselves are listed above the rows. A board
  shows the next 8; "more departures" shows the rest of what was already fetched (about 20 minutes at a big
  station), "later departures" fetches the next page (up to three times). Busy stations get a line filter.
- **Lines at a stop:** while a departure board is open, the lines on it are drawn faintly on the map (one
  `/api/trip` request per line, at most 12, remembered while the page is open). Train stations get bigger dots.
- **Stop names:** small stops show the town's car plate instead of the town ("Köln Neumarkt" becomes
  "K-Neumarkt", "Bonn Auerberg" becomes "BN-Auerberg"); train stations keep their full name.
- **Stop search:** runs in the browser on the stop list already loaded; what you type is not sent anywhere.
  The town, its plate or no town at all all work ("bonn hbf", "k neumarkt", "wehrhahn"), and so do
  spellings without umlauts and a few English names ("koeln hbf", "cologne main station").
- **Addresses and places:** the last line of the search list ("search addresses and places") sends the
  typed text to the Worker's `/api/geocode`, only when chosen. A picked address or place opens a card with
  the stops nearby and "route from / to here". Holding a finger (or the right mouse button) on the map drops
  a pin that works the same way.
- **Saved stops and routes, links, Back:** stops and routes can be saved ("Merken"); they are listed when the
  search box is empty, kept in this browser only. Whatever is open (a stop, trip, place, search or
  connection) is written into the address after "#", so the browser's Back and Forward step through the app,
  a reload reopens it, and "Teilen" shares it. My location never goes into the address.
- **Map view:** a reload opens the map where you left it (kept in that browser tab only, until it is closed).
  On phones the sheet can be made taller, and the map credits start folded (the footer keeps the sources
  visible).
- **Location:** "Mein Standort" (My location) finds the closest stops on your device and marks your position with a red dot; the position is not sent anywhere.
- **Route search:** pick a start and a destination (a stop, an address or place, a point on the map, or your
  location as the start) and a time. Only the two ends, the time and changed options are sent, and only when
  you press the button; with your location as the start, that includes your position. Options: which
  vehicles, how many changes, extra time to change, how far to walk to the first and from the last stop. Up
  to 5 connections (trams, buses, S-Bahn and regional trains, no IC/ICE), each with the state of the whole
  journey (all rides, not just the first: partly live, a tight or missed change, a cancellation), a vehicle
  icon on every line, and ones that have already left listed apart. The details show each change with the
  time to spare, walking directions (stairs and lifts included) and the walk on the map (a straight line is
  marked as such), notices per ride, and refresh the rides' times once a minute while open; "other
  connections from now" keeps the chosen one at the top. Any ride opens its trip card. Searches are not
  stored.

## Data and attribution

- Live transit data: [Transitous](https://transitous.org/) - [data sources](https://transitous.org/sources/)
- Map data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Map tiles: [OpenFreeMap](https://openfreemap.org/)
- Font: [Hanken Grotesk](https://github.com/marcologous/hanken-grotesk) (SIL Open Font License)
- Licence texts of the bundled packages (MapLibre, the font) are generated at build time and served at
  [/licenses.md](https://nahverkehr.pangwayne.com/licenses.md).

## License

Code: [MIT](LICENSE). Data keeps the licenses of its sources (see links above).
