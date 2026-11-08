// "Puzzles" tab: training with puzzles picked for your weaknesses (see trainer.rs).
//
// Lichess puzzles: the first move is the opponent's; then you play the solution,
// the opponent's replies are played automatically. Own puzzles: the position
// before one of your mistakes; any move the engine rates "Excellent" or better counts.

import { invoke } from "@tauri-apps/api/core";
import type { Api } from "chessground/api";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";

import { THEMES, gameWindow, setGameWindow, windowLast, type GameWindow } from "./stats";
import { CLASSES, type Account, type Class, type MoveReview, type PlayedMove, type PositionInfo, type Theme } from "./types";
import { $, badgeHtml, esc, fig } from "./util";

type Kind = "lichess" | "own";
type Category = "weakness" | "mixed" | "own";
type Color = "white" | "black";

interface OwnInfo {
  gameId: string;
  ply: number;
  san: string;
  classification: Class;
  opponent: string;
  createdAt: number;
  comment: string;
}

interface Puzzle {
  kind: Kind;
  id: string;
  fen: string;
  moves: string[];
  rating: number | null;
  themes: string[];
  category: Category;
  theme: Theme | null;
  gameUrl: string | null;
  own: OwnInfo | null;
}

interface Profile {
  rating: number;
  attempts: number;
  solved: number;
  todayAttempts: number;
  todaySolved: number;
  mastery: { theme: Theme; attempts: number; solved: number }[];
}

interface RatingChange {
  rating: number;
  delta: number;
}

export interface PuzzleDeps {
  board: Api;
  accounts: () => Account[];
  /** Piece animation length, to time the opponent's replies. */
  animMs: () => number;
  /** Open the settings dialog (to download the puzzle database). */
  openSettings: () => void;
}

type Phase = "loading" | "opponent" | "solve" | "checking" | "wrong" | "solved" | "failed" | "empty";

const ACCEPTED: Class[] = ["brilliant", "great", "best", "excellent"];

/** Names for the Lichess themes shown after solving. */
const LICHESS_THEMES: Record<string, string> = {
  fork: "Gabel",
  pin: "Fesselung",
  skewer: "Spieß",
  hangingPiece: "Hängende Figur",
  trappedPiece: "Gefangene Figur",
  discoveredAttack: "Abzugsangriff",
  deflection: "Ablenkung",
  attraction: "Hinlenkung",
  intermezzo: "Zwischenzug",
  quietMove: "Stiller Zug",
  defensiveMove: "Verteidigung",
  zugzwang: "Zugzwang",
  sacrifice: "Opfer",
  backRankMate: "Grundreihenmatt",
  mateIn1: "Matt in 1",
  mateIn2: "Matt in 2",
  mateIn3: "Matt in 3",
  mateIn4: "Matt in 4",
  mateIn5: "Matt in 5",
  mate: "Matt",
  crushing: "Entscheidender Vorteil",
  advantage: "Vorteil",
  endgame: "Endspiel",
  middlegame: "Mittelspiel",
  opening: "Eröffnung",
  promotion: "Umwandlung",
  doubleCheck: "Doppelschach",
  clearance: "Räumung",
  xRayAttack: "Röntgenangriff",
  interference: "Unterbrechung",
  capturingDefender: "Verteidiger schlagen",
  exposedKing: "Ungeschützter König",
  kingsideAttack: "Königsangriff",
  smotheredMate: "Ersticktes Matt",
};

let deps: PuzzleDeps;
let active = false;
let puzzle: Puzzle | null = null;
let next: Promise<Puzzle | null> | null = null;
let phase: Phase = "loading";
let fen = "";
let step = 0;
let failed = false;
let hint = false;
let lastMove: string | undefined;
let result: RatingChange | null = null;
let ownVerdict: MoveReview | null = null;
let profile: Profile | null = null;
let timer: number | undefined;
let token = 0;

const sideOf = (f: string): Color => (f.split(" ")[1] === "w" ? "white" : "black");
const other = (c: Color): Color => (c === "white" ? "black" : "white");
const sq = (uci: string, from: boolean) => (from ? uci.slice(0, 2) : uci.slice(2, 4)) as Key;

export function initPuzzles(d: PuzzleDeps) {
  deps = d;
  const select = $("pz-window") as HTMLSelectElement;
  select.addEventListener("change", () => {
    setGameWindow(select.value as GameWindow);
    next = null; // the prefetched puzzle was chosen for the old window
  });
}

export function isPuzzleMode(): boolean {
  return active;
}

export function enterPuzzles() {
  active = true;
  ($("pz-window") as HTMLSelectElement).value = gameWindow();
  deps.board.setShapes([]);
  loadProfile();
  if (!puzzle || phase === "empty") loadNext();
  else render();
}

