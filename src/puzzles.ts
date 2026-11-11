// "Puzzles" tab: training with puzzles picked for your weaknesses (see trainer.rs).
//
// Lichess puzzles: the first move is the opponent's; then you play the solution,
// the opponent's replies are played automatically. Own puzzles: the position
// before one of your mistakes; any move the engine rates "Excellent" or better counts.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Api } from "chessground/api";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";

import { THEMES, gameWindow, setGameWindow, windowLast, type GameWindow } from "./stats";
import { CLASSES, type Account, type Class, type MoveReview, type PlayedMove, type PositionInfo, type Theme } from "./types";
import { locale, playerName, t } from "./i18n";
import { $, badgeHtml, commentOf, esc, fig } from "./util";
import { errorSound, moveSound, setupSound, successSound } from "./sound";

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
  themePerGame: number | null;
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
  /** Open one of your games in the review at a ply. */
  openGame: (gameId: string, ply: number) => void;
}

/** A move played freely after the puzzle is over. */
interface ExploreMove {
  fenBefore: string;
  fen: string;
  uci: string;
  san: string;
  check: boolean;
  /** Played by "Engine zieht". */
  engine?: boolean;
  review?: MoveReview;
  pending?: boolean;
}

type Phase = "loading" | "opponent" | "solve" | "checking" | "wrong" | "showing" | "solved" | "failed" | "empty";

interface LineMove {
  uci: string;
  san: string;
  fen: string;
  check: boolean;
}

interface Refutation {
  moves: LineMove[];
  text: string;
}

const ACCEPTED: Class[] = ["brilliant", "great", "best", "excellent"];

/** Names for the Lichess themes shown after solving. */
const LICHESS_THEMES: Record<string, string> = {
  fork: t("Gabel"),
  pin: t("Fesselung"),
  skewer: t("Spieß"),
  hangingPiece: t("Hängende Figur"),
  trappedPiece: t("Gefangene Figur"),
  discoveredAttack: t("Abzugsangriff"),
  deflection: t("Ablenkung"),
  attraction: t("Hinlenkung"),
  intermezzo: t("Zwischenzug"),
  quietMove: t("Stiller Zug"),
  defensiveMove: t("Verteidigung"),
  zugzwang: t("Zugzwang"),
  sacrifice: t("Opfer"),
  backRankMate: t("Grundreihenmatt"),
  mateIn1: t("Matt in 1"),
  mateIn2: t("Matt in 2"),
  mateIn3: t("Matt in 3"),
  mateIn4: t("Matt in 4"),
  mateIn5: t("Matt in 5"),
  mate: t("Matt"),
  crushing: t("Entscheidender Vorteil"),
  advantage: t("Vorteil"),
  endgame: t("Endspiel"),
  middlegame: t("Mittelspiel"),
  opening: t("Eröffnung"),
  promotion: t("Umwandlung"),
  doubleCheck: t("Doppelschach"),
  clearance: t("Räumung"),
  xRayAttack: t("Röntgenangriff"),
  interference: t("Unterbrechung"),
  capturingDefender: t("Verteidiger schlagen"),
  exposedKing: t("Ungeschützter König"),
  kingsideAttack: t("Königsangriff"),
  smotheredMate: t("Ersticktes Matt"),
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
/** Your last wrong try, to replay on the board what happens after it. */
let lastTry: { fenBefore: string; played: PlayedMove } | null = null;
let refute: (Refutation & { uci: string; shown: number }) | null = null;
/** Free moves after the puzzle (both sides). */
let explore: ExploreMove[] = [];
let engineBusy = false;
let exploreNote = "";

/** Puzzle over (solved, or solution fully shown): the board is free to explore. */
/** Every position of the puzzle line so far (start, opponent's move, your moves …). */
let history: { fen: string; lastMove?: string; check?: boolean }[] = [];
/** Free moves branch off `history[exploreBase]`. */
let exploreBase = 0;
/** Position being looked at (index into positions()), null = the latest one. */
let viewIndex: number | null = null;
/** "Puzzle wiederholen": a replay doesn't count for the rating. */
let replay = false;

const finished = () => (phase === "solved" || phase === "failed") && !!puzzle && step >= puzzle.moves.length;

interface Pos {
  fen: string;
  lastMove?: string;
  check?: boolean;
  review?: MoveReview;
}

/** The line up to the branch point, then the free moves. */
function positions(): Pos[] {
  return [
    ...history.slice(0, exploreBase + 1),
    ...explore.map((e) => ({ fen: e.fen, lastMove: e.uci, check: e.check, review: e.review })),
  ];
}
const curIndex = () => viewIndex ?? positions().length - 1;
const viewFen = () => positions()[curIndex()]?.fen ?? fen;

/** Record the current line position (call after `fen`/`lastMove` changed). */
function pushHistory(check = false) {
  history.push({ fen, lastMove, check });
  exploreBase = history.length - 1;
}

/** Moving in an earlier position: continue from there (drop what came after). */
function branchAtView() {
  const i = curIndex();
  if (i <= exploreBase) {
    exploreBase = i;
    explore = [];
  } else {
    explore.length = i - exploreBase;
  }
  viewIndex = null;
}

function stepView(delta: number) {
  if (!finished()) return;
  const n = positions().length;
  const before = curIndex();
  const i = Math.max(0, Math.min(curIndex() + delta, n - 1));
  viewIndex = i === n - 1 ? null : i;
  if (i !== before) {
    const pos = positions()[i];
    moveSound(pos.check ? "+" : "");
  }
  render();
}

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
  $("pz-banner-install").addEventListener("click", () => deps.openSettings());
  // Deleted (or installed) in the settings while this tab is open.
  $("settings").addEventListener("close", () => {
    if (active) checkDatabase();
  });
  // Database installed or deleted in the settings: update the banner, and
  // replace the "no puzzles" screen with a real puzzle.
  listen<{ phase: string }>("puzzle-progress", (e) => {
    if (e.payload.phase !== "done") return;
    next = null;
    checkDatabase();
    if (active && phase === "empty") loadNext();
  });
}

