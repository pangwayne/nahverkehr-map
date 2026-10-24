// Every text the app shows, in German (the default) and English.
// The choice is kept in this browser only (localStorage), never sent anywhere.

export type Lang = "de" | "en";

const STORAGE_KEY = "lang";

const de = {
  pageTitle: "Nahverkehr Rheinland: Abfahrten live",
  nearMe: "Mein Standort",
  nearMeLabel: "Mein Standort: Haltestellen in der Nähe zeigen",
  switchTo: "EN",
  switchLabel: "Read in English",
  portraitLabel: "Pang Wayne Wee, zur Website",
  close: "Schließen",
  searchLabel: "Haltestelle suchen",
  searchLoading: "Haltestellen laden...",
  stopsFailed: "Haltestellen konnten nicht geladen werden. Neuer Versuch läuft...",
  searchNone: "Keine Haltestelle gefunden",
  idle: "Haltestelle suchen oder auf der Karte antippen",
  loading: "lädt...",
  unavailable: "gerade nicht verfügbar",
  updated: (s: number) => `vor ${s} s abgerufen`,
  dataOld: "Daten sind alt",
  refreshFailed: "Aktualisierung fehlgeschlagen",
  mapFailed:
    "Die Karte kann in diesem Browser nicht starten (WebGL ist aus oder fehlt). Ohne Karte funktioniert die App leider nicht.",

  nearYou: "In deiner Nähe",
  needsHttps: "Der Standort braucht eine sichere Verbindung (die https://-Seite oder localhost).",
  findingYou: "Standort wird gesucht...",
  noStopsNear: "Keine Haltestellen in der Nähe. Diese Karte deckt Bonn, Köln, Düsseldorf und Umgebung ab.",
  locationDenied: "Standortzugriff nicht erlaubt. Du kannst trotzdem eine Haltestelle auf der Karte antippen.",
  locationFailed: "Standort nicht gefunden. Du kannst trotzdem eine Haltestelle auf der Karte antippen.",
  youAreHere: "Du bist hier",

  loadingDepartures: "Abfahrten laden...",
  noBoardForStop: "Für diese Haltestelle gibt es hier keine Abfahrten.",
  noDepartures: "Keine Abfahrten in nächster Zeit.",
  departuresUnavailable: "Abfahrten gerade nicht verfügbar. Neuer Versuch läuft...",
  extraTrip: "Sonderfahrt, keine Details",
  timetableOnly: "nur Fahrplan",
  cancelled: "fällt aus",
  now: "jetzt",
  onTimeShort: "pünktlich",
  liveDelay: (d: string) => `${d} live`,
  everyMinute: "neu jede Minute",
  modeTram: "Straßenbahn",
  modeLightRail: "Stadtbahn",
  modeBus: "Bus",
  modeOnDemand: "Bus auf Bestellung",
  modeSuspension: "Schwebebahn",
  modeFerry: "Fähre",
  modeSBahn: "S-Bahn",
  modeTrain: "Zug",
  estimatedTitle: "Geschätzte Position, kein GPS.",
  estimatedBody: "Berechnet aus Fahrplan und gemeldeter Verspätung.",
  inMin: (m: number) => `in ${m} min`,

  line: (l: string) => `Linie ${l}`,
  loadingTrip: "Fahrt laden...",
  tripUnavailable: "Fahrtdetails gerade nicht verfügbar. Neuer Versuch läuft...",
  implausible: (stop: string) => `Live-Zeiten wirken falsch, ab ${stop} gilt der Fahrplan`,
  wholeRoute: "Ganze Strecke zeigen",
  earlierStops: (n: number) => `${n} frühere Halte zeigen`,
  cancelledStops: (n: number) => `${n} ausfallende Halte zeigen`,
  tripCancelled: "Diese Fahrt fällt aus",
  noLiveData: "Nur Fahrplan, keine Live-Daten",
  timetableOnlyCap: "Nur Fahrplan",
  onTime: "Pünktlich",
  minLate: (m: number) => `${m} min Verspätung`,
  minEarly: (m: number) => `${m} min zu früh`,
  tripEndedAt: (stop: string) => `Fahrt beendet in ${stop}`,
  tripEnded: "Fahrt beendet",
  startsAt: (stop: string, when: string) => `Startet in ${stop} · ${when}`,
  atStopNow: (stop: string, when: string) => `Jetzt in ${stop} · fährt ab ${when}`,
  nextStop: (stop: string, when: string) => `Nächster Halt: ${stop} · ${when}`,
  timetable: "Fahrplan",

  routeButton: "Route",
  routeButtonLabel: "Route planen",
  routeTitle: "Route planen",
  routeFrom: "Von",
  routeTo: "Nach",
  routeFromHint: "Start-Haltestelle",
  routeToHint: "Ziel-Haltestelle",
  routeSwap: "Start und Ziel tauschen",
  routeUseLocation: "Mein Standort als Start",
  routeDepart: "Abfahrt",
  routeArrive: "Ankunft",
  routeWhen: "Wann",
  routeNow: "Jetzt",
  routeDate: "Datum",
  routeTime: "Uhrzeit",
  routeSearch: "Verbindungen suchen",
  routeSearching: "Suche läuft...",
  routePickFrom: "Bitte eine Start-Haltestelle aus der Liste wählen.",
  routePickTo: "Bitte eine Ziel-Haltestelle aus der Liste wählen.",
  routeSameStop: "Start und Ziel sind dieselbe Haltestelle.",
  routeBadTime: "Bitte ein gültiges Datum und eine Uhrzeit wählen.",
  routeTimeRange: "Bitte eine Zeit zwischen vor 2 Stunden und in 7 Tagen wählen.",
  routeTimeTwice: "Diese Uhrzeit gibt es in der Nacht der Zeitumstellung zweimal. Gesucht wird die erste.",
  routeTimeSkipped: (time: string) => `Diese Uhrzeit fällt durch die Zeitumstellung aus. Gesucht wird ab ${time}.`,
  routeResults: "Verbindungen",
  routeFound: (n: number) => (n === 1 ? "1 Verbindung gefunden" : `${n} Verbindungen gefunden`),
  routeNone: "Keine Verbindung gefunden. Probiere eine andere Zeit oder Haltestelle.",
  routeWalkAll: "Zu Fuß",
  routeDirect: "ohne Umstieg",
  routeTransfers: (n: number) => (n === 1 ? "1 Umstieg" : `${n} Umstiege`),
  routeWalkMin: (m: number) => `${m} min Fußweg`,
  routeFromStop: (stop: string) => `ab ${stop}`,
  routePlanned: "geplant",
  routeEarlier: "Früher",
  routeLater: "Später",
  routeRefresh: "Aktualisieren",
  routeUnknownStop: "Eine der Haltestellen kennt die Fahrplanauskunft nicht.",
  routeTooMany: (s: number) => `Zu viele Suchen in kurzer Zeit. Bitte in ${s} s noch einmal.`,
  routeUnavailable: "Die Fahrplanauskunft ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.",
  routeOffline: "Keine Internetverbindung.",
  routeFromHere: "Route von hier",
  routeToHere: "Route hierher",
  routeNoStopNear: "Keine Haltestelle in der Nähe gefunden.",
  routeLocationDenied: "Standortzugriff nicht erlaubt. Bitte die Start-Haltestelle eintippen.",
  routeLocationFailed: "Standort nicht gefunden. Bitte die Start-Haltestelle eintippen.",

  footerData: "Daten",
  footerSources: "Transitous-Quellen",
  footerSource: "Quellcode",
  footerLicenses: "Lizenzen",
  footerImprint: "Impressum",
  footerPrivacy: "Datenschutz",
  imprintUrl: "https://www.pangwayne.com/de/impressum",
  privacyUrl: "/de/datenschutzerklaerung",
};

