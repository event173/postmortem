// "Erkunden" in the learning tab (see explorer.rs): play an opening freely
// and see which moves can come – from your own games, the opening theory and
// (with a personal token) the Lichess opening explorer. A click on a move plays
// it; "Gegner zieht realistisch" lets the app pick the opponent's moves by how
// often they are played.

import { invoke } from "@tauri-apps/api/core";
import type { Api } from "chessground/api";
import type { Key } from "chessground/types";

import { t, tn } from "./i18n";
import { moveSound, setupSound } from "./sound";
import type { Account, MoveReview, PlayedMove, PositionInfo } from "./types";
import { $, badgeHtml, esc, fig, store } from "./util";
import { openingName } from "./opening-names";
import { bindCardButton, CARD_BUTTON_LABEL } from "./cards";

type Color = "white" | "black";

interface OwnStats {
  games: number;
  byYou: number;
  wins: number;
  draws: number;
  losses: number;
  /** (game id, ply of the move), newest first. */
  examples: [string, number][];
}

interface Candidate {
  uci: string;
  san: string;
  own: OwnStats | null;
  book: boolean;
  name: string | null;
}

interface Moves {
  opening: string | null;
  moves: Candidate[];
  games: number;
  /** Still on the way of a named opening line. */
  inBook: boolean;
}

interface LichessMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
}

interface LichessData {
  total: number;
  moves: LichessMove[];
  ratings: string;
}

/** One row of the table: a move with what each source knows about it. */
interface Row {
  uci: string;
  san: string;
  own: OwnStats | null;
  book: boolean;
  name: string | null;
  /** Lichess games with this move, and its share of all games here. */
  lichess: number;
  share: number;
}