/** Banner on top of the tab while the Lichess puzzle database is missing. */
async function checkDatabase() {
  try {
    const st = await invoke<{ installed: boolean }>("puzzle_status");
    $("pz-banner").hidden = st.installed;
  } catch {
    $("pz-banner").hidden = true;
  }
}

export function isPuzzleMode(): boolean {
  return active;
}

/** The buttons under the board: step through the solved puzzle (nothing while solving). */
export function puzzleNav(dir: "first" | "prev" | "next" | "last"): boolean {
  if (!active) return false;
  if (!finished()) return true;
  if (dir === "prev" || dir === "next") return stepView(dir === "prev" ? -1 : 1), true;
  const n = positions().length;
  stepView(dir === "first" ? -n : n);
  return true;
}

export function enterPuzzles() {
  active = true;
  ($("pz-window") as HTMLSelectElement).value = gameWindow();
  deps.board.setShapes([]);
  checkDatabase();
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
  if (finished() && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    stepView(e.key === "ArrowLeft" ? -1 : 1);
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
  const tk = ++token;
  clearTimeout(timer);
  phase = "loading";
  // Clear the last puzzle's marks right away (no animation is running now, so
  // the shape layer redraws immediately).
  deps.board.setAutoShapes([]);
  deps.board.setShapes([]);
  render();
  let p: Puzzle | null;
  try {
    p = await (next ?? fetchPuzzle());
  } catch (e) {
    next = null;
    if (tk !== token) return;
    phase = "empty";
    render(String(e));
    return;
  }
  next = null;
  if (tk !== token) return;
  puzzle = p;
  if (!p) {
    phase = "empty";
    render();
    return;
  }
  // Prefetch the one after, so "next" is instant.
  next = fetchPuzzle();
  next.catch(() => (next = null));

  replay = false;
  result = null;
  beginPuzzle(tk);
}

/** (Re)start the current puzzle from its first position. */
function beginPuzzle(tk: number) {
  const p = puzzle!;
  fen = p.fen;
  step = 0;
  failed = false;
  hint = false;
  ownVerdict = null;
  lastMove = undefined;
  lastTry = null;
  refute = null;
  explore = [];
  exploreNote = "";
  history = [];
  viewIndex = null;
  pushHistory();
  setupSound();
  deps.board.setShapes([]);
  deps.board.setAutoShapes([]);

  if (p.kind === "lichess") {
    // You play the side that is *not* to move: the opponent's move comes first.
    phase = "opponent";
    render();
    timer = window.setTimeout(() => playOpponent(tk), 700);
  } else {
    phase = "solve";
    render();
  }
}

async function playMove(uci: string): Promise<PlayedMove> {
  return invoke<PlayedMove>("play_move", { fen, from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

async function playOpponent(tk: number) {
  if (tk !== token || !puzzle) return;
  const uci = puzzle.moves[step];
  const played = await playMove(uci);
  if (tk !== token) return;
  fen = played.fen;
  lastMove = played.uci;
  pushHistory(played.check);
  moveSound(played.san);
  step++;
  phase = "solve";
  render();
}

/** Called by main when you move on the board in puzzle mode. */
export async function puzzleMove(orig: Key, dest: Key, promotion?: string) {
  const p = puzzle;
  if (p && finished()) return exploreMove(orig, dest, promotion);
  if (!p || (phase !== "solve" && phase !== "wrong")) return render();
  const tk = token;
  const expected = p.moves[step];
  // Same squares as the solution: use its promotion piece (board promotes to a queen by default).
  const promo = expected && expected.slice(0, 4) === orig + dest ? expected[4] : promotion;
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: orig, to: dest, promotion: promo });
  } catch {
    return render();
  }
  if (tk !== token) return;

  if (p.kind === "lichess") {
    const isLast = step === p.moves.length - 1;
    const correct = played.uci === expected || (isLast && (await isMate(played)));
    if (correct) return advance(played, tk);
    return wrong(played, tk);
  }

  // Own position: exact best move, or anything the engine rates Excellent or better.
  if (played.uci === expected) return advance(played, tk);
  phase = "checking";
  showTry(played);
  try {
    ownVerdict = await invoke<MoveReview>("evaluate_move", { fen, uci: played.uci });
  } catch {
    ownVerdict = null;
  }
  if (tk !== token) return;
  if (ownVerdict && ACCEPTED.includes(ownVerdict.classification)) return advance(played, tk);
  wrong(played, tk);
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

async function advance(played: PlayedMove, tk: number) {
  const p = puzzle!;
  fen = played.fen;
  lastMove = played.uci;
  pushHistory(played.check);
  moveSound(played.san);
  step++;
  if (p.kind === "own" || step >= p.moves.length) {
    phase = "solved";
    successSound();
    render();
    // Only the first try counts (as on Lichess): a failure was already recorded.
    if (!failed) await record(true);
    return;
  }
  // Opponent's reply, then your turn again.
  phase = "opponent";
  render();
  timer = window.setTimeout(() => playOpponent(tk), deps.animMs() + 250);
}

async function wrong(played: PlayedMove, tk: number) {
  phase = "wrong";
  errorSound();
  lastTry = { fenBefore: fen, played };
  showTry(played);
  if (!failed) {
    failed = true;
    await record(false);
  }
  // Show the wrong move briefly, then go back to the puzzle position.
  timer = window.setTimeout(() => {
    if (tk === token && phase === "wrong") render();
  }, 900);
}

async function record(solved: boolean) {
  const p = puzzle;
  if (!p || replay) return;
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

// --- free exploration after the puzzle --------------------------------------

async function exploreMove(orig: Key, dest: Key, promotion?: string) {
  const tk = token;
  const before = viewFen();
  branchAtView();
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen: before, from: orig, to: dest, promotion });
  } catch {
    return render();
  }
  if (tk !== token) return;
  const m: ExploreMove = { fenBefore: before, fen: played.fen, uci: played.uci, san: played.san, check: played.check, pending: true };
  explore.push(m);
  moveSound(m.san);
  exploreNote = "";
  render();
  try {
    m.review = await invoke<MoveReview>("evaluate_move", { fen: before, uci: played.uci });
  } catch {
    /* no verdict, the move still stands */
  }
  m.pending = false;
  if (tk === token && explore.includes(m)) render();
}

