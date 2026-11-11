// German display names for the openings. The names come in English (Lichess
// `chess-openings` dataset, Lichess games) and stay English internally – they
// are ids for the repertoire and learning progress. Only the display is
// translated, piece by piece: "Family: Variation, Subvariation".
//
// Well-known names have a fixed translation (FIXED); everything else is built
// by rules: "Najdorf Variation" -> "Najdorf-Variante", "Exchange Variation" ->
// "Abtauschvariante", "Queen's Gambit Accepted" -> "Angenommenes Damengambit".

import { lang } from "./i18n";

/** Whole parts (family or variation) with an established German name. */
const FIXED: Record<string, string> = {
  "Alekhine Defense": "Aljechin-Verteidigung",
  "Amazon Attack": "Amazonen-Angriff",
  "Australian Defense": "Australische Verteidigung",
  "Basque Opening": "Baskische Eröffnung",
  "Bishop's Opening": "Läuferspiel",
  "Bogo-Indian Defense": "Bogoljubow-Indisch",
  "Catalan Opening": "Katalanische Eröffnung",
  "Center Game": "Mittelgambit",
  "Czech Defense": "Tschechische Verteidigung",
  "Danish Gambit": "Nordisches Gambit",
  "Dresden Opening": "Dresdner Eröffnung",
  "Dutch Defense": "Holländische Verteidigung",
  "Elephant Gambit": "Elefantengambit",
  "English Orangutan": "Englischer Orang-Utan",
  "Four Knights Game": "Vierspringerspiel",
  "Grünfeld Defense": "Grünfeld-Indisch",
  "Neo-Grünfeld Defense": "Neo-Grünfeld-Indisch",
  "Irish Gambit": "Irisches Gambit",
  "Italian Game": "Italienische Partie",
  "Kangaroo Defense": "Känguru-Verteidigung",
  "King's Knight Opening": "Königsspringerspiel",
  "King's Pawn Game": "Königsbauernspiel",
  "King's Pawn Opening": "Königsbauernspiel",
  "King's Pawn": "Königsbauer",
  "Latvian Gambit": "Lettisches Gambit",
  "Lion Defense": "Löwen-Verteidigung",
  "Marienbad System": "Marienbader System",
  "Nimzo-Larsen Attack": "Nimzowitsch-Larsen-Angriff",
  "Petrov's Defense": "Russische Verteidigung",
  "Petrov": "Russisch",
  "Polish Opening": "Polnische Eröffnung (Orang-Utan)",
  "Pseudo Queen's Indian Defense": "Pseudo-Damenindisch",
  "Pterodactyl Defense": "Pterodactylus-Verteidigung",
  "Queen's Indian Accelerated": "Beschleunigtes Damenindisch",
  "Queen's Pawn Game": "Damenbauernspiel",
  "Queen's Pawn": "Damenbauer",
  "Rat Defense": "Ratten-Verteidigung",
  "Ruy Lopez": "Spanische Partie",
  "Scotch Game": "Schottische Partie",
  "Slav Indian": "Slawisch-Indisch",
  "St. George Defense": "St.-Georg-Verteidigung",
  "Three Knights Opening": "Dreispringerspiel",
  "Three Knights Game": "Dreispringerspiel",
  "Vienna Game": "Wiener Partie",
  "Vulture Defense": "Geier-Verteidigung",
  // Variations
  "Main Line": "Hauptvariante",
  "Danish Gambit Accepted": "Angenommenes Nordisches Gambit",
  "Danish Gambit Declined": "Abgelehntes Nordisches Gambit",
  "Center Game Accepted": "Angenommenes Mittelgambit",
  "Elephant Gambit Accepted": "Angenommenes Elefantengambit",
  "Elephant Gambit Declined": "Abgelehntes Elefantengambit",
  "Anti-Queen's Indian System": "Anti-Damenindisch-System",
  "Long Whip": "Lange Peitsche",
  "Early b3": "Frühes b3",
  "Reversed Closed Sicilian": "Geschlossener Sizilianer mit vertauschten Farben",
  "Long Whip Defense": "Lange-Peitsche-Verteidigung",
  "Arkhangelsk Variation": "Archangelsk-Variante",
  "Mainline": "Hauptvariante",
  "Fried Liver Attack": "Fegatello-Angriff",
  "Poisoned Pawn Variation": "Variante mit dem vergifteten Bauern",
  "Poisoned Pawn": "Vergifteter Bauer",
  "Poisoned Pawn Accepted": "Vergifteter Bauer (angenommen)",
  "Poisoned Pawn Variation Declined": "Variante mit dem vergifteten Bauern (abgelehnt)",
  "Two Knights Defense": "Zweispringerspiel im Nachzuge",
  "Berlin Wall": "Berliner Mauer",
  "Berlin Wall Defense": "Berliner Mauer",
  "Steinitz Defense Deferred": "Verbesserte Steinitz-Verteidigung",
  "Noah's Ark Trap": "Arche-Noah-Falle",
  "Minority Attack": "Minoritätsangriff",
  "Hedgehog": "Igel",
  "Hedgehog Variation": "Igelvariante",
  "Hedgehog System": "Igelsystem",
  "Stonewall": "Stonewall",
  "Sideline": "Nebenvariante",
  "Wayward Queen Attack": "Wanderdamen-Angriff",
  "Giuoco Piano": "Giuoco Piano",
  "Giuoco Pianissimo": "Giuoco Pianissimo",
};

