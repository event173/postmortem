import { CLASSES, type Class } from "./types";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const FIGURINES: Record<string, string> = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘" };

/** Replace piece letters in SAN tokens with figurines (leaves prose untouched). */
export function fig(text: string): string {
  return text.replace(
    /\b([KQRBN])([a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)/g,
    (_, p: string, rest: string) => FIGURINES[p] + rest.replace(/=([QRBN])/, (_m, q: string) => "=" + FIGURINES[q]),
  );
}

export function badgeHtml(cls: Class): string {
  const c = CLASSES[cls];
  return `<span class="badge" style="--c:${c.color}" title="${c.label}">${esc(c.symbol)}</span>`;
}

/** localStorage that never throws (private mode, blocked storage …). */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: settings just aren't remembered */
    }
  },
};