/** Let Stockfish play the best move for the side to move. */
async function engineMove() {
  const tk = token;
  const before = viewFen();
  branchAtView();
  engineBusy = true;
  renderText();
  try {
    const line = await invoke<Refutation>("engine_line", { fen: before, plies: 1 });
    if (tk !== token || viewFen() !== before) return;
    const mv = line.moves[0];
    if (mv) {
      explore.push({ fenBefore: before, ...mv, engine: true });
      moveSound(mv.san);
    }
    else exploreNote = t("Keine Züge mehr – die Partie ist hier zu Ende.");
  } catch (e) {
    exploreNote = String(e);
  } finally {
    engineBusy = false;
    if (tk === token) render();
  }
}

function exploreText(): string {
  if (!explore.length) {
    return `<p class="explore-hint">${t("Zieh jetzt frei weiter – für beide Seiten – oder lass die Engine ziehen, um zu sehen, was passieren würde.")}</p>`;
  }
  const moves = explore
    .map((m) => {
      const mark = m.review ? badgeHtml(m.review.classification) : m.pending ? `<span class="pending"></span>` : "";
      return `<span class="ex-mv${m.engine ? " engine" : ""}">${mark}${esc(fig(m.san))}</span>`;
    })
    .join(" ");
  const last = explore[explore.length - 1];
  let verdict = "";
  if (last.engine) verdict = t("{move} – bester Zug laut Engine.", { move: `<b>${esc(fig(last.san))}</b>` });
  else if (last.pending) verdict = `<span class="muted">${t("Bewerte {move} …", { move: esc(fig(last.san)) })}</span>`;
  else if (last.review) {
    const r = last.review;
    verdict = `${t("{move} ist {phrase}", { move: `<b>${esc(fig(r.san))}</b>`, phrase: CLASSES[r.classification].phrase })}. ${esc(fig(commentOf(r)))}`;
  }
  return `<div class="explore-line">${moves}</div><div class="explore-verdict">${verdict}</div>`;
}