type Gender = "m" | "f" | "n" | "pl";
type Entry =
  /** A noun: the head of the name ("Variante") or, before it, part of the compound ("Abtausch"). */
  | { k: "noun"; head: string; g: Gender; pre?: string }
  /** Only ever the front of a compound ("Königs", "Vier", "Doppel"). */
  | { k: "pre"; pre: string }
  /** Adjective stem, declined by the gender of the head ("Geschlossen" -> "Geschlossene Variante"). */
  | { k: "adj"; stem: string; inv?: boolean }
  /** Post-positioned in English, put in front in German ("Gambit Accepted" -> "Angenommenes Gambit"). */
  | { k: "mod"; stem: string }
  /** A plain word ("with" -> "mit"). */
  | { k: "word"; de: string };

const noun = (head: string, g: Gender, pre?: string): Entry => ({ k: "noun", head, g, pre });
const pre = (p: string): Entry => ({ k: "pre", pre: p });
const adj = (stem: string, inv = false): Entry => ({ k: "adj", stem, inv });
const mod = (stem: string): Entry => ({ k: "mod", stem });
const word = (de: string): Entry => ({ k: "word", de });

const LEXICON: Record<string, Entry> = {
  // Kinds of names
  Variation: noun("Variante", "f"),
  Variations: noun("Varianten", "pl"),
  Defense: noun("Verteidigung", "f"),
  Defence: noun("Verteidigung", "f"),
  Attack: noun("Angriff", "m", "Angriffs"),
  Gambit: noun("Gambit", "n"),
  Countergambit: noun("Gegengambit", "n"),
  Counterattack: noun("Gegenangriff", "m"),
  System: noun("System", "n"),
  Line: noun("Linie", "f"),
  "Main Line": noun("Hauptvariante", "f"),
  "Move Order": noun("Zugfolge", "f"),
  Opening: noun("Eröffnung", "f"),
  Game: noun("Partie", "f"),
  Formation: noun("Aufstellung", "f"),
  Setup: noun("Aufstellung", "f"),
  Trap: noun("Falle", "f"),
  Sacrifice: noun("Opfer", "n"),
  Invitation: noun("Einladung", "f"),
  Transfer: noun("Überführung", "f"),
  Sideline: noun("Nebenvariante", "f"),
  Break: noun("Durchbruch", "m"),
  Storm: noun("Sturm", "m"),
  Push: noun("Vorstoß", "m"),
  Grab: noun("Raub", "m"),
  Return: noun("Rückgabe", "f"),
  Check: noun("Schach", "n"),
  Walk: noun("Marsch", "m"),
  March: noun("Marsch", "m"),
  Swap: noun("Tausch", "m"),
  Exchange: noun("Abtausch", "m"),
  Advance: noun("Vorstoß", "m"),
  Fianchetto: noun("Fianchetto", "n"),
  Center: noun("Zentrum", "n", "Zentrums"),
  Centre: noun("Zentrum", "n", "Zentrums"),
  Pawn: noun("Bauer", "m", "Bauern"),
  Pawns: noun("Bauern", "pl"),
  Knight: noun("Springer", "m"),
  Knights: noun("Springer", "pl"),
  Bishop: noun("Läufer", "m"),
  Bishops: noun("Läufer", "pl"),
  Rook: noun("Turm", "m"),
  Rooks: noun("Türme", "pl", "Turm"),
  Queen: noun("Dame", "f", "Damen"),
  King: noun("König", "m", "Königs"),
  Wing: noun("Flügel", "m"),
  Dragon: noun("Drache", "m", "Drachen"),
  Wall: noun("Mauer", "f"),
  Castling: noun("Rochade", "f", "Rochade"),
  Deviations: noun("Abweichungen", "pl"),
  Extension: noun("Erweiterung", "f"),
  Elephant: noun("Elefant", "m", "Elefanten"),
  Lion: noun("Löwe", "m", "Löwen"),
  Rat: noun("Ratte", "f", "Ratten"),
  Vulture: noun("Geier", "m"),
  Kangaroo: noun("Känguru", "n"),
  Snake: noun("Schlange", "f", "Schlangen"),
  Fork: noun("Gabel", "f"),
  Symmetry: noun("Symmetrie", "f"),
  Bind: noun("Aufbau", "m"),
  Pin: noun("Fesselung", "f"),
  Unpin: noun("Entfesselung", "f"),
  Development: noun("Entwicklung", "f"),
  Mate: noun("Matt", "n"),
  Connection: noun("Verbindung", "f"),
  Blockade: noun("Blockade", "f"),
  Intermezzo: noun("Zwischenzug", "m"),
  Endgame: noun("Endspiel", "n"),
  Retreat: noun("Rückzug", "m", "Rückzugs"),
  Claw: noun("Klaue", "f"),
  Jaw: noun("Rachen", "m"),
  Cave: noun("Höhle", "f"),
  Penguin: noun("Pinguin", "m"),
  Monkey: noun("Affe", "m", "Affen"),
  Frog: noun("Frosch", "m"),
  Bear: noun("Bär", "m", "Bären"),
  Wolf: noun("Wolf", "m", "Wolfs"),
  Fox: noun("Fuchs", "m"),
  Duck: noun("Ente", "f", "Enten"),
  Spider: noun("Spinne", "f", "Spinnen"),
  Tour: noun("Tour", "f"),
  "King's": pre("Königs"),
  "Queen's": pre("Damen"),
  "Bishop's": pre("Läufer"),
  "Knight's": pre("Springer"),
  Kingside: pre("Königsflügel"),
  Queenside: pre("Damenflügel"),
  Double: pre("Doppel"),
  Minority: pre("Minoritäts"),
  Two: pre("Zwei"),
  Three: pre("Drei"),
  Four: pre("Vier"),
  Five: pre("Fünf"),
  Six: pre("Sechs"),
  Counter: pre("Gegen"),
  // Adjectives
  Closed: adj("Geschlossen"),
  Open: adj("Offen"),
  Classical: adj("Klassisch"),
  Classic: adj("Klassisch"),
  Modern: adj("Modern"),
  Accelerated: adj("Beschleunigt"),
  Hyperaccelerated: adj("Hyperbeschleunigt"),
  Delayed: adj("Verzögert"),
  "Ultra-Delayed": adj("Stark verzögert"),
  Old: adj("Alt"),
  New: adj("Neu"),
  Symmetrical: adj("Symmetrisch"),
  Normal: adj("Normal"),
  Quiet: adj("Ruhig"),
  Central: adj("Zentral"),
  Early: adj("Früh"),
  Original: adj("Ursprünglich"),
  Reversed: adj("Umgekehrt"),
  Sharp: adj("Scharf"),
  Long: adj("Lang"),
  Short: adj("Kurz"),
  Big: adj("Groß"),
  Small: adj("Klein"),
  Great: adj("Groß"),
  Little: adj("Klein"),
  Immediate: adj("Sofortig"),
  Extended: adj("Erweitert"),
  Improved: adj("Verbessert"),
  Fully: adj("Voll"),
  Full: adj("Voll"),
  Black: adj("Schwarz"),
  White: adj("Weiß"),
  Poisoned: adj("Vergiftet"),
  Drunken: adj("Betrunken"),
  Bouncing: adj("Springend"),
  English: adj("Englisch"),
  French: adj("Französisch"),
  Dutch: adj("Holländisch"),
  Russian: adj("Russisch"),
  German: adj("Deutsch"),
  Polish: adj("Polnisch"),
  Italian: adj("Italienisch"),
  Spanish: adj("Spanisch"),
  Scotch: adj("Schottisch"),
  Scottish: adj("Schottisch"),
  Hungarian: adj("Ungarisch"),
  Danish: adj("Dänisch"),
  Swedish: adj("Schwedisch"),
  Norwegian: adj("Norwegisch"),
  American: adj("Amerikanisch"),
  Austrian: adj("Österreichisch"),
  Czech: adj("Tschechisch"),
  Chinese: adj("Chinesisch"),
  Mexican: adj("Mexikanisch"),
  Portuguese: adj("Portugiesisch"),
  Australian: adj("Australisch"),
  Indian: adj("Indisch"),
  Slav: adj("Slawisch"),
  Sicilian: adj("Sizilianisch"),
  Catalan: adj("Katalanisch"),
  Latvian: adj("Lettisch"),
  Scandinavian: adj("Skandinavisch"),
  Greek: adj("Griechisch"),
  Irish: adj("Irisch"),
  Swiss: adj("Schweizer", true),
  Vienna: adj("Wiener", true),
  Berlin: adj("Berliner", true),
  Moscow: adj("Moskauer", true),
  Leningrad: adj("Leningrader", true),
  Dresden: adj("Dresdner", true),
  Marienbad: adj("Marienbader", true),
  Hamburg: adj("Hamburger", true),
  Paris: adj("Pariser", true),
  "King's Indian": adj("Königsindisch"),
  "Queen's Indian": adj("Damenindisch"),
  "Old Indian": adj("Altindisch"),
  "East Indian": adj("Ostindisch"),
  "West Indian": adj("Westindisch"),
  "Semi-Slav": adj("Halbslawisch"),
  "Nimzo-Indian": adj("Nimzo-Indisch"),
  "Bogo-Indian": adj("Bogoljubow-Indisch"),
  "Anglo-Indian": adj("Anglo-Indisch"),
  "Czech-Indian": adj("Tschechisch-Indisch"),
  "Pseudo-Slav": adj("Pseudo-Slawisch"),
  "Queen's Gambit": noun("Damengambit", "n"),
  "King's Gambit": noun("Königsgambit", "n"),
  "King's English": adj("Königsenglisch"),
  Lithuanian: adj("Litauisch"),
  Yugoslav: adj("Jugoslawisch"),
  Baltic: adj("Baltisch"),
  Orthodox: adj("Orthodox"),
  Positional: adj("Positionell"),
  "Semi-Classical": adj("Halbklassisch"),
  "Neo-Modern": adj("Neomodern"),
  Brazilian: adj("Brasilianisch"),
  Argentinian: adj("Argentinisch"),
  Romanian: adj("Rumänisch"),
  Ukrainian: adj("Ukrainisch"),
  Icelandic: adj("Isländisch"),
  Finnish: adj("Finnisch"),
  Belgian: adj("Belgisch"),
  Japanese: adj("Japanisch"),
  Canadian: adj("Kanadisch"),
  Warsaw: adj("Warschauer", true),
  Wiesbaden: adj("Wiesbadener", true),
  Prague: adj("Prager", true),
  Budapest: adj("Budapester", true),
  Traditional: adj("Traditionell"),
  Siberian: adj("Sibirisch"),
  Eastern: adj("Östlich"),
  Western: adj("Westlich"),
  Argentine: adj("Argentinisch"),
  Arctic: adj("Arktisch"),
  Flexible: adj("Flexibl"),
  Compromised: adj("Kompromittiert"),
  Rare: adj("Selten"),
  Carlsbad: adj("Karlsbader", true),
  Standard: pre("Standard"),
  Defensive: pre("Defensiv"),
  Accepted: mod("Angenommen"),
  Declined: mod("Abgelehnt"),
  Deferred: mod("Verzögert"),
  Refused: mod("Abgelehnt"),
  // Plain words
  with: word("mit"),
  and: word("und"),
  without: word("ohne"),
  or: word("oder"),
  the: word(""),
};