export function leavePuzzles() {
  active = false;
  clearTimeout(timer);
}

/** Keyboard while the puzzle tab is open. */
export function puzzleKey(e: KeyboardEvent): boolean {
  if (e.key === "Enter" && (phase === "solved" || phase === "failed")) {
    loadNext();
    return true;
  }
  return false;
}

async function loadProfile() {
  try {
    profile = await invoke<Profile>("puzzle_profile", { accounts: deps.accounts() });
    renderProfile();
  } catch (e) {
    console.error(e);
  }
}

function fetchPuzzle(): Promise<Puzzle | null> {
  return invoke<Puzzle | null>("puzzle_next", { accounts: deps.accounts(), last: windowLast() });
}

async function loadNext() {
  const t = ++token;
  clearTimeout(timer);
  phase = "loading";
  render();
  let p: Puzzle | null;
  try {
    p = await (next ?? fetchPuzzle());
  } catch (e) {
    next = null;
    if (t !== token) return;
    phase = "empty";
    render(String(e));
    return;
  }
  next = null;
  if (t !== token) return;
  puzzle = p;
  if (!p) {
    phase = "empty";
    render();
    return;
  }
  // Prefetch the one after, so "next" is instant.
  next = fetchPuzzle();
  next.catch(() => (next = null));

  fen = p.fen;
  step = 0;
  failed = false;
  hint = false;
  result = null;
  ownVerdict = null;
  lastMove = undefined;
  deps.board.setShapes([]);

  if (p.kind === "lichess") {
    // You play the side that is *not* to move: the opponent's move comes first.
    phase = "opponent";
    render();
    timer = window.setTimeout(() => playOpponent(t), 700);
  } else {
    phase = "solve";
    render();
  }
}

async function playMove(uci: string): Promise<PlayedMove> {
  return invoke<PlayedMove>("play_move", { fen, from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

async function playOpponent(t: number) {
  if (t !== token || !puzzle) return;
  const uci = puzzle.moves[step];
  const played = await playMove(uci);
  if (t !== token) return;
  fen = played.fen;
  lastMove = played.uci;
  step++;
  phase = "solve";
  render();
}

/** Called by main when you move on the board in puzzle mode. */
export async function puzzleMove(orig: Key, dest: Key, promotion?: string) {
  const p = puzzle;
  if (!p || (phase !== "solve" && phase !== "wrong")) return render();
  const t = token;
  const expected = p.moves[step];
  // Same squares as the solution: use its promotion piece (board promotes to a queen by default).
  const promo = expected && expected.slice(0, 4) === orig + dest ? expected[4] : promotion;
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: orig, to: dest, promotion: promo });
  } catch {
    return render();
  }
  if (t !== token) return;

  if (p.kind === "lichess") {
    const isLast = step === p.moves.length - 1;
    const correct = played.uci === expected || (isLast && (await isMate(played)));
    if (correct) return advance(played, t);
    return wrong(played, t);
  }

  // Own position: exact best move, or anything the engine rates Excellent or better.
  if (played.uci === expected) return advance(played, t);
  phase = "checking";
  showTry(played);
  try {
    ownVerdict = await invoke<MoveReview>("evaluate_move", { fen, uci: played.uci });
  } catch {
    ownVerdict = null;
  }
  if (t !== token) return;
  if (ownVerdict && ACCEPTED.includes(ownVerdict.classification)) return advance(played, t);
  wrong(played, t);
}

async function isMate(played: PlayedMove): Promise<boolean> {
  if (!played.check) return false;
  const info = await invoke<PositionInfo>("position_info", { fen: played.fen });
  return Object.keys(info.dests).length === 0;
}

function showTry(played: PlayedMove) {
  deps.board.set({
    fen: played.fen,
    lastMove: [sq(played.uci, true), sq(played.uci, false)],
    check: played.check,
    movable: { color: undefined, dests: new Map() },
  });
  renderText();
}

async function advance(played: PlayedMove, t: number) {
  const p = puzzle!;
  fen = played.fen;
  lastMove = played.uci;
  step++;
  if (p.kind === "own" || step >= p.moves.length) {
    phase = "solved";
    render();
    // Only the first try counts (as on Lichess): a failure was already recorded.
    if (!failed) await record(true);
    return;
  }
  // Opponent's reply, then your turn again.
  phase = "opponent";
  render();
  timer = window.setTimeout(() => playOpponent(t), deps.animMs() + 250);
}

async function wrong(played: PlayedMove, t: number) {
  phase = "wrong";
  showTry(played);
  if (!failed) {
    failed = true;
    await record(false);
  }
  // Show the wrong move briefly, then go back to the puzzle position.
  timer = window.setTimeout(() => {
    if (t === token && phase === "wrong") render();
  }, 900);
}

