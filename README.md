# Nahverkehr Pünktlichkeits-Check (Public Transport Punctuality Check)

Live delay analytics for Bonn, Köln and Düsseldorf: every tram, Stadtbahn, bus and S-Bahn on a map, colored
by how late it is right now (green 0-1 min, yellow 2-5, orange 6-10, red 11+, grey for timetable only), with
the stretch of track it is on in the same color. Regional trains are drawn as pale rings but not counted. The
overview gives numbers for the chosen cities (inside their official limits, whatever the map shows): the
share on time among vehicles with live data, how many have live data, the cities side by side, punctuality
by kind of vehicle, how late the late ones are, the 5 most delayed tram lines, filters, and what the numbers
do and do not mean. Tap a vehicle for its trip, or a stop for its live departures; a route planner is there
too.
In English at `/` and German at `/de/`, with a switch that remembers the choice. An open-source personal project.

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

## How it works

- **Browser** (`src/web`): the map (MapLibre), the live map and its overview, stop search, departure board and
  trip card. All texts are
  in `src/web/i18n.ts` (German and English); the language choice is kept in the browser only.
- **Cloudflare Worker** (`src/worker`): forwards `/api/city`, `/api/vehicles`, `/api/stops`, `/api/departures`, `/api/trip`,
  `/api/plan` and `/api/geocode` to the [Transitous](https://transitous.org/) API and caches the answers, so many visitors
  asking about the same stop share one upstream request. Failed answers are remembered briefly too, and each
  visitor may cause at most 100 upstream requests a minute (route searches: 10). It checks every value and
  builds the Transitous request itself, so it is not an open proxy. It also adds the security headers to the
  pages. The stop list (about 370 KB compressed) carries an ETag: a browser that still has today's copy gets an
  empty 304 instead of the list again. (Trimming the list in the Worker would need more CPU time than the
  free plan allows.)
- **Live data:** each city comes as one answer (`/api/city?id=bonn|koeln|duesseldorf`): a fixed box around
  its official limits (OpenStreetMap, `src/web/citylimits.ts`). The browser keeps all three loaded, each every
  minute and only while the page is visible, so switching city is instant (~150-270 KB compressed per city
  at Saturday noon; more at weekday rush hour). The Worker picks the time window itself (the next 3 minutes
  from the start of the minute) and passes Transitous' `map/trips` answer on unread, so everyone asking in the
  same minute can share one cached answer (best effort, per Cloudflare data centre: visitors served by
  different data centres each cause their own request). Map views outside the three city boxes add tiles of a fixed grid of
  about 10 x 10 km (`/api/vehicles?tile=x,y`, `src/web/tiles.ts`, at most 6, none when
  zoomed out further than about city level, every 2 minutes). Where two answers carry the same stretch, the
  newer one wins. The browser drops long-distance trains, coaches and planes, moves each vehicle along its
  stretch once a second and colors it by the live delay of that stretch. Data without live times is grey,
  never green.
- **Overview:** a column left of the map on wide screens, a bar over the bottom on phones (it can be folded
  away; with a stop, trip or route open, one line at the top of the map). It describes the chosen cities
  inside their official limits, together when several are chosen, and the chosen kinds of vehicles (bus and
  tram can be switched off, the S-Bahn is always included; regional trains and rail replacement buses such as
  "RE8" never count). It shows the share on time (up to 1 min late) among vehicles with live data, with no
  percentage under 10 live vehicles; the count per color; the cities side by side; how many have live data,
  by kind; the share on time per kind and city (kind against kind, so a city's mix of buses and trains cannot
  skew it; a percentage from 10 live vehicles on, the live count always shown); how late the late vehicles
  (2+ min) are, as a median from 10 of them on and by minutes late; and the 5 most delayed tram lines. That
  list has one row per line, 2+ min late: the next vehicle of the line's most delayed direction, so a vehicle
  further behind can be later than its row says (directions come from a few `/api/trip` requests). A vehicle
  reporting 60+ min stays on the map but is left out of every number, and a note under the list says how many there are. Each
  city's numbers come from that city's own answer only: moving the map never changes them. An answer is used
  only once it was fully read; when it is old, its refresh failed or more than 10 % of its entries were
  unreadable, every part of the overview says so, and no comparison is drawn from it. Tap a line to see its
  vehicles and the notices of one sample trip (one `/api/trip` request, taken again when that vehicle leaves
  the city or after 2 minutes). The address holds the cities, kinds and line (after "#", so it is not sent to
  the server), so a copied address, a reload or the share button opens the same overview with the latest
  situation. Three tabs at the top of the overview (About, Method, Sources) explain the project, the limits
  (estimates, the color bands, regional trains, the median, no cancellations, no history) and the sources.
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
- **Stop names:** the town is written in full, so visitors who do not know the car plates can read it: the
  data's "D-Wehrhahn S" shows as "Düsseldorf Wehrhahn S".
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
- **For search engines and AI answers:** each language has its own address, linked with `hreflang`:
  `index.html` and `de/index.html` are the same app in English and German (change both). `about.html` and
  `de/ueber.html` explain the method as plain HTML, because the app's own text needs JavaScript. All four carry
  JSON-LD, and `public/` holds `robots.txt` and `sitemap.xml`.
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
