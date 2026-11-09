// UI language: German (the source language, used as the key) or English.
//
// t(german, params) looks the German text up in the English
// dictionary when English is active. Static texts in index.html are
// translated once at start by translateDom(). Switching the language reloads
// the window, so nothing has to be re-rendered by hand.

import { invoke } from "@tauri-apps/api/core";

import { EN } from "./i18n-en";

export type Lang = "de" | "en";

function detect(): Lang {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("lang");
  } catch {
    /* storage unavailable */
  }
  if (saved === "de" || saved === "en") return saved;
  return (navigator.language || "de").toLowerCase().startsWith("de") ? "de" : "en";
}

export const lang: Lang = detect();

/** Locale for numbers and dates. */
export const locale = lang === "de" ? "de-DE" : navigator.language?.toLowerCase().startsWith("en") ? navigator.language : "en-GB";

type Params = Record<string, string | number>;

const missing = new Set<string>();

export function t(de: string, params?: Params): string {
  let s = de;
  if (lang === "en") {
    const en = EN[de];
    if (en !== undefined) s = en;
    else if (import.meta.env.DEV && !missing.has(de)) {
      missing.add(de);
      console.warn(`[i18n] missing English text: ${JSON.stringify(de)}`);
    }
  }
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}

/** Singular or plural, e.g. tn(n, "1 Partie", "{n} Partien"). */
export function tn(n: number, one: string, many: string, params?: Params): string {
  return t(n === 1 ? one : many, { n: n.toLocaleString(locale), ...params });
}

/** Display name of stored player names that are German words. */
export function playerName(name: string): string {
  if (lang === "de") return name;
  if (name === "Du") return "You";
  if (name === "Anonym") return "Anonymous";
  const level = /^Stockfish Stufe (\d+)$/.exec(name);
  return level ? `Stockfish level ${level[1]}` : name;
}

export function setLang(l: Lang) {
  try {
    localStorage.setItem("lang", l);
  } catch {
    /* storage unavailable */
  }
  location.reload();
}

const ATTRS = ["title", "placeholder", "aria-label"];

/** Translate the static texts (and title/placeholder attributes) under `root`. */
export function translateDom(root: ParentNode = document.body) {
  if (lang === "de") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const raw = node.data;
    const key = raw.trim();
    if (!key || node.parentElement?.closest("script, style")) continue;
    const en = EN[key];
    if (en !== undefined) node.data = raw.replace(key, en);
    else if (/[A-Za-zÄÖÜäöüß]{2}/.test(key)) t(key); // report it in development
  }
  root.querySelectorAll<HTMLElement>("[title], [placeholder], [aria-label]").forEach((el) => {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) el.setAttribute(a, t(v));
    }
  });
}

// Before anything else renders: static texts, document language, backend language.
document.documentElement.lang = lang;
translateDom();
invoke("set_language", { lang }).catch(() => {});