export interface ExplorerDeps {
  board: Api;
  accounts: () => Account[];
  animMs: () => number;
  openGame: (gameId: string, ply: number) => void;
  showTheory: (fen: string | null) => void;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EVAL_MAX = 6;

let deps: ExplorerDeps;
let running = false;
let color: Color = store.get("ex-color") === "black" ? "black" : "white";
let realistic = store.get("ex-realistic") === "1";
let evalOn = store.get("ex-eval") === "1";

/** The moves played so far; `cursor` of them are on the board (the rest can be redone with "vor"). */
let line: PlayedMove[] = [];
let cursor = 0;
const fenAt = (n: number) => (n === 0 ? START_FEN : line[n - 1].fen);
let fen = START_FEN;
let lastMove: string | undefined;
/** Opening name of the position after n moves (index n), where it has one. */
let names: (string | null)[] = [null];
let inBook = true;

let moves: Moves | null = null;
/** Result of "Ins Repertoire" for the moves on the board (cleared when they change). */
let repNote: string | null = null;

interface Added {
  added: number;
  conflict: string | null;
}

/** Your moves of the line on the board into your repertoire (up to where you play something else). */
async function addToRepertoire() {
  const ucis = line.slice(0, cursor).map((m) => m.uci);
  try {
    const r = await invoke<Added>("rep_add_line", { color, moves: ucis });
    repNote = r.added
      ? `✓ ${tn(r.added, "1 Zug übernommen", "{n} Züge übernommen")}${r.conflict ? ` · ${t("ab {move} spielst du anders", { move: fig(r.conflict) })}` : ""}`
      : r.conflict
        ? t("Dort spielst du {move}", { move: fig(r.conflict) })
        : `✓ ${t("Schon in deinem Repertoire")}`;
  } catch (e) {
    repNote = esc(String(e));
  }
  renderPanel();
}
let lichess: LichessData | null = null;
let lichessState: "off" | "loading" | "ok" | "error" = "off";
let lichessError = "";
const evals = new Map<string, MoveReview | "busy">();
/** Bumped on every position change: answers for an old position are dropped. */
let gen = 0;
let timer: number | undefined;

/** "In den Karteikasten" for the position on the board (kept across re-renders). */
let cardBtn: HTMLButtonElement | null = null;
function cardButton(): HTMLButtonElement {
  if (!cardBtn) {
    cardBtn = document.createElement("button");
    cardBtn.innerHTML = CARD_BUTTON_LABEL();
    cardBtn.title = t("Diese Stellung als Lernkarte üben – Stockfish sucht die besten Züge");
    bindCardButton(cardBtn, () => ({ fen, source: "explore" }));
  }
  return cardBtn;
}

const sideOf = (f: string): Color => (f.split(" ")[1] === "w" ? "white" : "black");
const sq = (uci: string, from: boolean) => (from ? uci.slice(0, 2) : uci.slice(2, 4)) as Key;

export function startExplorer(d: ExplorerDeps) {
  deps = d;
  running = true;
  reset();
  invoke("explorer_prepare", { accounts: deps.accounts() })
    .catch(() => 0)
    .then(() => {
      if (running) load(true);
    });
}

export function stopExplorer() {
  running = false;
  gen++;
  clearTimeout(timer);
}

export function explorerKey(e: KeyboardEvent): boolean {
  const dir = ({ ArrowLeft: "prev", ArrowRight: "next", Home: "first", End: "last" } as const)[e.key as "ArrowLeft"];
  if (!dir) return false;
  explorerNav(dir);
  return true;
}

/** The buttons under the board: start, back, forward, end (forward redoes taken-back moves). */
export function explorerNav(dir: "first" | "prev" | "next" | "last") {
  if (!running) return;
  let n = dir === "first" ? 0 : dir === "last" ? line.length : dir === "prev" ? cursor - 1 : cursor + 1;
  n = Math.max(0, Math.min(line.length, n));
  // With the opponent moving by itself, stop on your own moves.
  if (realistic && n > 0 && n < line.length && sideOf(fenAt(n)) !== color) n += dir === "prev" ? -1 : dir === "next" ? 1 : 0;
  if (n === cursor) return;
  goTo(n);
}

function goTo(n: number) {
  cursor = n;
  fen = fenAt(n);
  lastMove = n ? line[n - 1].uci : undefined;
  deps.board.cancelMove();
  if (n) moveSound(line[n - 1].san);
  deps.showTheory(n ? fen : null);
  load(false);
}

function reset() {
  gen++;
  clearTimeout(timer);
  fen = START_FEN;
  lastMove = undefined;
  line = [];
  cursor = 0;
  names = [null];
  inBook = true;
  moves = null;
  lichess = null;
  setupSound();
  deps.showTheory(null);
  load(true);
}

/**
 * Fetch the candidates of the current position; after a real move (`auto`),
 * let the opponent answer if "Gegner zieht realistisch" is on.
 */
async function load(auto = false) {
  const g = ++gen;
  repNote = null;
  clearTimeout(timer);
  lichess = null;
  lichessState = "loading";
  try {
    moves = await invoke<Moves>("explorer_moves", { fen });
  } catch {
    moves = null;
  }
  if (g !== gen || !running) return;
  names[cursor] = moves?.opening ?? null;
  inBook = moves?.inBook ?? false;
  render();
  const lichessDone = invoke<LichessData | null>("explorer_lichess", { fen, accounts: deps.accounts() })
    .then((d) => {
      if (g !== gen) return;
      lichess = d;
      lichessState = d ? "ok" : "off";
    })
    .catch((e) => {
      if (g !== gen) return;
      lichessState = "error";
      lichessError = String(e);
    })
    .finally(() => g === gen && running && render());
  if (evalOn) evaluate(g);
  if (auto && realistic && sideOf(fen) !== color) {
    await lichessDone;
    if (g !== gen || !running) return;
    timer = window.setTimeout(() => g === gen && opponentMove(), cursor ? deps.animMs() + 300 : 500);
  }
}

/** All moves of the position from all sources, most played first. */
function rows(): Row[] {
  const out = new Map<string, Row>();
  for (const c of moves?.moves ?? []) out.set(c.uci, { ...c, lichess: 0, share: 0 });
  const total = lichess?.total ?? 0;
  for (const m of lichess?.moves ?? []) {
    const n = m.white + m.draws + m.black;
    const row = out.get(m.uci) ?? { uci: m.uci, san: m.san, own: null, book: false, name: null, lichess: 0, share: 0 };
    row.lichess = n;
    row.share = total ? n / total : 0;
    out.set(m.uci, row);
  }
  const list = [...out.values()];
  const order = new Map(list.map((r, i) => [r.uci, i]));
  return list.sort((a, b) => b.lichess - a.lichess || (b.own?.games ?? 0) - (a.own?.games ?? 0) || order.get(a.uci)! - order.get(b.uci)!);
}

/** "Gegner zieht realistisch": pick the opponent's move by how often it's played. */
function opponentMove() {
  const list = rows();
  const weight = (r: Row, i: number) => r.lichess || (r.own?.games ?? 0) * 3 + (r.book ? 1 / (i + 1) : 0);
  const weights = list.map(weight);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return render();
  let x = Math.random() * sum;
  const pick = list.find((_, i) => (x -= weights[i]) <= 0) ?? list[0];
  playUci(pick.uci);
}

async function playUci(uci: string) {
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return;
  }
  applyMove(played);
}