async function record(solved: boolean) {
  const p = puzzle;
  if (!p) return;
  try {
    result = await invoke<RatingChange>("puzzle_record", {
      accounts: deps.accounts(),
      attempt: { id: p.id, kind: p.kind, theme: p.theme, rating: p.rating, solved },
    });
  } catch (e) {
    console.error(e);
  }
  loadProfile();
  renderText();
}

async function showSolution() {
  const p = puzzle;
  if (!p) return;
  const t = token;
  clearTimeout(timer);
  if (!failed) {
    failed = true;
    await record(false);
  }
  phase = "failed";
  // Play the remaining solution moves one after another.
  const playRest = async () => {
    if (t !== token || step >= p.moves.length) return render();
    const played = await playMove(p.moves[step]);
    if (t !== token) return;
    fen = played.fen;
    lastMove = played.uci;
    step++;
    render();
    timer = window.setTimeout(playRest, deps.animMs() + 400);
  };
  playRest();
}

// ---------------------------------------------------------------------------
// rendering

function render(error?: string) {
  if (!active) return;
  const p = puzzle;
  const board = deps.board;
  if (p && phase !== "loading" && phase !== "empty") {
    const me: Color = p.kind === "lichess" ? other(sideOf(p.fen)) : sideOf(p.fen);
    const shapes: DrawShape[] = [];
    if (hint && phase === "solve" && p.moves[step]) shapes.push({ orig: sq(p.moves[step], true), brush: "green" });
    if (phase === "solved" && lastMove) {
      shapes.push({ orig: sq(lastMove, false), customSvg: { html: badgeSvg("#7cad3f", "✓") } });
    }
    board.set({
      fen,
      orientation: me,
      turnColor: sideOf(fen),
      lastMove: lastMove ? [sq(lastMove, true), sq(lastMove, false)] : undefined,
      check: false,
      movable: { color: undefined, dests: new Map() },
    });
    board.setAutoShapes(shapes);
    if (phase === "solve" || phase === "wrong") {
      const t = token;
      invoke<PositionInfo>("position_info", { fen }).then((info) => {
        if (t !== token || !active || (phase !== "solve" && phase !== "wrong")) return;
        board.set({ movable: { color: me, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
      });
    }
  }
  renderText(error);
}

function badgeSvg(color: string, symbol: string): string {
  return `<g transform="translate(66 -10)"><circle cx="22" cy="22" r="22" fill="${color}" stroke="#fff" stroke-width="3"/>
    <text x="22" y="23" text-anchor="middle" dominant-baseline="central" fill="#fff" font-family="system-ui, sans-serif" font-weight="800" font-size="26">${symbol}</text></g>`;
}

function categoryTag(p: Puzzle): string {
  if (p.category === "own" && p.own) {
    const d = new Date(p.own.createdAt).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
    return `<span class="pz-tag own">Aus deiner Partie</span><span class="muted">vs ${esc(p.own.opponent)} · ${d}</span>`;
  }
  if (p.category === "weakness" && p.theme) {
    return `<span class="pz-tag weakness" title="Gewählt, weil das in deinen Partien oft vorkommt">Schwäche: ${esc(THEMES[p.theme].label)}</span>`;
  }
  return `<span class="pz-tag mixed" title="Ein beliebiges Thema auf deinem Niveau – damit das Training nicht einseitig wird">Gemischt</span>`;
}

function renderText(error?: string) {
  if (!active) return;
  const head = $("pz-head");
  const text = $("pz-text");
  const extra = $("pz-extra");
  const actions = $("pz-actions");
  const p = puzzle;
  extra.innerHTML = "";

  if (phase === "loading") {
    head.innerHTML = `<span class="muted">Suche ein passendes Puzzle …</span>`;
    text.innerHTML = "";
    actions.innerHTML = "";
    return;
  }
  if (phase === "empty" || !p) {
    head.innerHTML = `<span class="coach-title">Keine Puzzles</span>`;
    text.innerHTML = error
      ? `<span class="error">${esc(error)}</span>`
      : `Für Lichess-Puzzles brauchst du die Puzzle-Datenbank. Ohne sie gibt es nur Stellungen aus deinen eigenen Fehlern – und dafür müssen erst Partien analysiert sein.`;
    actions.innerHTML = `<button data-act="settings" class="primary">Puzzle-Datenbank laden</button><button data-act="retry">Nochmal versuchen</button>`;
    bindActions();
    return;
  }

  const me: Color = p.kind === "lichess" ? other(sideOf(p.fen)) : sideOf(p.fen);
  const side = me === "white" ? "Weiß" : "Schwarz";
  head.innerHTML = categoryTag(p) + (p.rating ? `<span class="pz-puzzle-rating" title="Puzzle-Wertung">${p.rating}</span>` : "");

  const delta = result ? `<span class="pz-delta ${result.delta >= 0 ? "up" : "down"}">${result.delta >= 0 ? "+" : ""}${Math.round(result.delta)}</span>` : "";
  switch (phase) {
    case "opponent":
      text.innerHTML = `<span class="muted">Der Gegner zieht …</span>`;
      break;
    case "solve":
      text.innerHTML =
        p.kind === "own" && p.own
          ? `In der Partie hast du hier <b>${esc(fig(p.own.san))}</b> gespielt – ${CLASSES[p.own.classification].phrase}. Finde einen besseren Zug für ${side}.`
          : `<b>${side} am Zug.</b> ${step > 1 ? "Richtig – weiter!" : "Finde den besten Zug."}`;
      if (hint) text.innerHTML += ` <span class="muted">Tipp: Zieh mit der markierten Figur.</span>`;
      break;
    case "checking":
      text.innerHTML = `<span class="muted">Prüfe deinen Zug …</span>`;
      break;
    case "wrong":
      text.innerHTML =
        ownVerdict
          ? `${badgeHtml(ownVerdict.classification)} <b>${esc(fig(ownVerdict.san))}</b> ist ${CLASSES[ownVerdict.classification].phrase}. ${esc(fig(ownVerdict.comment))}`
          : `<b>Das ist nicht die Lösung.</b>`;
      text.innerHTML += ` <span class="muted">Versuch es nochmal.</span> ${delta}`;
      break;
    case "solved":
      text.innerHTML = failed
        ? `<b>Gelöst</b> – im zweiten Anlauf. ${delta}`
        : `<b class="ok">Richtig!</b> ${p.kind === "own" ? "Diesmal hast du's gefunden." : ""} ${delta}`;
      break;
    case "failed":
      text.innerHTML = `Die Lösung wird gezeigt. ${delta}`;
      break;
  }

  if (phase === "solved" || phase === "failed") {
    const themes = p.themes.map((t) => LICHESS_THEMES[t]).filter(Boolean);
    const parts: string[] = [];
    if (themes.length) parts.push(`<span class="muted">Themen:</span> ${themes.join(", ")}`);
    if (p.own) parts.push(`<span class="muted">In der Partie:</span> ${esc(fig(p.own.comment))}`);
    if (p.gameUrl) parts.push(`<span class="muted">Ursprung:</span> <span class="pz-url">${esc(p.gameUrl)}</span>`);
    extra.innerHTML = parts.join("<br>");
    actions.innerHTML = `<button data-act="next" class="primary">Nächstes Puzzle →</button>`;
  } else {
    const busy = phase === "opponent" || phase === "checking";
    actions.innerHTML = `
      <button data-act="hint" ${hint || busy ? "disabled" : ""}>Tipp</button>
      <button data-act="solution" ${busy ? "disabled" : ""}>Lösung zeigen</button>
      <button data-act="skip" class="end">Überspringen</button>`;
  }
  bindActions();
}

function bindActions() {
  $("pz-actions")
    .querySelectorAll<HTMLButtonElement>("button[data-act]")
    .forEach((b) =>
      b.addEventListener("click", () => {
        switch (b.dataset.act) {
          case "hint":
            hint = true;
            render();
            break;
          case "solution":
            showSolution();
            break;
          case "skip":
          case "next":
          case "retry":
            loadNext();
            break;
          case "settings":
            deps.openSettings();
            break;
        }
      }),
    );
}

function renderProfile() {
  const p = profile;
  if (!p) return;
  $("pz-my-rating").textContent = String(Math.round(p.rating));
  $("pz-today").textContent = p.todayAttempts
    ? `Heute: ${p.todaySolved} von ${p.todayAttempts} gelöst`
    : p.attempts
      ? `Insgesamt ${p.solved} von ${p.attempts} gelöst`
      : "Noch keine Puzzles gelöst";
  const rows = [...p.mastery]
    .sort((a, b) => b.attempts - a.attempts)
    .map((m) => {
      const pct = m.attempts ? Math.round((m.solved / m.attempts) * 100) : 0;
      return `<div class="mastery-row" title="Letzte ${m.attempts} Puzzles zu diesem Thema">
        <span class="theme-label">${esc(THEMES[m.theme].label)}</span>
        <span class="bar-track"><span class="bar" style="width:${pct}%"></span></span>
        <span class="theme-count"><b>${pct} %</b> <span class="muted">· ${m.solved}/${m.attempts}</span></span>
      </div>`;
    })
    .join("");
  $("pz-mastery").innerHTML = rows
    ? `<h3>Lösungsquote nach Schwäche</h3><p class="panel-sub">Was du sicher löst, kommt seltener dran.</p>${rows}`
    : "";
}