/** Replay your wrong move and the engine's best answer on the board. */
async function showWhy() {
  const tryNow = lastTry;
  if (!tryNow) return;
  const tk = token;
  clearTimeout(timer);
  phase = "showing";
  if (!refute || refute.uci !== tryNow.played.uci) {
    refute = null;
    renderText();
    try {
      const r = await invoke<Refutation>("refutation", { fen: tryNow.fenBefore, uci: tryNow.played.uci });
      refute = { ...r, uci: tryNow.played.uci, shown: 0 };
    } catch (e) {
      if (tk !== token) return;
      phase = "wrong";
      render(String(e));
      return;
    }
    if (tk !== token || phase !== "showing") return;
  }
  const line = refute.moves;
  refute.shown = 0;
  // Start from the puzzle position, so your move animates too.
  deps.board.set({
    fen: tryNow.fenBefore,
    lastMove: lastMove ? [sq(lastMove, true), sq(lastMove, false)] : undefined,
    check: false,
    movable: { color: undefined, dests: new Map() },
  });
  deps.board.setAutoShapes([]);
  renderText();
  const stepOnce = () => {
    if (tk !== token || phase !== "showing" || !refute) return;
    const m = line[refute.shown];
    if (!m) return renderText();
    deps.board.set({ fen: m.fen, lastMove: [sq(m.uci, true), sq(m.uci, false)], check: m.check });
    // Your move gets a red marker so it's clear where things went wrong.
    deps.board.setAutoShapes(refute.shown === 0 ? [{ orig: sq(m.uci, false), customSvg: { html: badgeSvg("#d23a3a", "✕") } }] : []);
    refute.shown++;
    renderText();
    timer = window.setTimeout(stepOnce, deps.animMs() + 550);
  };
  timer = window.setTimeout(stepOnce, 350);
}

