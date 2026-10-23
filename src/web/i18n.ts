// Every text the app shows, in German (the default) and English.
// The choice is kept in this browser only (localStorage), never sent anywhere.

export type Lang = "de" | "en";

const STORAGE_KEY = "lang";

const de = {
  pageTitle: "Nahverkehr Bonn: Abfahrten live",
  nearMe: "In der Nähe",
  nearMeLabel: "Haltestellen in meiner Nähe",
  switchTo: "EN",
  switchLabel: "Read in English",
  portraitLabel: "Pang Wayne Wee, zur Website",
  close: "Schließen",
  searchLabel: "Haltestelle suchen",
  searchLoading: "Haltestellen laden...",
  searchNone: "Keine Haltestelle gefunden",
  idle: "Haltestelle suchen oder auf der Karte antippen",
  loading: "lädt...",
  unavailable: "gerade nicht verfügbar",
  updated: (s: number) => `vor ${s} s aktualisiert`,
  dataOld: "Daten sind alt",

  nearYou: "In deiner Nähe",
  needsHttps: "Der Standort braucht eine sichere Verbindung (die https://-Seite oder localhost).",
  findingYou: "Standort wird gesucht...",
  noStopsNear: "Keine Haltestellen in der Nähe. Diese Karte deckt nur Bonn ab.",
  locationDenied: "Standortzugriff nicht erlaubt. Du kannst trotzdem eine Haltestelle auf der Karte antippen.",
  locationFailed: "Standort nicht gefunden. Du kannst trotzdem eine Haltestelle auf der Karte antippen.",
  youAreHere: "Du bist hier",

  loadingDepartures: "Abfahrten laden...",
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

  footerData: "Daten",
  footerSources: "Transitous-Quellen",
  footerSource: "Quellcode",
  footerImprint: "Impressum",
  footerPrivacy: "Datenschutz",
  imprintUrl: "https://www.pangwayne.com/de/impressum",
  privacyUrl: "/de/datenschutzerklaerung",
};

const en: typeof de = {
  pageTitle: "Nahverkehr Bonn: live departures",
  nearMe: "Near me",
  nearMeLabel: "Stops near me",
  switchTo: "DE",
  switchLabel: "Auf Deutsch lesen",
  portraitLabel: "Pang Wayne Wee, to the website",
  close: "Close",
  searchLabel: "Search stops",
  searchLoading: "Loading stops...",
  searchNone: "No stop found",
  idle: "Search for a stop or tap one on the map",
  loading: "loading...",
  unavailable: "unavailable right now",
  updated: (s) => `updated ${s} s ago`,
  dataOld: "data is old",

  nearYou: "Near you",
  needsHttps: "Location needs a secure connection (the https:// site, or localhost).",
  findingYou: "Finding your location...",
  noStopsNear: "No stops nearby. This map covers Bonn only.",
  locationDenied: "Location access was not allowed. You can still tap a stop on the map.",
  locationFailed: "Could not find your location. You can still tap a stop on the map.",
  youAreHere: "You are here",

  loadingDepartures: "Loading departures...",
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

  footerData: "Data",
  footerSources: "Transitous sources",
  footerSource: "Source code",
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