export async function explorerMove(orig: Key, dest: Key, promotion?: string) {
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: orig, to: dest, promotion });
  } catch {
    return render();
  }
  applyMove(played);
}

function applyMove(played: PlayedMove) {
  // The same move as the one taken back: keep the moves after it for "vor".
  if (line[cursor]?.uci !== played.uci) {
    line = [...line.slice(0, cursor), played];
    names = names.slice(0, cursor + 1);
  }
  cursor++;
  fen = played.fen;
  lastMove = played.uci;
  moveSound(played.san);
  deps.showTheory(fen);
  load(true);
}

/** Stockfish's verdict on the candidates (the first few), one after the other. */
async function evaluate(g: number) {
  for (const r of rows().slice(0, EVAL_MAX)) {
    const key = `${fen}|${r.uci}`;
    if (evals.has(key)) continue;
    evals.set(key, "busy");
    try {
      evals.set(key, await invoke<MoveReview>("evaluate_move", { fen, uci: r.uci }));
    } catch {
      evals.delete(key);
    }
    if (g !== gen || !running) return;
    render();
  }
}

// ---------------------------------------------------------------------------

function render() {
  if (!running) return;
  deps.board.set({
    fen,
    orientation: color,
    turnColor: sideOf(fen),
    lastMove: lastMove ? [sq(lastMove, true), sq(lastMove, false)] : undefined,
    check: false,
    movable: { color: undefined, dests: new Map() },
  });
  deps.board.setAutoShapes([]);
  const g = gen;
  invoke<PositionInfo>("position_info", { fen }).then((info) => {
    if (g !== gen || !running) return;
    // Both sides can be moved by hand: you also choose the opponent's move.
    deps.board.set({ movable: { color: sideOf(fen), dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
  });
  renderPanel();
}

function moveList(): string {
  const sans = line.slice(0, cursor).map((m) => m.san);
  if (!sans.length) return `<span class="muted">${t("Grundstellung – zieh einen Zug oder wähl unten einen aus.")}</span>`;
  return sans.map((s, i) => `${i % 2 === 0 ? `<span class="muted">${i / 2 + 1}.</span>` : ""}${esc(fig(s))}`).join(" ");
}

/** The opening on the board: the deepest named position on the way; outside theory, the last one. */
function openingHeading(): string {
  let last: string | null = null;
  for (let i = 0; i <= cursor; i++) last = names[i] ?? last;
  if (!cursor) return `<div class="ex-opening"><span class="muted">${t("Grundstellung")}</span></div>`;
  if (inBook) return `<div class="ex-opening"><b>${esc(last ? openingName(last) : t("Eröffnungstheorie"))}</b></div>`;
  return `<div class="ex-opening"><span class="ex-offbook">${t("Außerhalb der bekannten Theorie")}</span>${last ? `<br><span class="muted">${t("zuletzt: {name}", { name: esc(openingName(last)) })}</span>` : ""}</div>`;
}

function ownCell(o: OwnStats | null): string {
  if (!o) return `<span class="muted">–</span>`;
  const who = o.byYou === o.games ? t("von dir") : o.byYou === 0 ? t("gegen dich") : t("{n}× von dir", { n: o.byYou });
  const [id, ply] = o.examples[0] ?? [];
  return `<span title="${t("{w} gewonnen, {d} remis, {l} verloren", { w: o.wins, d: o.draws, l: o.losses })}">${o.games}× <span class="muted">${who}</span>
    <span class="ex-wdl"><i class="w">${o.wins}</i>/<i>${o.draws}</i>/<i class="l">${o.losses}</i></span></span>
    ${id ? `<a href="#" class="ex-game" data-game="${esc(id)}" data-ply="${ply}" title="${t("Letzte Partie damit öffnen")}">↗</a>` : ""}`;
}

function renderPanel() {
  const box = $("op-explore");
  const list = rows();
  const turn = sideOf(fen);
  const yourTurn = turn === color;
  const lichessNote =
    lichessState === "ok" && lichess
      ? t("Lichess ({ratings}): {n} Partien", { ratings: esc(lichess.ratings), n: lichess.total.toLocaleString() })
      : lichessState === "loading"
        ? t("Lichess wird gefragt …")
        : lichessState === "error"
          ? `<span class="error">${esc(lichessError)}</span>`
          : t("Ohne Lichess-Schlüssel nur deine Partien und die Theorie (Einstellungen → Lichess).");
  const evalCell = (r: Row) => {
    if (!evalOn) return "";
    const e = evals.get(`${fen}|${r.uci}`);
    return `<span class="ex-eval">${e === "busy" ? `<span class="muted">…</span>` : e ? badgeHtml(e.classification) : ""}</span>`;
  };

  box.innerHTML = `
    <div class="ex-head">
      <div class="segmented" id="ex-color">
        <button data-c="white" class="${color === "white" ? "active" : ""}">${t("Ich spiele Weiß")}</button>
        <button data-c="black" class="${color === "black" ? "active" : ""}">${t("Ich spiele Schwarz")}</button>
      </div>
      <button id="ex-reset" ${line.length ? "" : "disabled"}>${t("Neu")}</button>
      <span id="ex-card-slot"></span>
      <button id="ex-rep" ${line.slice(0, cursor).some((_, i) => (i % 2 === 0) === (color === "white")) ? "" : "disabled"} title="${t(
        "Deine Züge dieser Folge in dein Repertoire übernehmen – jeder wird eine Karte im Karteikasten",
      )}">${repNote ?? t("Ins Repertoire")}</button>
    </div>
    <label class="ex-opt"><input type="checkbox" id="ex-realistic" ${realistic ? "checked" : ""}/> ${t("Gegner zieht realistisch")}
      <small>${t("Die App wählt die Züge deines Gegners nach Häufigkeit.")}</small></label>
    <label class="ex-opt"><input type="checkbox" id="ex-evalon" ${evalOn ? "checked" : ""}/> ${t("Stockfish bewertet die Züge")}</label>
    ${openingHeading()}
    <div class="ex-line">${moveList()}</div>
    <h3>${yourTurn ? t("Deine Möglichkeiten") : t("Was kann der Gegner spielen?")}</h3>
    ${
      list.length
        ? `<div class="ex-table">
            <div class="ex-row ex-th"><span>${t("Zug")}</span><span>${t("Lichess")}</span><span>${t("Deine Partien")}</span><span>${t("Theorie")}</span></div>
            ${list
              .map(
                (r) => `<div class="ex-row" data-uci="${r.uci}" role="button" tabindex="0" title="${t("Diesen Zug spielen")}">
                  <span class="ex-san">${esc(fig(r.san))}${evalCell(r)}</span>
                  <span class="ex-share">${r.lichess ? `<span class="ex-bar"><i style="width:${Math.max(2, r.share * 100)}%"></i></span>${Math.round(r.share * 100)} %` : `<span class="muted">–</span>`}</span>
                  <span class="ex-own">${ownCell(r.own)}</span>
                  <span class="ex-book">${r.book ? `<span class="ex-booktag" title="${esc(openingName(r.name ?? ""))}">${t("Buch")}</span>${r.name ? ` <span class="muted ex-name">${esc(openingName(r.name.split(":").slice(1).join(":").trim() || r.name))}</span>` : ""}` : ""}</span>
                </div>`,
              )
              .join("")}
          </div>`
        : `<p class="muted">${t("Hier kennen weder deine Partien noch die Theorie weitere Züge. Zieh frei weiter oder geh zurück.")}</p>`
    }
    <p class="panel-sub">${lichessNote}${moves ? ` · ${tn(moves.games, "1 eigene Partie", "{n} eigene Partien")}` : ""}</p>
    <p class="panel-sub">${t("Nur zum Üben – nicht während einer laufenden Partie benutzen.")}</p>`;

  box.querySelectorAll<HTMLElement>("#ex-color button").forEach((b) =>
    b.addEventListener("click", () => {
      color = b.dataset.c as Color;
      store.set("ex-color", color);
      reset();
    }),
  );
  $("ex-reset").addEventListener("click", reset);
  $("ex-rep").addEventListener("click", addToRepertoire);
  $("ex-card-slot").appendChild(cardButton());
  ($("ex-realistic") as HTMLInputElement).addEventListener("change", (e) => {
    realistic = (e.target as HTMLInputElement).checked;
    store.set("ex-realistic", realistic ? "1" : "0");
    load(true);
  });
  ($("ex-evalon") as HTMLInputElement).addEventListener("change", (e) => {
    evalOn = (e.target as HTMLInputElement).checked;
    store.set("ex-eval", evalOn ? "1" : "0");
    if (evalOn) evaluate(gen);
    renderPanel();
  });
  box.querySelectorAll<HTMLElement>(".ex-row[data-uci]").forEach((row) => {
    const go = () => playUci(row.dataset.uci!);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".ex-game")) return;
      go();
    });
    row.addEventListener("keydown", (e) => e.key === "Enter" && go());
  });
  box.querySelectorAll<HTMLElement>(".ex-game").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      deps.openGame(a.dataset.game!, Number(a.dataset.ply));
    }),
  );
}