const en: typeof de = {
  pageTitle: "Nahverkehr Rheinland: live departures",
  nearMe: "My location",
  nearMeLabel: "My location: show nearby stops",
  switchTo: "DE",
  switchLabel: "Auf Deutsch lesen",
  portraitLabel: "Pang Wayne Wee, to the website",
  close: "Close",
  searchLabel: "Search stops",
  searchLoading: "Loading stops...",
  stopsFailed: "Couldn't load the stops. Retrying...",
  searchNone: "No stop found",
  idle: "Search for a stop or tap one on the map",
  loading: "loading...",
  unavailable: "unavailable right now",
  updated: (s) => `fetched ${s} s ago`,
  dataOld: "data is old",
  refreshFailed: "refresh failed",
  mapFailed: "The map cannot start in this browser (WebGL is off or missing). The app does not work without it, sorry.",

  nearYou: "Near you",
  needsHttps: "Location needs a secure connection (the https:// site, or localhost).",
  findingYou: "Finding your location...",
  noStopsNear: "No stops nearby. This map covers Bonn, Köln, Düsseldorf and the area around them.",
  locationDenied: "Location access was not allowed. You can still tap a stop on the map.",
  locationFailed: "Could not find your location. You can still tap a stop on the map.",
  youAreHere: "You are here",

  loadingDepartures: "Loading departures...",
  noBoardForStop: "No departures available for this stop here.",
  noDepartures: "No departures soon.",
  departuresUnavailable: "Departures unavailable right now. Retrying...",
  extraTrip: "extra trip, no details",
  timetableOnly: "timetable only",
  cancelled: "cancelled",
  now: "now",
  onTimeShort: "on time",
  liveDelay: (d) => `${d} live`,
  everyMinute: "refreshes every minute",
  modeTram: "Tram",
  modeLightRail: "Light rail",
  modeBus: "Bus",
  modeOnDemand: "On-demand bus",
  modeSuspension: "Suspension railway",
  modeFerry: "Ferry",
  modeSBahn: "S-Bahn",
  modeTrain: "Train",
  estimatedTitle: "Estimated position, not GPS.",
  estimatedBody: "Worked out from the timetable and the reported delay.",
  inMin: (m) => `in ${m} min`,

  line: (l) => `Line ${l}`,
  loadingTrip: "Loading trip...",
  tripUnavailable: "Trip details unavailable right now. Retrying...",
  implausible: (stop) => `Live times look wrong, showing timetable from ${stop}`,
  wholeRoute: "Show whole route",
  earlierStops: (n) => `Show ${n} earlier stops`,
  cancelledStops: (n) => `Show ${n} cancelled stops`,
  tripCancelled: "This trip is cancelled",
  noLiveData: "Timetable only, no live data",
  timetableOnlyCap: "Timetable only",
  onTime: "On time",
  minLate: (m) => `${m} min late`,
  minEarly: (m) => `${m} min early`,
  tripEndedAt: (stop) => `Trip ended at ${stop}`,
  tripEnded: "Trip ended",
  startsAt: (stop, when) => `Starts at ${stop} · ${when}`,
  atStopNow: (stop, when) => `At ${stop} now · leaves ${when}`,
  nextStop: (stop, when) => `Next stop: ${stop} · ${when}`,
  timetable: "timetable",

  routeButton: "Route",
  routeButtonLabel: "Plan a route",
  routeTitle: "Plan a route",
  routeFrom: "From",
  routeTo: "To",
  routeFromHint: "Start stop",
  routeToHint: "Destination stop",
  routeSwap: "Swap start and destination",
  routeUseLocation: "Use my location as start",
  routeDepart: "Depart",
  routeArrive: "Arrive",
  routeWhen: "When",
  routeNow: "Now",
  routeDate: "Date",
  routeTime: "Time",
  routeSearch: "Find connections",
  routeSearching: "Searching...",
  routePickFrom: "Please pick a start stop from the list.",
  routePickTo: "Please pick a destination stop from the list.",
  routeSameStop: "Start and destination are the same stop.",
  routeBadTime: "Please pick a valid date and time.",
  routeTimeRange: "Please pick a time between 2 hours ago and 7 days from now.",
  routeTimeTwice: "This time happens twice in the night the clocks change. Searching for the first one.",
  routeTimeSkipped: (time) => `This time is skipped when the clocks change. Searching from ${time}.`,
  routeResults: "Connections",
  routeFound: (n) => (n === 1 ? "1 connection found" : `${n} connections found`),
  routeNone: "No connection found. Try another time or stop.",
  routeWalkAll: "On foot",
  routeDirect: "no change",
  routeTransfers: (n) => (n === 1 ? "1 change" : `${n} changes`),
  routeWalkMin: (m) => `${m} min walk`,
  routeFromStop: (stop) => `from ${stop}`,
  routePlanned: "planned",
  routeEarlier: "Earlier",
  routeLater: "Later",
  routeRefresh: "Refresh",
  routeUnknownStop: "The journey planner does not know one of the stops.",
  routeTooMany: (s) => `Too many searches in a short time. Please try again in ${s} s.`,
  routeUnavailable: "The journey planner cannot be reached right now. Please try again shortly.",
  routeOffline: "No internet connection.",
  routeFromHere: "Route from here",
  routeToHere: "Route to here",
  routeNoStopNear: "No stop found nearby.",
  routeLocationDenied: "Location access was not allowed. Please type the start stop.",
  routeLocationFailed: "Could not find your location. Please type the start stop.",

  footerData: "Data",
  footerSources: "Transitous sources",
  footerSource: "Source code",
  footerLicenses: "Licenses",
  footerImprint: "Imprint",
  footerPrivacy: "Privacy",
  imprintUrl: "https://www.pangwayne.com/imprint",
  privacyUrl: "/privacy",
};

export type Texts = typeof de;

let current: Lang = savedLang() ?? "de";
const listeners: (() => void)[] = [];

// The texts in the current language.
export function t(): Texts {
  return current === "de" ? de : en;
}

export function getLang(): Lang {
  return current;
}

// Switch language, remember it, and let every open view redraw.
export function setLang(lang: Lang, remember = true): void {
  current = lang;
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Storage blocked (private mode, say): the switch still works until the page is closed.
    }
  }
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void): void {
  listeners.push(fn);
}

function savedLang(): Lang | null {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === "de" || v === "en" ? v : null;
  } catch {
    return null;
  }
}