function backToPuzzle() {
  clearTimeout(timer);
  phase = "wrong";
  render();
}

async function showSolution() {
  const p = puzzle;
  if (!p) return;
  const tk = token;
  clearTimeout(timer);
  if (!failed) {
    failed = true;
    await record(false);
  }
  phase = "failed";
  // Play the remaining solution moves one after another.
  const playRest = async () => {
    if (tk !== token || step >= p.moves.length) return render();
    const played = await playMove(p.moves[step]);
    if (tk !== token) return;
    fen = played.fen;
    lastMove = played.uci;
    pushHistory(played.check);
    moveSound(played.san);
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
  if (phase === "loading" || phase === "empty") board.setAutoShapes([]);
  if (p && phase !== "loading" && phase !== "empty" && phase !== "showing") {
    const me: Color = p.kind === "lichess" ? other(sideOf(p.fen)) : sideOf(p.fen);
    const shapes: DrawShape[] = [];
    // The hint also applies after a wrong try (that's when it's needed most).
    if (hint && (phase === "solve" || phase === "wrong") && p.moves[step]) {
      shapes.push({ orig: sq(p.moves[step], true), brush: "green" });
    }
    // The position being looked at (after the puzzle you can step through all of them).
    const index = curIndex();
    const pos = positions()[index] ?? { fen, lastMove };
    const atSolution = index === history.length - 1 && index === exploreBase;
    if (phase === "solved" && atSolution && pos.lastMove) {
      shapes.push({ orig: sq(pos.lastMove, false), customSvg: { html: badgeSvg("#7cad3f", "✓") } });
    }
    if (pos.review && pos.lastMove) {
      const c = CLASSES[pos.review.classification];
      shapes.push({ orig: sq(pos.lastMove, false), customSvg: { html: badgeSvg(c.color, esc(c.symbol)) } });
    }
    const shownFen = pos.fen;
    board.set({
      fen: shownFen,
      orientation: me,
      turnColor: sideOf(shownFen),
      lastMove: pos.lastMove ? [sq(pos.lastMove, true), sq(pos.lastMove, false)] : undefined,
      check: pos.check ?? false,
      movable: { color: undefined, dests: new Map() },
    });
    board.setAutoShapes(shapes);
    if (finished()) {
      // Both sides may move: always the side to move.
      const tk = token;
      invoke<PositionInfo>("position_info", { fen: shownFen }).then((info) => {
        if (tk !== token || !active || !finished() || viewFen() !== shownFen) return;
        board.set({ movable: { color: sideOf(shownFen), dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
      });
    }
    if (phase === "solve" || phase === "wrong") {
      const tk = token;
      invoke<PositionInfo>("position_info", { fen }).then((info) => {
        if (tk !== token || !active || (phase !== "solve" && phase !== "wrong")) return;
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

const PIECE_NAMES: Record<string, string> = {
  p: t("dem Bauern"),
  n: t("dem Springer"),
  b: t("dem Läufer"),
  r: t("dem Turm"),
  q: t("der Dame"),
  k: t("dem König"),
};

/** Piece letter on a square of a FEN position ("e4" -> "N"), or null. */
function pieceAt(fenStr: string, square: string): string | null {
  const rows = fenStr.split(" ")[0].split("/");
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  let col = 0;
  for (const ch of rows[8 - rank] ?? "") {
    if (/\d/.test(ch)) col += Number(ch);
    else if (col++ === file) return ch;
  }
  return null;
}

function hintText(p: Puzzle): string {
  const move = p.moves[step];
  if (!move) return "";
  const piece = pieceAt(fen, move.slice(0, 2));
  const name = piece ? PIECE_NAMES[piece.toLowerCase()] : t("der markierten Figur");
  return `<span class="hint-text">${t("Tipp: Zieh mit {piece} von {square}.", { piece: name, square: move.slice(0, 2) })}</span>`;
}

function categoryTag(p: Puzzle): string {
  if (p.category === "own" && p.own) {
    const d = new Date(p.own.createdAt).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "2-digit" });
    return `<span class="pz-tag own">${t("Aus deiner Partie")}</span><span class="muted">${t("vs {name}", { name: esc(playerName(p.own.opponent)) })} · ${d}</span>`;
  }
  if (p.category === "weakness" && p.theme) {
    const rate = p.themePerGame != null ? p.themePerGame.toLocaleString(locale, { maximumFractionDigits: 1 }) : null;
    const last = windowLast();
    const why = !rate
      ? t("Kommt in deinen Partien oft vor.")
      : last
        ? t("Kommt in deinen letzten {n} Partien {rate}× pro Partie vor.", { n: last, rate })
        : t("Kommt in deinen Partien {rate}× pro Partie vor.", { rate });
    return `<span class="pz-tag weakness">${t("Schwäche: {theme}", { theme: esc(THEMES[p.theme].label) })}</span>
      <span class="pz-why">${why}</span>`;
  }
  return `<span class="pz-tag mixed" title="${t("Ein beliebiges Thema auf deinem Niveau – damit das Training nicht einseitig wird")}">${t("Gemischt")}</span>`;
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
    head.innerHTML = `<span class="muted">${t("Suche ein passendes Puzzle …")}</span>`;
    text.innerHTML = "";
    actions.innerHTML = "";
    return;
  }
  if (phase === "empty" || !p) {
    head.innerHTML = `<span class="coach-title">${t("Keine Puzzles")}</span>`;
    text.innerHTML = error
      ? `<span class="error">${esc(error)}</span>`
      : t("Für Lichess-Puzzles brauchst du die Puzzle-Datenbank. Ohne sie gibt es nur Stellungen aus deinen eigenen Fehlern – und dafür müssen erst Partien analysiert sein.");
    actions.innerHTML = `<button data-act="settings" class="primary">${t("Puzzle-Datenbank laden")}</button><button data-act="retry">${t("Nochmal versuchen")}</button>`;
    bindActions();
    return;
  }

  const me: Color = p.kind === "lichess" ? other(sideOf(p.fen)) : sideOf(p.fen);
  const side = me === "white" ? t("Weiß") : t("Schwarz");
  head.innerHTML =
    categoryTag(p) +
    (replay ? `<span class="pz-tag mixed" title="${t("Wiederholungen zählen nicht für die Wertung")}">${t("Wiederholt")}</span>` : "") +
    (p.rating ? `<span class="pz-puzzle-rating" title="${t("Puzzle-Wertung")}">${p.rating}</span>` : "");

  const delta = result ? `<span class="pz-delta ${result.delta >= 0 ? "up" : "down"}">${result.delta >= 0 ? "+" : ""}${Math.round(result.delta)}</span>` : "";
  switch (phase) {
    case "opponent":
      text.innerHTML = `<span class="muted">${t("Der Gegner zieht …")}</span>`;
      break;
    case "solve":
      text.innerHTML =
        p.kind === "own" && p.own
          ? t("In der Partie hast du hier {move} gespielt – {phrase}. Finde einen besseren Zug für {side}.", {
              move: `<b>${esc(fig(p.own.san))}</b>`,
              phrase: CLASSES[p.own.classification].phrase,
              side,
            })
          : `<b>${t("{side} am Zug.", { side })}</b> ${step > 1 ? t("Richtig – weiter!") : t("Finde den besten Zug.")}`;
      if (hint) text.innerHTML += `<br>${hintText(p)}`;
      break;
    case "checking":
      text.innerHTML = `<span class="muted">${t("Prüfe deinen Zug …")}</span>`;
      break;
    case "wrong":
      text.innerHTML =
        ownVerdict
          ? `${badgeHtml(ownVerdict.classification)} ${t("{move} ist {phrase}", { move: `<b>${esc(fig(ownVerdict.san))}</b>`, phrase: CLASSES[ownVerdict.classification].phrase })}. ${esc(fig(commentOf(ownVerdict)))}`
          : `<b>${t("Das ist nicht die Lösung.")}</b>`;
      text.innerHTML += ` <span class="muted">${t("Versuch es nochmal.")}</span> ${delta}`;
      if (hint) text.innerHTML += `<br>${hintText(p)}`;
      break;
    case "showing":
      if (!refute) {
        text.innerHTML = `<span class="muted">${t("Berechne, wie der Gegner antwortet …")}</span>`;
      } else {
        const done = refute.shown >= refute.moves.length;
        // Highlight the moves shown so far.
        const tokens = refute.text.split(" ");
        let moveIdx = 0;
        const shownText = tokens
          .map((tok) => {
            if (/^\d+\.+$/.test(tok) || /^\d+\.\.\.$/.test(tok)) return `<span class="muted">${tok}</span>`;
            const cls = moveIdx === 0 ? "ref-mine" : moveIdx < refute!.shown ? "ref-shown" : "ref-next";
            moveIdx++;
            return `<span class="${cls}">${esc(fig(tok))}</span>`;
          })
          .join(" ");
        text.innerHTML = `<b>${t("So geht es nach deinem Zug weiter:")}</b><br><span class="ref-line">${shownText}</span>`;
        if (done && refute.moves.length === 1) text.innerHTML += `<br><span class="muted">${t("Danach ist die Partie zu Ende.")}</span>`;
      }
      break;
    case "solved":
      text.innerHTML = failed
        ? `${t("<b>Gelöst</b> – im zweiten Anlauf.")} ${delta}`
        : `<b class="ok">${t("Richtig!")}</b> ${p.kind === "own" ? t("Diesmal hast du's gefunden.") : ""} ${delta}`;
      break;
    case "failed":
      text.innerHTML = `${t("Die Lösung wird gezeigt.")} ${delta}`;
      break;
  }

  if (phase === "solved" || phase === "failed") {
    const themes = p.themes.map((tk) => LICHESS_THEMES[tk]).filter(Boolean);
    const parts: string[] = [];
    if (themes.length) parts.push(`<span class="muted">${t("Themen:")}</span> ${themes.join(", ")}`);
    if (p.own) parts.push(`<span class="muted">${t("In der Partie:")}</span> ${esc(fig(p.own.comment))}`);
    if (p.gameUrl && p.kind === "lichess") parts.push(`<span class="muted">${t("Ursprung:")}</span> <span class="pz-url">${esc(p.gameUrl)}</span>`);
    extra.innerHTML = (finished() ? exploreText() : "") + parts.join("<br>") + (exploreNote ? `<br><span class="muted">${esc(exploreNote)}</span>` : "");
    const gameBtn = p.own ? `<button data-act="game">${t("Partie öffnen")}</button>` : "";
    const n = positions().length;
    const i = curIndex();
    actions.innerHTML = finished()
      ? `<span class="pz-nav">
           <button data-act="first" title="${t("Zur Ausgangsstellung")}" ${i === 0 ? "disabled" : ""}><svg class="ctl-icon" viewBox="0 0 16 16"><rect x="2.5" y="3" width="2" height="10" rx="0.5"/><path d="M13.5 3.6v8.8a.6.6 0 0 1-.9.5L6.3 8.5a.6.6 0 0 1 0-1l6.3-4.4a.6.6 0 0 1 .9.5Z"/></svg></button>
           <button data-act="prev" title="${t("Zug zurück (←)")}" ${i === 0 ? "disabled" : ""}><svg class="ctl-icon" viewBox="0 0 16 16"><path d="M11.5 3.6v8.8a.6.6 0 0 1-.9.5L4.3 8.5a.6.6 0 0 1 0-1l6.3-4.4a.6.6 0 0 1 .9.5Z"/></svg></button>
           <button data-act="fwd" title="${t("Zug vor (→)")}" ${i >= n - 1 ? "disabled" : ""}><svg class="ctl-icon" viewBox="0 0 16 16"><path d="M4.5 3.6v8.8a.6.6 0 0 0 .9.5l6.3-4.4a.6.6 0 0 0 0-1L5.4 3.1a.6.6 0 0 0-.9.5Z"/></svg></button>
         </span>
         <button data-act="engine" ${engineBusy ? "disabled" : ""}>${engineBusy ? t("Engine rechnet …") : t("Engine zieht")}</button>
         <button data-act="replay" title="${t("Nochmal von vorn – zählt nicht für die Wertung")}">${t("Puzzle wiederholen")}</button>
         ${gameBtn}
         <button data-act="next" class="primary end">${t("Nächstes Puzzle")} →</button>`
      : `${gameBtn}<button data-act="next" class="primary end">${t("Nächstes Puzzle")} →</button>`;
  } else if (phase === "showing") {
    const done = !!refute && refute.shown >= refute.moves.length;
    actions.innerHTML = `
      <button data-act="why" ${done ? "" : "disabled"}>${t("Nochmal abspielen")}</button>
      <button data-act="back" class="primary">${t("Zurück zur Aufgabe")}</button>`;
  } else {
    const busy = phase === "opponent" || phase === "checking";
    const why = phase === "wrong" && lastTry ? `<button data-act="why" class="primary">${t("Zeig mir, was passiert")}</button>` : "";
    const game = p.own
      ? `<button data-act="game" title="${t("Die Partie in der Review öffnen (das Puzzle wird abgebrochen)")}">${t("Partie öffnen")}</button>`
      : "";
    actions.innerHTML = `${why}${game}
      <button data-act="hint" ${hint || busy ? "disabled" : ""}>${t("Tipp")}</button>
      <button data-act="solution" ${busy ? "disabled" : ""}>${t("Lösung zeigen")}</button>
      <button data-act="skip" class="end">${t("Überspringen")}</button>`;
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
          case "why":
            showWhy();
            break;
          case "back":
            backToPuzzle();
            break;
          case "skip":
          case "next":
          case "retry":
            loadNext();
            break;
          case "settings":
            deps.openSettings();
            break;
          case "engine":
            engineMove();
            break;
          case "first":
            if (curIndex() !== 0) moveSound("");
            viewIndex = 0;
            render();
            break;
          case "prev":
            stepView(-1);
            break;
          case "fwd":
            stepView(1);
            break;
          case "replay": {
            clearTimeout(timer);
            replay = true;
            result = null;
            beginPuzzle(++token);
            break;
          }
          case "game":
            if (puzzle?.own) deps.openGame(puzzle.own.gameId, puzzle.own.ply);
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
    ? t("Heute: {s} von {n} gelöst", { s: p.todaySolved, n: p.todayAttempts })
    : p.attempts
      ? t("Insgesamt {s} von {n} gelöst", { s: p.solved, n: p.attempts })
      : t("Noch keine Puzzles gelöst");
  const rows = [...p.mastery]
    .sort((a, b) => b.attempts - a.attempts)
    .map((m) => {
      const pct = m.attempts ? Math.round((m.solved / m.attempts) * 100) : 0;
      return `<div class="mastery-row" title="${t("Letzte {n} Puzzles zu diesem Thema", { n: m.attempts })}">
        <span class="theme-label">${esc(THEMES[m.theme].label)}</span>
        <span class="bar-track"><span class="bar" style="width:${pct}%"></span></span>
        <span class="theme-count"><b>${pct} %</b> <span class="muted">· ${m.solved}/${m.attempts}</span></span>
      </div>`;
    })
    .join("");
  $("pz-mastery").innerHTML = rows
    ? `<h3>${t("Lösungsquote nach Schwäche")}</h3><p class="panel-sub">${t("Was du sicher löst, kommt seltener dran.")}</p>${rows}`
    : "";
}