/** German spelling of player names (transliteration from Russian etc.). */
const NAMES: Record<string, string> = {
  Alekhine: "Aljechin",
  Botvinnik: "Botwinnik",
  Chigorin: "Tschigorin",
  Petrov: "Petrow",
  Petroff: "Petrow",
  Smyslov: "Smyslow",
  Panov: "Panow",
  Karpov: "Karpow",
  Kasparov: "Kasparow",
  Spassky: "Spasski",
  Taimanov: "Taimanow",
  Sveshnikov: "Sweschnikow",
  Kalashnikov: "Kalaschnikow",
  Polugaevsky: "Polugajewski",
  Benko: "Benkö",
  Averbakh: "Awerbach",
  Rauzer: "Rauser",
  Boleslavsky: "Boleslawski",
  Romanishin: "Romanischin",
  Kotov: "Kotow",
  Petrosian: "Petrosjan",
  Korchnoi: "Kortschnoi",
  Sozin: "Sosin",
  Nimzo: "Nimzowitsch",
  Bogo: "Bogoljubow",
  Bogoljubov: "Bogoljubow",
  Pterodactyl: "Pterodactylus",
  Zaitsev: "Saizew",
  Kholmov: "Cholmow",
  Chekhover: "Tschechower",
  Gurgenidze: "Gurgenidse",
  Makogonov: "Makogonow",
  Lisitsyn: "Lissizyn",
  Alatortsev: "Alatorzew",
  Kasparian: "Kasparjan",
  Ragozin: "Ragosin",
  Ilyin: "Iljin",
  Zhenevsky: "Schenewski",
  Kozul: "Kožul",
  Velimirovic: "Velimirović",
  Semi: "Halb",
  Venice: "Venedig",
  Zurich: "Zürich",
  Belgrade: "Belgrad",
  Goteborg: "Göteborg",
  Arkhangelsk: "Archangelsk",
};

