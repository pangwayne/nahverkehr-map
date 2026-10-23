// How stop names are shown: small stops get the town's car plate instead of the town
// ("Köln Neumarkt" -> "K-Neumarkt"), train stations keep their full name ("Köln Hbf").
// Pure apart from the list of known train stations, which the board fills in once the stops arrive.

// Towns whose plate stands for the town itself: cities with their own plate, and the district
// towns a plate is named after. Other towns in a district keep their name ("SU" alone would hide
// whether a stop is in Troisdorf or Sankt Augustin). `forms`: how the data writes the town.
const TOWNS: { town: string; plate: string; forms: string[] }[] = [
  { town: "Bonn", plate: "BN", forms: ["Bonn"] },
  { town: "Köln", plate: "K", forms: ["Köln"] },
  { town: "Düsseldorf", plate: "D", forms: ["Düsseldorf", "D"] },
  { town: "Leverkusen", plate: "LEV", forms: ["Leverkusen"] },
  { town: "Wuppertal", plate: "W", forms: ["Wuppertal", "W-tal", "W.-tal"] },
  { town: "Solingen", plate: "SG", forms: ["Solingen"] },
  { town: "Remscheid", plate: "RS", forms: ["Remscheid"] },
  { town: "Duisburg", plate: "DU", forms: ["Duisburg"] },
  { town: "Essen", plate: "E", forms: ["Essen"] },
  { town: "Neuss", plate: "NE", forms: ["Neuss"] },
  { town: "Siegburg", plate: "SU", forms: ["Siegburg"] },
  { town: "Bergisch Gladbach", plate: "GL", forms: ["Bergisch Gladbach"] },
  { town: "Euskirchen", plate: "EU", forms: ["Euskirchen"] },
  { town: "Mettmann", plate: "ME", forms: ["Mettmann", "ME"] },
  { town: "Bergheim", plate: "BM", forms: ["Bergheim"] },
];

// What may follow the town: a space, a comma ("Wuppertal, Hülsen") or a hyphen ("Bonn-Bad Godesberg KD").
const SEPARATOR = /^(?:,\s*|-|\s+)/;

interface Split {
  town: (typeof TOWNS)[number];
  rest: string;
}

function splitTown(name: string): Split | null {
  for (const town of TOWNS) {
    for (const form of town.forms) {
      if (!name.startsWith(form)) continue;
      const sep = SEPARATOR.exec(name.slice(form.length));
      if (!sep) continue;
      const rest = name.slice(form.length + sep[0].length).trim();
      if (rest.length >= 2) return { town, rest };
    }
  }
  return null;
}

// "Köln Neumarkt" -> "K-Neumarkt", "Wuppertal, Hülsen" -> "W-Hülsen". Other towns stay as they are.
export function plateName(name: string): string {
  const s = splitTown(name);
  return s ? `${s.town.plate}-${s.rest}` : name;
}

// "D-Wehrhahn S" -> "Düsseldorf Wehrhahn S", so typing the town finds it too.
export function townName(name: string): string {
  const s = splitTown(name);
  return s ? `${s.town.town} ${s.rest}` : name;
}

// Names of the stations we know, and which of them are train stations.
const known = new Set<string>();
const trains = new Set<string>();

export function setStationNames(stations: { name: string; hasTrain: boolean }[]): void {
  known.clear();
  trains.clear();
  for (const s of stations) {
    known.add(s.name);
    if (s.hasTrain) trains.add(s.name);
  }
}

// For names we do not know (far away, or before the stop list is here): what train stations are called.
const TRAIN_NAME = /\b(?:Hbf|Bf|BF|Bahnhof|Hauptbahnhof|S-Bahn)\b|\(S\)| S(?: U)?$/;

export function isTrainStation(name: string): boolean {
  return known.has(name) ? trains.has(name) : TRAIN_NAME.test(name);
}

// The name as the app shows it everywhere: train stations in full, small stops with the plate.
export function shortName(name: string): string {
  return isTrainStation(name) ? name : plateName(name);
}
