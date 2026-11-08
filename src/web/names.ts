// How stop names are shown: always with the town in full ("D-Wehrhahn" -> "Düsseldorf Wehrhahn"). The car
// plates ("K-Neumarkt") are still understood when searching (stops.ts).

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

// The name as the app shows it everywhere: the town in full (user decision 2026-11-03, replacing the car
// plates), so visitors who do not know "BN" or "SU" can read it: "D-Wehrhahn S" -> "Düsseldorf Wehrhahn S".
export function stopName(name: string): string {
  return townName(name);
}
