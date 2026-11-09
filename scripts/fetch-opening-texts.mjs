// Fetches the opening explanations of the Wikibooks "Chess Opening Theory"
// (CC BY-SA 4.0) for every position of our opening list – matched by position,
// so a page reached by another move order counts too – and writes them to
// src-tauri/data/opening-texts/en.tsv. German translations live next to it in
// de.tsv (made separately; this script never touches them).
//
//   node scripts/fetch-opening-texts.mjs
//
// en.tsv columns: SAN moves from the start (space-separated) · Wikibooks
// revision id · text (paragraphs separated by a literal "\n").

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";

const API = "https://en.wikibooks.org/w/api.php";
const UA = "postmortem-opening-texts/1.0 (https://github.com/event173/postmortem)";
const OUT_DIR = "src-tauri/data/opening-texts";
/** Shorter texts say nothing useful ("=== 4. Bg2 ===" and a half sentence). */
const MIN_CHARS = 80;
/** Sections after the explanation that we don't want. */
const CUT =
  /\n=+ *(Theory table|References|See also|Statistics|Further reading|External links|Sources|Notes|All possible replies|Footnotes)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ format: "json", formatversion: "2", ...params }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

function clean(extract) {
  let t = extract.split(CUT)[0];
  t = t
    .split("\n")
    .map((l) => l.trim())
    // headings ("== 4...Bf5 · Classical Variation ==") and empty lines
    .filter((l) => l && !/^=+.*=+$/.test(l))
    .join("\n");
  return t;
}

/** Position key without move counters and en passant (only used for matching). */
function key(pos) {
  return makeFen(pos.toSetup()).split(" ").slice(0, 3).join(" ");
}

/** Plays SAN moves from the start; null if one is illegal. */
function play(sans) {
  const pos = Chess.default();
  for (const san of sans) {
    const m = parseSan(pos, san);
    if (!m) return null;
    pos.play(m);
  }
  return pos;
}

// Every position on the way of a named line.
const book = new Set();
for (const line of readFileSync("src-tauri/data/openings.tsv", "utf8").split("\n")) {
  const [eco, , pgn] = line.split("\t");
  if (!pgn || eco === "eco") continue;
  const pos = Chess.default();
  for (const san of pgn.split(/\s+/).filter((t) => t && !t.endsWith("."))) {
    const m = parseSan(pos, san);
    if (!m) break;
    pos.play(m);
    book.add(key(pos));
  }
}
console.log(`${book.size} Stellungen im Eröffnungsdatensatz`);

/** "Chess Opening Theory/1. e4/1...c6" -> ["e4", "c6"]; null for other pages. */
function sansOf(t) {
  const parts = t.split("/").slice(1);
  const sans = [];
  for (const [i, p] of parts.entries()) {
    const m = i % 2 === 0 ? p.match(/^(\d+)\. ?(\S+)$/) : p.match(/^(\d+)\.\.\. ?(\S+)$/);
    if (!m || Number(m[1]) !== Math.floor(i / 2) + 1) return null;
    sans.push(m[2]);
  }
  return sans.length ? sans : null;
}

// All pages of the book (not redirects), kept if their position is in our list.
const existing = []; // [path, page title]
let cont = {};
let pages = 0;
do {
  const d = await api({
    action: "query",
    list: "allpages",
    apprefix: "Chess Opening Theory/",
    apfilterredir: "nonredirects",
    aplimit: "500",
    ...cont,
  });
  for (const p of d.query.allpages) {
    pages++;
    const sans = sansOf(p.title);
    const pos = sans && play(sans);
    if (pos && book.has(key(pos))) existing.push([sans.join(" "), p.title]);
  }
  cont = d.continue ?? null;
  await sleep(200);
} while (cont);
// Shortest move order first (the app keeps the first text per position).
existing.sort((a, b) => a[0].split(" ").length - b[0].split(" ").length || a[0].localeCompare(b[0]));
console.log(`${pages} Seiten bei Wikibooks, ${existing.length} davon zu Stellungen im Datensatz`);

// The texts (whole extracts come one page per request).
const rows = [];
for (const [i, [path, t]] of existing.entries()) {
  const d = await api({ action: "query", prop: "extracts|revisions", rvprop: "ids", explaintext: "1", titles: t });
  const page = d.query.pages[0];
  const text = clean(page.extract ?? "");
  if (text.length >= MIN_CHARS) rows.push([path, page.revisions?.[0]?.revid ?? 0, text.replace(/\t/g, " ").replace(/\n/g, "\\n")]);
  if (i % 100 === 0) console.log(`${i}/${existing.length}`);
  await sleep(200);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/en.tsv`, rows.map((r) => r.join("\t")).join("\n") + "\n");
console.log(`${rows.length} Texte geschrieben nach ${OUT_DIR}/en.tsv`);
