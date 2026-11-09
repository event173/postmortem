// Checks that every German UI text has an English translation in src/i18n-en.ts.
//
//   node scripts/i18n-check.mjs          missing and unused keys
//   node scripts/i18n-check.mjs --keys   all keys found in the sources
//
// Keys are the German texts in t("…") / tn(n, "…", "…") calls, the static texts
// and title/placeholder/aria-label attributes of index.html, and a few texts
// that only come from the backend (listed below).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

/** Texts passed to t() as variables. */
const DYNAMIC = [
  // bot levels (src-tauri/src/bot.rs)
  "Erste Schritte",
  "Neuling",
  "Lernt noch",
  "Anfänger",
  "Einsteiger",
  "Gelegenheitsspieler",
  "Vereinsspieler",
  "Fortgeschritten",
  "Experte",
  "Meister",
  "Großmeister+",
  // variation name of a line without sub-name (src-tauri/src/openings.rs)
  "Hauptvariante",
];

/** Static texts that stay as they are (names, symbols). */
const KEEP = new Set(["post", "mortem", "postmortem", "Lichess", "chess.com", "Engine", "Stockfish", "Review", "Puzzles", "Sound", "Deutsch", "English", "Sprache · Language", "A–Z", "Cburnett", "Merida", "Chessnut", "Fantasy", "Celtic", "Spatial", "MPChess", "Shapes", "RhosGFX", "Sand"]);

const unescape = (s) => s.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");

function tsKeys() {
  const keys = new Set();
  const dir = join(root, "src");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f === "i18n-en.ts") continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1]));
    for (const m of src.matchAll(/\btn\([^,]+,\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"/g)) {
      keys.add(unescape(m[1]));
      keys.add(unescape(m[2]));
    }
  }
  return keys;
}

function htmlKeys() {
  const keys = new Set();
  const html = readFileSync(join(root, "index.html"), "utf8").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
  const body = html.slice(html.indexOf("<body"));
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const text = m[1].replace(/&nbsp;/g, " ").replace(/&#10;/g, "\n").trim();
    if (text && /[A-Za-zÄÖÜäöüß]{2}/.test(text)) keys.add(text);
  }
  for (const m of body.matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g)) {
    const v = m[1].replace(/&#10;/g, "\n");
    if (/[A-Za-zÄÖÜäöüß]{2}/.test(v)) keys.add(v);
  }
  for (const m of body.matchAll(/\s(?:title|placeholder|aria-label)='([^']*)'/g)) keys.add(m[1].replace(/&#10;/g, "\n"));
  return keys;
}

function dictionary() {
  const src = readFileSync(join(root, "src", "i18n-en.ts"), "utf8");
  const keys = new Set();
  for (const m of src.matchAll(/^\s*("(?:[^"\\]|\\.)*")\s*:/gm)) keys.add(JSON.parse(m[1]));
  return keys;
}

const used = new Set([...tsKeys(), ...htmlKeys(), ...DYNAMIC].filter((k) => !KEEP.has(k)));
if (process.argv.includes("--keys")) {
  for (const k of [...used].sort()) console.log(JSON.stringify(k));
  process.exit(0);
}
const dict = dictionary();
const missing = [...used].filter((k) => !dict.has(k)).sort();
const unused = [...dict].filter((k) => !used.has(k) && !KEEP.has(k)).sort();
for (const k of missing) console.log(`missing: ${JSON.stringify(k)}`);
for (const k of unused) console.log(`unused:  ${JSON.stringify(k)}`);
console.log(`${used.size} texts, ${missing.length} missing, ${unused.length} unused`);
process.exit(missing.length ? 1 : 0);