const MOVE = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?)[+#]?$/;
/** Lower-case parts of player names ("del Rio", "van der Wiel", "l'Hermet"). */
const PARTICLE = /^(?:de|del|der|van|von|la|le|du|da|di|[a-z]')/;
const END: Record<Gender, string> = { m: "er", f: "e", n: "es", pl: "e" };

type Token = { e: Entry } | { name: string } | { raw: string };

function nameOf(w: string): string {
  return w
    .split("-")
    .map((p) => NAMES[p] ?? p)
    .join("-");
}

function tokenize(part: string): Token[] {
  const words = part.split(" ").filter(Boolean);
  const out: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    // Longest phrase from the lexicon first ("Queen's Indian", "Main Line").
    let hit = false;
    for (let n = Math.min(3, words.length - i); n >= 2; n--) {
      const e = LEXICON[words.slice(i, i + n).join(" ")];
      if (e) {
        out.push({ e });
        i += n - 1;
        hit = true;
        break;
      }
    }
    if (hit) continue;
    const w = words[i];
    const e = LEXICON[w] ?? (w.endsWith("'s") ? possessive(w.slice(0, -2)) : undefined) ?? hyphenated(w);
    if (e) out.push({ e });
    else if (MOVE.test(w)) out.push({ name: w });
    else if (!/^\p{Lu}/u.test(w) && !PARTICLE.test(w)) out.push({ raw: w });
    else out.push({ name: nameOf(w.replace(/'s?$/, "")) });
  }
  return out;
}

/** "Pseudo-Austrian" -> adjective "Pseudo-Österreichisch". */
function hyphenated(w: string): Entry | undefined {
  const i = w.lastIndexOf("-");
  if (i < 0) return undefined;
  const last = LEXICON[w.slice(i + 1)];
  if (last?.k !== "adj" || last.inv) return undefined;
  const front = w.slice(0, i).split("-").map((p) => {
    const e = LEXICON[p];
    return e?.k === "adj" ? e.stem : (NAMES[p] ?? p);
  });
  return adj(`${front.join("-")}-${last.stem}`);
}

/** "Bishop's" -> the noun as front of a compound. */
function possessive(w: string): Entry | undefined {
  const e = LEXICON[w];
  return e?.k === "noun" ? pre(e.pre ?? e.head) : undefined;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => (s.includes("-") || s.includes(" ") ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** Word by word, for parts the rules don't fit ("with e6", ".. a6 Sideline"). */
function plain(tokens: Token[]): string {
  return tokens
    .map((t) => {
      if ("raw" in t) return t.raw;
      if ("name" in t) return t.name;
      const e = t.e;
      switch (e.k) {
        case "noun":
          return e.head;
        case "pre":
          return e.pre;
        case "adj":
          return e.stem;
        case "mod":
          return `(${low(e.stem)})`;
        case "word":
          return e.de;
      }
    })
    .filter(Boolean)
    .join(" ");
}

function translatePart(part: string, implied = true): string {
  const fixed = FIXED[part];
  if (fixed !== undefined) return fixed;
  // "Reversed X", "X Reversed": the opening with colours swapped.
  const reversed = part.replace(/^Reversed |(?<=.) Reversed\b/, "");
  if (reversed !== part) return `${translatePart(reversed, false)} mit vertauschten Farben`;
  const tokens = tokenize(part);
  if (tokens.some((t) => "raw" in t || ("e" in t && t.e.k === "word"))) return plain(tokens);

  // [adjectives] [names / compound fronts] head [modifiers]
  const mods: string[] = [];
  let end = tokens.length;
  while (end > 0) {
    const t = tokens[end - 1];
    if (!("e" in t) || t.e.k !== "mod") break;
    mods.unshift(t.e.stem);
    end--;
  }
  const head = end > 0 ? tokens[end - 1] : undefined;
  if (implied && end > 0 && tokens.slice(0, end).every((t) => "e" in t && t.e.k === "adj")) {
    // Only adjectives: "Closed" -> "Geschlossene Variante".
    return translatePart(part.replace(/((?: (?:Accepted|Declined|Deferred|Refused))*)$/, " Variation$1"));
  }
  if (!head || !("e" in head) || head.e.k !== "noun") {
    // No noun to decline for: "Réti Accepted", "Najdorf", "Closed".
    const body = plain(tokens.slice(0, end));
    return mods.length ? `${body} ${mods.map((m) => `(${low(m)})`).join(" ")}` : body;
  }
  const g = head.e.g;
  const adjs: { stem: string; inv?: boolean }[] = [];
  let i = 0;
  for (; i < end - 1; i++) {
    const t = tokens[i];
    if (!("e" in t) || t.e.k !== "adj") break;
    adjs.push(t.e);
  }
  // The compound: names joined with hyphens, nouns and fronts run together.
  let compound = "";
  let prevName = false;
  for (; i < end; i++) {
    const t = tokens[i];
    let text: string;
    let isName = false;
    if ("name" in t) {
      text = t.name;
      isName = true;
    } else if ("e" in t && t.e.k === "noun") text = i === end - 1 ? t.e.head : (t.e.pre ?? t.e.head);
    else if ("e" in t && t.e.k === "pre") text = t.e.pre;
    else return plain(tokens); // an adjective in the middle – keep it simple
    if (!compound) compound = cap(text);
    else if (prevName || isName || text.includes("-")) compound += `-${text}`;
    else compound += low(text);
    prevName = isName;
  }
  // Capitalised throughout, as part of a name ("Angenommenes Lettisches Gambit").
  const declined = [...mods.map((stem) => ({ stem })), ...adjs].map((a) => a.stem + ("inv" in a && a.inv ? "" : END[g]));
  return [...declined, compound].join(" ");
}

const cache = new Map<string, string>();

/** Display name of an opening (or a part of one) in the UI language. */
export function openingName(name: string): string {
  if (lang === "en" || !name) return name;
  let out = cache.get(name);
  if (out === undefined) {
    const colon = name.indexOf(":");
    const parts = (s: string) => s.split(", ").map((p) => translatePart(p.trim())).join(", ");
    out = colon < 0 ? parts(name) : `${parts(name.slice(0, colon))}: ${parts(name.slice(colon + 1))}`;
    cache.set(name, out);
  }
  return out;
}

/** Coach comments name the opening in English ("Theoriezug: Italian Game."). */
export function openingInComment(text: string): string {
  if (lang === "en") return text;
  return text.replace(/^Theoriezug: (.+)\.$/, (_, n: string) => `Theoriezug: ${openingName(n)}.`);
}
