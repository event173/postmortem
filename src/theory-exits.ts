// "Hier verlässt du die Theorie": positions in which you are the first to leave
// the known opening lines, again and again (see theory.rs) – in the Lernen tab,
// each with the game and the whole opening line to learn.

import { locale, t, tn } from "./i18n";
import { esc, fig, miniPieces } from "./util";
import { openingName } from "./opening-names";

export interface TheoryExit {
  color: "white" | "black";
  fen: string;
  ply: number;
  opening: string | null;
  family: string | null;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  played: { san: string; count: number }[];
  book: string[];
  best: string | null;
  analysed: number;
  avgLoss: number | null;
  errorsAfter: number;
  gameId: string;
}

export interface TheoryReport {
  games: number;
  youFirst: number;
  opponentFirst: number;
  avgExitMove: number | null;
  positions: TheoryExit[];
}

export interface TheoryActions {
  openGame: (gameId: string, ply: number) => void;
  learnLine: (gameId: string, ply: number, color: "white" | "black", family: string | null) => void;
}

const fmt = (n: number, digits = 1) => n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** The positions as a list (the first `limit` of them). */
export function theoryListHtml(positions: TheoryExit[], limit = positions.length): string {
  return `<div class="theory-list">${positions.slice(0, limit).map(theoryRow).join("")}</div>`;
}

/** Wire the buttons of a list made by `theoryListHtml`. */
export function bindTheoryList(el: HTMLElement, actions: TheoryActions) {
  el.querySelectorAll<HTMLElement>("[data-open]").forEach((b) => (b.onclick = () => actions.openGame(b.dataset.open!, Number(b.dataset.ply) - 1)));
  el.querySelectorAll<HTMLElement>("[data-learn-line]").forEach(
    (b) =>
      (b.onclick = () =>
        actions.learnLine(b.dataset.learnLine!, Number(b.dataset.ply), b.dataset.color as "white" | "black", b.dataset.family || null)),
  );
}

function theoryRow(p: TheoryExit): string {
  const num = Math.ceil(p.ply / 2) + (p.ply % 2 ? "." : "...");
  const played = p.played
    .map((m) => `<b>${num} ${esc(fig(m.san))}</b>${p.played.length > 1 || m.count > 1 ? ` <span class="muted">${m.count}×</span>` : ""}`)
    .join(", ");
  const book = p.book.length ? p.book.map((s) => esc(fig(s))).join(", ") : "–";
  // Did leaving theory cost you something? Only with analysed games.
  let verdict = `<span class="verdict muted">${t("Noch nicht analysiert")}</span>`;
  if (p.analysed) {
    const bad = (p.avgLoss ?? 0) >= 8 || p.errorsAfter * 2 >= p.analysed;
    const ok = (p.avgLoss ?? 0) < 3 && p.errorsAfter === 0;
    const parts = [t("Ø −{n} % Gewinnchance durch deinen Zug", { n: fmt(p.avgLoss ?? 0) })];
    if (p.errorsAfter) parts.push(t("in {e} von {n} Partien folgt bald ein Fehler", { e: p.errorsAfter, n: p.analysed }));
    verdict = `<span class="verdict ${bad ? "bad" : ok ? "ok" : ""}">${bad ? t("Kostet dich") : ok ? t("Hält") : t("Etwas ungenau")}</span>
      <span class="muted">${parts.join(" · ")}${p.analysed < p.games ? ` · ${t("{a} von {n} analysiert", { a: p.analysed, n: p.games })}` : ""}</span>`;
  }
  const best = p.best && !p.book.includes(p.best) ? ` · ${t("Engine: {m}", { m: `<b>${esc(fig(p.best))}</b>` })}` : "";
  return `<div class="theory-row">
    <div class="mini-board cg-wrap" title="${esc(openingName(p.opening ?? ""))}">${miniPieces(p.fen, p.color === "black")}</div>
    <div class="theory-info">
      <div class="theory-title">${esc(p.opening ? openingName(p.opening) : t("Unbekannte Eröffnung"))}</div>
      <div>${t("Du spielst {moves}", { moves: played })} <span class="muted">· ${p.color === "white" ? t("als Weiß") : t("als Schwarz")} · ${tn(p.games, "1 Partie", "{n} Partien")} · ${p.wins}/${p.draws}/${p.losses}</span></div>
      <div class="muted">${t("Bekannte Linien: {moves}", { moves: `<span class="theory-book">${book}</span>` })}${best}</div>
      <div class="theory-verdict">${verdict}</div>
    </div>
    <div class="theory-actions">
      <button class="primary" data-learn-line="${esc(p.gameId)}" data-ply="${p.ply}" data-color="${p.color}" data-family="${esc(p.family ?? "")}" title="${t("Die Eröffnungslinie bis zu dieser Stellung von Anfang an lernen")}">${t("Linie lernen")}</button>
      <button data-open="${p.gameId}" data-ply="${p.ply}" title="${t("Letzte Partie mit dieser Stellung öffnen")}">${t("Ansehen")}</button>
    </div>
  </div>`;
}

