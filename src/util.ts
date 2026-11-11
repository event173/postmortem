import { lang, t } from "./i18n";
import { openingInComment } from "./opening-names";
import { CLASSES, type Class, type MoveReview, type Platform } from "./types";

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

const ROLES: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

/** Pieces of a FEN as chessground <piece> elements (inside a .cg-wrap, so the
 *  board's piece images apply – including the chosen piece set).
 *  `flip`: Black at the bottom. */
export function miniPieces(fen: string, flip = false): string {
  let html = "";
  fen
    .split(" ")[0]
    .split("/")
    .forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) {
          f += Number(ch);
          continue;
        }
        const color = ch === ch.toUpperCase() ? "white" : "black";
        const [x, y] = flip ? [7 - f, 7 - r] : [f, r];
        html += `<piece class="${ROLES[ch.toLowerCase()]} ${color}" style="transform:translate(${x * 100}%,${y * 100}%)"></piece>`;
        f++;
      }
    });
  return html;
}

const SPEEDS: Record<string, string> = {
  ultraBullet: "UltraBullet",
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: t("Schnellschach"),
  classical: t("Klassisch"),
  correspondence: t("Fernschach"),
  daily: t("Fernschach"),
  import: t("Eingespielt"),
  bot: t("Computer"),
};

export const speedLabel = (speed: string) => SPEEDS[speed] ?? speed;

const PLATFORMS: Record<Platform, string> = { lichess: "Lichess", chesscom: "chess.com", local: t("Eigene") };

export const platformLabel = (p: Platform) => PLATFORMS[p] ?? p;

type Comments = Pick<MoveReview, "comment" | "commentEn" | "commentOther" | "commentOtherEn">;

/** Coach comment in the UI language. `mine`: your own move ("Du hattest Matt"),
 *  otherwise written about the mover ("Schwarz hatte Matt"). Older reviews lack
 *  some variants and fall back to what they have. */
export function commentOf(m: Comments, mine = true): string {
  const de = mine ? m.comment : (m.commentOther ?? m.comment);
  const en = mine ? m.commentEn : (m.commentOtherEn ?? m.commentEn);
  return lang === "en" && en ? en : openingInComment(de);
}
