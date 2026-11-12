// "Lernen" tab (openings, flashcards, mistakes, exploring; see repertoire.rs):
// - home (no board): four tiles (due flashcards, mistakes from your games,
//   learning an opening, exploring), one list of your openings – what
//   you learn and what you play, the ones most worth learning first (see
//   recommend.rs) – and your own cards (folded)
// - opening list (full width, board thumbnails): pick an opening and a colour
// - learning: a guided lesson – intro, then move by move ("Weiter" shows the
//   opponent's move, you play your own after the green arrow), each with its
//   Wikibooks explanation; then the line is consolidated without arrows until
//   it works twice in a row, and comes back with spaced repetition – it enters
//   the flashcard box only after one run without arrows and without mistakes
// - while learning one opening, its variations are listed and can be chosen;
//   the course has the lines that come up at your level (Lichess explorer, your
//   games – see relevance.rs), rare sidelines are listed apart

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Api } from "chessground/api";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";

import { cancelVoiceInstall, installVoice, onSpeechChange, speak, speakingKey, speechStatus, stopSpeech, type SpeechLang } from "./speech";
import { windowLast } from "./stats";
import { CLASSES, type Account, type BestMove, type Class, type MoveReview, type PlayedMove, type PositionInfo } from "./types";
import { lang, playerName, t, tn } from "./i18n";
import { $, badgeHtml, commentOf, esc, fig, miniPieces, scoreText, store } from "./util";
import { openingName } from "./opening-names";
import { errorSound, moveSound, setupSound, successSound } from "./sound";
import { explorerKey, explorerMove, explorerNav, startExplorer, stopExplorer } from "./explorer";
import { bindTheoryList, theoryListHtml, type TheoryExit, type TheoryReport } from "./theory-exits";

type Color = "white" | "black";

interface OwnMistake {
  gameId: string;
  ply: number;
  san: string;
  classification: Class;
  opponent: string;
  createdAt: number;
  comment: string;
}

interface Drill {
  /** "card": your own flashcard (from a review, free play or a bot game);
   *  "move": one move of your repertoire (see tree.rs). */
  kind: "line" | "own" | "card" | "move";
  id: string;
  color: Color;
  name: string;
  eco: string;
  fen: string;
  moves: string[];
  /** "practice" = consolidating a just-learned line, "relearn" = learning a
   *  forgotten line again with arrows (both frontend only). */
  status: "new" | "due" | "early" | "practice" | "relearn";
  own: OwnMistake | null;
  /** Named theory moves; after that comes the engine's continuation. */
  bookLen: number;
  card: Card | null;
  /** Kind "move": the moves up to this index are played for you, then you're asked. */
  askFrom?: number;
}

interface Card {
  id: string;
  fen: string;
  color: Color;
  best: BestMove[];
  played: string | null;
  source: "review" | "explore" | "play";
  gameId: string | null;
  ply: number | null;
  createdAt: number;
}

interface CardInfo extends Card {
  boxLevel: number;
  due: boolean;
  dueAt: number;
}

/** Wikibooks explanation of an opening position (see opening_texts.rs). */
interface OpeningText {
  paragraphs: string[];
  /** English original although the app is German. */
  untranslated: boolean;
  url: string;
}

interface SideStatus {
  families: string[];
  lines: number;
  learned: number;
  due: number;
  new: number;
  /** When the next line comes back (ms), if none is due now. */
  nextDue: number | null;
}

interface Status {
  white: SideStatus;
  black: SideStatus;
  /** Your own flashcards due now, and when the next one comes back. */
  cardsDue: number;
  cardsNextDue: number | null;
}

interface Repertoire {
  white: string[];
  black: string[];
}

interface Family {
  name: string;
  lines: number;
  eco: string;
  moves: string;
  fen: string;
}

interface FamilyProgress {
  lines: number;
  started: number;
  learned: number;
  due: number;
}

interface LineInfo {
  id: string;
  name: string;
  plies: number;
  boxLevel: number;
  due: boolean;
  /** When it comes back (ms; 0 = not seen yet). */
  dueAt: number;
  /** Share of games at your level that reach the line (Lichess), if known. */
  reach: number | null;
  /** The line came up in your own games. */
  inGames: boolean;
}

interface FamilyDetail {
  /** The course: common lines and the ones you've started. */
  groups: VariationGroup[];
  /** Rare sidelines, most frequent first. */
  rare: LineInfo[];
  /** Rating groups of the Lichess numbers ("" = none yet). */
  ratings: string;
  complete: boolean;
}

/** Result of fetching the numbers of one opening (see relevance.rs). */
interface Prepared {
  state: "ready" | "partial" | "noToken";
  ratings: string;
  requests: number;
  common: number;
  total: number;
  /** Rare lines taken out of the flashcards now. */
  removed: number;
  error: string | null;
}

/** Where you most often leave theory in an opening and go wrong soon after. */
interface CostlyExit {
  /** The position (before your move) – a node of your repertoire tree. */
  epd: string;
  ply: number;
  played: string;
  book: string[];
  times: number;
  /** One of those games (to find the line behind it). */
  gameId: string;
}

/** What your games say about one opening with one colour (see recommend.rs). */
interface Insight {
  color: Color;
  family: string;
  games: number;
  known: number;
  total: number;
  /** The course is based on Lichess numbers (else: every line). */
  numbers: boolean;
  variation: string | null;
  variationGames: number;
  /** Analysed games; in how many you left theory first and went wrong soon after. */
  reviewed: number;
  theoryErrors: number;
  exit: CostlyExit | null;
  /** Worth suggesting (> 0), higher first. */
  score: number;
}

/** A move for a gap in your repertoire, or another move played in one of your positions. */
interface TreeSuggestion {
  uci: string;
  san: string;
  share: number | null;
  book: boolean;
  /** How often you played it here in your games. */
  games: number;
}

/** What you played in your games instead of your repertoire move. */
interface TreeStray {
  played: string;
  uci: string;
  times: number;
  gameId: string;
  ply: number;
  since: boolean;
}

/** Where one of your games left your repertoire (see tree.rs). */
interface GameReport {
  color: Color;
  kind: "deviation" | "gap";
  epd: string;
  path: string[];
  played: string | null;
  playedUci: string | null;
  mine: string | null;
  opp: string | null;
  gameId: string;
  ply: number;
  createdAt: number;
  since: boolean;
  opening: string | null;
  family: string | null;
  times: number;
}

/** A position of your repertoire in which you are to move (see tree.rs). */
interface TreeNode {
  id: string;
  parent: string | null;
  depth: number;
  opp: string | null;
  oppUci: string | null;
  mine: string | null;
  mineUci: string | null;
  reach: number | null;
  boxLevel: number;
  due: boolean;
  dueAt: number;
  isNew: boolean;
  fen: string;
  fenAfter: string | null;
  path: string[];
  gap: boolean;
  suggestions: TreeSuggestion[];
  alts: TreeSuggestion[];
  hasChildren: boolean;
  opening: string | null;
  games: number;
  strays: TreeStray[];
  note: string;
  recommended: string | null;
  verdict: Verdict | null;
}

/** Stockfish's verdict on one of your repertoire moves. */
interface Verdict {
  class: Class;
  best: string | null;
  bestUci: string | null;
  weak: boolean;
}

interface TreeView {
  color: Color;
  root: string[];
  nodes: TreeNode[];
  coverage: number | null;
  gaps: number;
  cards: number;
  due: number;
  ratings: string;
  complete: boolean;
  error: string | null;
  depth: number;
  weak: number;
  checked: number;
}

interface VariationGroup {
  name: string;
  total: number;
  started: number;
  learned: number;
  due: number;
  lines: LineInfo[];
}

interface Focus {
  color: Color;
  family: string;
  variation?: string | null;
  line?: string | null;
}

export interface OpeningStat {
  color: Color;
  family: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  accuracyAvg: number;
  openingErrors: number;
  gamesWithError: number;
}

export interface OpeningDeps {
  board: Api;
  accounts: () => Account[];
  animMs: () => number;
  openGame: (gameId: string, ply: number) => void;
  /** Switch to the puzzles (for the daily plan). */
  openPuzzles: () => void;
}

/** What the board is used for: learning (one opening), the due reviews, or your own mistakes. */
type TrainMode = "learn" | "due" | "own" | "explore" | "tree" | "spar";
type View = "home" | "browse" | "train" | "opening";
type Sort = "popular" | "mine" | "learning" | "az";
/** "intro": lesson start, "next": waiting for "Weiter" before the opponent's move (lesson). */
type Phase = "loading" | "empty" | "intro" | "next" | "opponent" | "solve" | "checking" | "wrong" | "done";

const ACCEPTED: Class[] = ["brilliant", "great", "best", "excellent"];
const SIDE: Record<Color, string> = { white: t("Weiß"), black: t("Schwarz") };
/** The dataset's variation names are English (shown translated); only "Hauptvariante" (main line) is ours. */
const varName = (n: string) => (n === "Hauptvariante" ? t("Hauptvariante") : openingName(n));
/** Clean runs in a row needed before a newly learned line counts as consolidated. */
const CONSOLIDATE_RUNS = 2;
const CONSOLIDATE_MAX = 5;

let deps: OpeningDeps;
let active = false;
let view: View = "home";

// drill state
let drill: Drill | null = null;
let phase: Phase = "loading";
let fen = "";
let lastMove: string | undefined;
let step = 0;
let failed = false;
let hint = false;
let token = 0;
let timer: number | undefined;
let verdict: MoveReview | null = null;
let wrongTry: PlayedMove | null = null;
let resultDue: number | null = null;
let resultBox: number | null = null;
/** Consolidating a just-learned line: replay it without arrows. `recorded`:
 *  the line is in the flashcard box (after the first clean run). */
let consolidate: { line: Drill; clean: number; runs: number; recorded: boolean } | null = null;
/** The last consolidation run put the line into the flashcard box. */
let enteredBox = false;
/** The consolidation that just ended left the line in the flashcard box. */
let endedInBox = false;
/** Positions before each move of the current drill (for "Zurück"). */
let history: { fen: string; lastMove?: string; step: number }[] = [];
/** Bumped by "Zurück": moves still in flight from before are dropped. */
let nav = 0;
/** The drill's result is already recorded (replaying after "Zurück" doesn't count again). */
let finished = false;
/** Position whose Wikibooks explanation is shown (null: none). */
let theoryFen: string | null = null;
const theoryCache = new Map<string, OpeningText | null>();

// data
let repertoire: Repertoire = { white: [], black: [] };
let status: Status | null = null;
let families: Family[] = [];
let played: Record<string, { white: number; black: number }> = {};
let progress: Record<string, FamilyProgress> = {};
let variations: VariationGroup[] = [];
let rareLines: LineInfo[] = [];
let detailRatings = "";
let rareOpen = false;
let expanded = new Set<string>();
/** Numbers of an opening fetched this session ("color|family"). */
const prepared = new Map<string, Prepared>();
const preparing = new Map<string, Promise<Prepared | null>>();
/** One opening at a time (Lichess takes one request at a time anyway). */
let prepareQueue: Promise<unknown> = Promise.resolve();
/** Fetching right now: which opening and how many positions so far. */
let fetching: { key: string; done: number; waiting: boolean } | null = null;
/** Rare lines taken out of the flashcards this session (home note). */
let removedRare = 0;

// choices
let trainMode: TrainMode = "learn";
let sort: Sort = "popular";
/** Opening mistakes from your games that are due (third card on the home view). */
let ownCount = 0;
/** Your own flashcards (home view). */
let cards: CardInfo[] = [];
/** Your openings as your games show them, best suggestions first (home view). */
let insights: Insight[] = [];
/** The same by "color|family". */
let insightOf: Record<string, Insight> = {};
/** "Deine Karten" unfolded on the home view. */
let cardsOpen = false;
/** Your openings as repertoire trees in a few numbers, by "color|family" (home view). */
let summaries: Record<string, { coverage: number | null; gaps: number; cards: number; due: number; weak: number }> = {};
/** The opening page: which opening, its part of your repertoire, and Stockfish checking it. */
let page: { color: Color; family: string } | null = null;
let pageTree: TreeView | null = null;
let pageHarmless = false;
/** Rating groups of the stored Lichess numbers of the page's opening ("" = none, null = not loaded). */
let pageRatings: string | null = null;
/** Training started from the opening page: "← back" goes there. */
let fromPage = false;
/** Stockfish checking your moves: progress by colour. */
let quality: { color: Color; done: number; total: number } | null = null;
/** Where you leave theory (home view), all of it shown, and scroll there once loaded. */
let theory: TheoryReport | null = null;
let theoryAll = false;
let scrollToTheory = false;
/** "Hier verlässt du die Theorie" shows this many positions folded. */
const THEORY_FOLDED = 3;

// your repertoire as a tree (trainMode "tree")
let tree: TreeView | null = null;
let treeColor: Color = "white";
/** The opening the tree starts from (null: the whole repertoire), and the one it was opened with. */
let treeFamily: string | null = null;
let treeHome: string | null = null;
let treeSel: string | null = null;
const treeOpen = new Set<string>();
/** Fetching the numbers from Lichess right now. */
let treeFetching = false;
/** A position to select once the tree is there (from "Abgleich mit deinen Partien"). */
let treeWant: string | null = null;
/** Choosing another move for the selected position on the board. */
let treeEditing = false;
/** "Andere Möglichkeiten" unfolded for the selected gap. */
let treeAltsOpen = false;
/** Stockfish's verdict on candidate moves in the tree, by "fen|uci" (null: no verdict). */
const treeEvals = new Map<string, MoveReview | null>();
const treeEvalRuns = new Map<string, Promise<MoveReview | null>>();
/** One evaluation at a time. */
let treeEvalQueue: Promise<unknown> = Promise.resolve();
/** Classes worth a warning before a move goes into the repertoire. */
const WEAK: Class[] = ["inaccuracy", "mistake", "miss", "blunder"];
/** Where your games left your repertoire, and the new ones since the app started. */
let reports: GameReport[] = [];
let reportsAll = false;
/** "Alles aus deinen Partien" on the home page unfolded. */
let gamesOpen = false;
/** How long your games stay in your repertoire (see tree.rs). */
let repProgress: { recent: number | null; before: number | null; window: number; games: number } | null = null;
/** Only serious games are compared with your repertoire (no bots, no bullet). */
let seriousOnly = true;
let freshDeviations = 0;
const REPORTS_FOLDED = 4;
/** Your ideas behind your repertoire moves, by colour and position (for the flashcards). */
let notes: Record<Color, Record<string, string>> = { white: {}, black: {} };
const DEPTHS = [8, 10, 12, 15, 0];
let treeToken = 0;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let focus: Focus | null = null;

const sideOf = (f: string): Color => (f.split(" ")[1] === "w" ? "white" : "black");
const sq = (uci: string, from: boolean) => (from ? uci.slice(0, 2) : uci.slice(2, 4)) as Key;
/** A new line is taught with arrows, not tested. */
const learning = () => drill?.kind === "line" && (drill.status === "new" || drill.status === "relearn");
/** Played move by move from the start (a line, or a repertoire move with the moves before it). */
const sequential = (d: Drill) => d.kind === "line" || d.kind === "move";
/** Pause between the moves played for you before a repertoire move. */
const PRELUDE_MS = 260;

// ---------------------------------------------------------------------------
// setup and views

export function initOpenings(d: OpeningDeps) {
  deps = d;
  invoke<Family[]>("opening_families").then((f) => (families = f));

  $("op-back").addEventListener("click", () => setView("home"));
  document.querySelectorAll<HTMLElement>("#op-sort button").forEach((b) =>
    b.addEventListener("click", () => {
      sort = b.dataset.s as Sort;
      document.querySelectorAll<HTMLElement>("#op-sort button").forEach((x) => x.classList.toggle("active", x === b));
      renderList();
    }),
  );
  $("op-search").addEventListener("input", renderList);
  listen<{ color: Color; done: number; total: number }>("rep-quality-progress", (e) => {
    quality = e.payload.done < e.payload.total ? e.payload : null;
    if (trainMode === "tree" && view === "train") renderTreePanel();
    else if (view === "opening") renderPage();
  });
  listen<{ color: Color; family: string; done: number; waiting: boolean }>("relevance-progress", (e) => {
    fetching = { key: `${e.payload.color}|${e.payload.family}`, done: e.payload.done, waiting: e.payload.waiting };
    if (trainMode === "tree" && view === "train") renderTreePanel();
    else if (view === "opening") renderPage();
  });
}

export function isOpeningMode(): boolean {
  return active;
}

export function enterOpenings() {
  active = true;
  deps.board.setShapes([]);
  // A lesson or review in progress continues; otherwise start at the choice.
  setView(view === "train" && drill && phase !== "empty" ? "train" : "home");
  loadPlayed();
}

export function leaveOpenings() {
  active = false;
  stopSpeech();
  clearTimeout(timer);
  // A running free play must not move pieces on the review board later.
  stopExplorer();
  document.querySelector(".layout")!.classList.remove("op-browse-mode", "explore-mode", "tree-mode");
  $("op-browse-view").hidden = true;
  $("op-home").hidden = true;
}

/** From the statistics: the Lernen page at "Hier verlässt du die Theorie". */
export function showTheoryExits() {
  scrollToTheory = true;
  gamesOpen = true;
  if (view !== "home") setView("home");
  else if (theory) renderHome();
}

/** The "Lernen" tab clicked again: back to the choice. */
export function openingsHome() {
  if (active && view !== "home") setView("home");
}

/**
 * The buttons under the board while the Lernen tab is open (false: not for us).
 * "Erkunden" steps through its moves, a course line goes one move back;
 * everything else ignores them (they'd move the hidden game of the review).
 */
export function openingNav(dir: "first" | "prev" | "next" | "last"): boolean {
  if (!active) return false;
  if (view === "train" && trainMode === "explore") {
    explorerNav(dir);
  } else if (view === "train" && dir === "prev" && drill?.kind === "line" && phase !== "checking" && backTarget() >= 0) {
    back();
  }
  return true;
}

export function openingKey(e: KeyboardEvent): boolean {
  if (view !== "train") return false;
  if (trainMode === "explore") return explorerKey(e);
  if (trainMode === "spar") {
    if (e.key === "Enter" && spar?.phase === "end") {
      startSpar();
      return true;
    }
    return false;
  }
  if ((e.key === "Enter" || e.key === "ArrowRight") && (phase === "intro" || phase === "next")) {
    advance();
    return true;
  }
  if (e.key === "Enter" && phase === "done") {
    loadNext();
    return true;
  }
  if (e.key === "ArrowLeft" && backTarget() >= 0) {
    back();
    return true;
  }
  return false;
}

function setView(v: View) {
  view = v;
  // Home and the opening list take the whole width; the board is hidden meanwhile.
  const layout = document.querySelector(".layout")!;
  layout.classList.toggle("op-browse-mode", v !== "train" && active);
  // Free play uses the board's buttons (start, back, forward, end).
  layout.classList.toggle("explore-mode", v === "train" && active && trainMode === "explore");
  // The repertoire tree needs a wide column.
  layout.classList.toggle("tree-mode", v === "train" && active && trainMode === "tree");
  $("op-home").hidden = !(v === "home" && active);
  $("op-opening").hidden = !(v === "opening" && active);
  $("op-browse-view").hidden = !(v === "browse" && active);
  $("openings").hidden = !(v === "train" && active);
  if (v !== "train") {
    // Leaving the board ends what was going on there.
    stopExplorer();
    token++;
    clearTimeout(timer);
    drill = null;
    consolidate = null;
    showTheory(null);
  }
  if (v === "home") fromPage = false;
  if (v === "opening") {
    renderPage();
    loadPage();
  } else if (v === "home") {
    renderHome();
    checkGames()
      .then(() => Promise.all([loadRepertoire(), loadProgress(), loadOwnCount(), loadCards(), loadRecs(), loadTheory(), loadReports(), loadRepProgress()]))
      .then(loadSummaries)
      .then(renderHome);
  } else if (v === "browse") {
    renderList();
    Promise.all([loadProgress(), loadRepertoire()]).then(renderList);
  } else {
    // The board was hidden (size 0): let chessground measure it again before
    // drawing, otherwise the first arrow is drawn with zero size and stays invisible.
    if (active) deps.board.redrawAll();
    const explore = trainMode === "explore";
    $("op-explore").hidden = !explore;
    $("op-tree").hidden = trainMode !== "tree";
    document.querySelector<HTMLElement>("#openings .pz-card")!.hidden = explore;
    renderTop();
    renderSidebar();
    render();
    loadNotes();
  }
}

// ---------------------------------------------------------------------------
// data

async function loadRepertoire() {
  [repertoire, status] = await Promise.all([invoke<Repertoire>("repertoire_get"), invoke<Status>("opening_status")]);
}

async function loadProgress() {
  try {
    progress = await invoke<Record<string, FamilyProgress>>("opening_progress");
  } catch {
    progress = {};
  }
}

async function loadCards() {
  cards = await invoke<CardInfo[]>("cards_list").catch(() => []);
}

async function loadRecs() {
  insights = await invoke<Insight[]>("opening_recommendations", { accounts: deps.accounts() }).catch(() => []);
  insightOf = Object.fromEntries(insights.map((r) => [`${r.color}|${r.family}`, r]));
}

/** Coverage etc. of the openings in "Deine Eröffnungen" (needs progress and insights). */
async function loadSummaries() {
  const keys = myOpenings().map((o) => [o.color, o.family]);
  summaries = await invoke<typeof summaries>("rep_summaries", { accounts: deps.accounts(), keys }).catch(() => ({}));
}

/** Compare new games with your repertoire (cards you played differently become due). */
async function checkGames() {
  const found = await invoke<GameReport[]>("rep_check_games", { accounts: deps.accounts() }).catch(() => []);
  freshDeviations += found.length;
}

async function loadReports() {
  reports = await invoke<GameReport[]>("rep_deviations", { accounts: deps.accounts(), limit: 100 }).catch(() => []);
}

async function loadNotes() {
  const [white, black] = await Promise.all(
    (["white", "black"] as Color[]).map((color) => invoke<Record<string, string>>("rep_notes", { color }).catch(() => ({}))),
  );
  notes = { white, black };
}

async function loadRepProgress() {
  let profile: { todayAttempts: number } | null;
  [repProgress, seriousOnly, profile] = await Promise.all([
    invoke<typeof repProgress>("rep_progress", { accounts: deps.accounts() }).catch(() => null),
    invoke<boolean>("rep_serious_get").catch(() => true),
    invoke<{ todayAttempts: number }>("puzzle_profile", { accounts: deps.accounts() }).catch(() => null),
  ]);
  puzzlesToday = profile?.todayAttempts ?? 0;
}

async function loadTheory() {
  theory = await invoke<TheoryReport>("theory_report", { accounts: deps.accounts(), last: windowLast() }).catch(() => null);
}

async function loadOwnCount() {
  try {
    ownCount = await invoke<number>("opening_own_count", { accounts: deps.accounts(), last: windowLast() });
    ownLoaded = true;
  } catch {
    ownCount = 0;
  }
}

async function loadPlayed() {
  try {
    const report = await invoke<OpeningStat[]>("opening_report", { accounts: deps.accounts(), last: null });
    played = {};
    for (const r of report) {
      played[r.family] ??= { white: 0, black: 0 };
      played[r.family][r.color] = r.games;
    }
  } catch {
    played = {};
  }
  if (view === "browse") renderList();
}

async function loadVariations() {
  if (!focus) {
    variations = [];
    rareLines = [];
    detailRatings = "";
    return;
  }
  const d = await invoke<FamilyDetail>("opening_family_detail", { color: focus.color, family: focus.family });
  variations = d.groups;
  rareLines = d.rare;
  detailRatings = d.ratings;
}

/**
 * Which lines of an opening come up at your level: fetched from Lichess once
 * per session and opening (answers are stored, so later it's quick). Null if
 * it failed altogether – then the course simply has every line.
 */
function prepareRelevance(color: Color, family: string): Promise<Prepared | null> {
  const key = `${color}|${family}`;
  const done = prepared.get(key);
  if (done) return Promise.resolve(done);
  const running = preparing.get(key);
  if (running) return running;
  const p = prepareQueue.then(async () => {
    try {
      const r = await invoke<Prepared>("opening_relevance_prepare", { accounts: deps.accounts(), color, family });
      prepared.set(key, r);
      removedRare += r.removed;
      return r;
    } catch (e) {
      console.error(e);
      return null;
    } finally {
      preparing.delete(key);
      if (fetching?.key === key) fetching = null;
    }
  });
  preparing.set(key, p);
  prepareQueue = p;
  return p;
}

/** Add a family to the repertoire (also used by "Üben" in the statistics). */
export async function addToRepertoire(color: Color, family: string) {
  const rep = await invoke<Repertoire>("repertoire_get");
  if (!rep[color].includes(family)) rep[color].push(family);
  status = await invoke<Status>("repertoire_set", { repertoire: rep });
  repertoire = rep;
}

async function removeFromRepertoire(color: Color, family: string) {
  repertoire[color] = repertoire[color].filter((f) => f !== family);
  status = await invoke<Status>("repertoire_set", { repertoire });
  if (focus && focus.color === color && focus.family === family) setFocus(null);
}

/** Learn one opening (optionally one variation or line), or null for the mix. */
async function setFocus(f: Focus | null) {
  focus = f;
  consolidate = null;
  if (f) {
    // The theory moves right away: which lines are common at your level is
    // fetched only on request (opening page) – until then the course has them all.
    await addToRepertoire(f.color, f.family);
  }
  await Promise.all([loadVariations(), loadProgress()]);
  renderSidebar();
  loadNext();
}

/** Start the board in one of the three modes. */
async function startTrain(m: TrainMode, f: Focus | null) {
  trainMode = m;
  focus = f;
  setView("train");
  if (m === "explore") {
    startExplorer({
      board: deps.board,
      accounts: deps.accounts,
      animMs: deps.animMs,
      openGame: deps.openGame,
      showTheory: (fen) => showTheory(fen),
    });
    return;
  }
  if (m === "due" && f) {
    // The flashcards of one opening: no course to prepare.
    consolidate = null;
    renderSidebar();
    loadNext();
    return;
  }
  await setFocus(f);
}

/** Start learning from the opening list. Also used by "Üben" in the statistics. */
export async function startFocus(color: Color, family: string) {
  await startTrain("learn", { color, family });
}

/**
 * Learn the whole opening line behind a moment of one of your games (a
 * mistake, leaving theory) – not just the position. Falls back to the
 * opening `family` if no line leads there.
 */
export async function learnLineForGame(gameId: string, ply: number, color: Color, family?: string | null) {
  const f = await invoke<Focus | null>("opening_line_for_game", { gameId, ply, color }).catch(() => null);
  if (f) return startTrain("learn", f);
  if (family) return startTrain("learn", { color, family });
  alert(t("Zu dieser Stellung gibt es keine bekannte Eröffnungslinie."));
}

// ---------------------------------------------------------------------------
// home: what do you want to do?

const ICON = {
  learn: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 2h13v-4"/><path d="M9 8h6M9 11h4"/></svg>`,
  due: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="7" width="14" height="13" rx="2"/><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-2"/><path d="M7 13l2 2 4-4"/></svg>`,
  own: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>`,
  tree: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="4.5" r="2"/><circle cx="5" cy="19.5" r="2"/><circle cx="12" cy="19.5" r="2"/><circle cx="19" cy="19.5" r="2"/><path d="M12 6.5V17.5M12 11c-4 0-7 2-7 6.5M12 11c4 0 7 2 7 6.5"/></svg>`,
  explore: `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
};

function renderHome() {
  if (!active || view !== "home") return;
  const due = (status?.white.due ?? 0) + (status?.black.due ?? 0) + (status?.cardsDue ?? 0);
  const nexts = [status?.white.nextDue, status?.black.nextDue, status?.cardsNextDue].filter((x): x is number => !!x);
  const nextDue = nexts.length ? Math.min(...nexts) : null;
  const dueText = due
    ? `<b>${tn(due, "1 Karte fällig", "{n} Karten fällig")}</b>`
    : nextDue
      ? t("Nächste Karte {when}", { when: relDays(nextDue) })
      : t("Noch leer");
  const ownText = ownCount ? `<b>${tn(ownCount, "1 Stellung offen", "{n} Stellungen offen")}</b>` : t("Gerade nichts offen");
  const learnText = t("Eröffnung aussuchen");
  const tile = (go: string, icon: string, title: string, text: string, tip: string, opts: { hot?: boolean; off?: boolean } = {}) =>
    `<button class="op-tile ${opts.hot ? "hot" : ""}" data-go="${go}" title="${esc(tip)}" ${opts.off ? "disabled" : ""}>
      <span class="op-tile-icon">${icon}</span><b>${title}</b><span class="op-tile-text">${text}</span></button>`;

  const mine = myOpenings();

  $("op-home").innerHTML = `
    <div class="op-home-head">
      <h2>${t("Lernen")}</h2>
    </div>
    ${planHtml()}
    <div class="op-tiles">
      ${tile("due", ICON.due, t("Karteikasten"), dueText, t("Die Karten wiederholen, die heute dran sind."), { hot: !!due, off: !due })}
      ${tile("own", ICON.own, t("Fehler aus deinen Partien"), ownText, t("Stellungen aus deinen Partien, in denen du in der Eröffnung danebengegriffen hast."), { off: !ownCount })}
      ${tile("learn", ICON.learn, t("Eröffnung"), learnText, t("Eine Eröffnung und Farbe aussuchen – dann lernst du sie Zug für Zug, mit Erklärung zu jedem Zug."))}
      ${tile("explore", ICON.explore, t("Erkunden"), t("Züge ausprobieren"), t("Welche Züge sind hier gut, welche spielst du? Zug für Zug durchprobieren – mit Stockfish, deinen Partien und der Theorie."))}
      ${tile("tree", ICON.tree, t("Mein Repertoire"), t("Baum, Lücken, eigene Züge"), t("Für Fortgeschrittene: dein ganzes Repertoire als Baum – Lücken füllen, Züge ändern, Stockfish prüft deine Züge."))}
    </div>
    ${
      removedRare
        ? `<p class="op-home-note">${tn(
            removedRare,
            "1 seltene Nebenvariante, die du nur kurz angeschaut hattest, ist aus dem Karteikasten genommen. Du findest sie beim Lernen unter „Seltene Abweichungen“.",
            "{n} seltene Nebenvarianten, die du nur kurz angeschaut hattest, sind aus dem Karteikasten genommen. Du findest sie beim Lernen unter „Seltene Abweichungen“.",
          )}</p>`
        : ""
    }
    ${
      freshDeviations
        ? `<p class="op-home-note">${tn(
            freshDeviations,
            "In einer neuen Partie hast du anders gespielt als in deinem Repertoire – diese Karte ist wieder fällig.",
            "In {n} neuen Partien hast du anders gespielt als in deinem Repertoire – diese Karten sind wieder fällig.",
          )}</p>`
        : ""
    }
    <div class="op-home-mine">
      <h3>${t("Deine Eröffnungen")}</h3>
      ${
        mine.length
          ? `<p class="panel-sub">${t("Was du lernst und was du spielst (ab 3 Partien). Oben steht, wo sich Lernen am meisten lohnt. Ein Klick öffnet die Eröffnung zum Lernen.")}</p>
             <div class="op-mine-list">${mine.map(openingRow).join("")}</div>`
          : `<p class="muted">${t("Noch keine. Wähl oben „Eröffnung“.")}</p>`
      }
    </div>
    ${gamesBlockHtml()}
    <div class="op-home-mine op-home-cards">
      <button class="op-cards-toggle" ${cards.length ? "" : "disabled"}>${cards.length ? (cardsOpen ? "▾" : "▸") : ""} ${t("Deine Karten ({n})", { n: cards.length })}</button>
      ${
        cards.length && !cardsOpen
          ? ""
          : cards.length
          ? `<p class="panel-sub">${t("Stellungen, die du mit „In den Karteikasten“ gesammelt hast – aus Reviews, „Erkunden“ und Partien gegen Stockfish. Sie kommen im Karteikasten dran.")}</p>
             <div class="op-mine-list">${cards
               .map(
                 (c) => `<div class="op-mine-row op-card-row" data-card="${esc(c.id)}" role="button" tabindex="0" title="${t("Diese Karte jetzt üben")}">
                   <span class="mini-board cg-wrap card-thumb" data-fen="${esc(c.fen)}">${miniPieces(c.fen, c.color === "black")}</span>
                   <span class="op-mine-name">${cardOrigin(c)}<br><span class="muted">${t("Beste Züge:")} ${c.best.map((b) => esc(fig(b.san))).join(", ")}</span></span>
                   ${pips(c.boxLevel)}
                   <span class="op-progress-text">${c.boxLevel === 0 ? t("neu") : c.due ? `<b>${t("fällig")}</b>` : t("wieder {when}", { when: relDays(c.dueAt) })}</span>
                   <button class="op-card-go" data-card="${esc(c.id)}">${t("Üben")}</button>
                   <button class="op-card-del" data-id="${esc(c.id)}" title="${t("Karte löschen")}">✕</button>
                 </div>`,
               )
               .join("")}</div>`
          : `<p class="muted">${t("Noch keine. In der Review, in „Erkunden“ und beim Spielen gegen Stockfish gibt es den Knopf „In den Karteikasten“.")}</p>`
      }
    </div>`;
  const home = $("op-home");
  const theoryEl = document.getElementById("op-theory-exits");
  if (theoryEl) {
    bindTheoryList(theoryEl, { openGame: deps.openGame, learnLine: (g, ply, color, family) => learnLineForGame(g, ply, color, family) });
    theoryEl.querySelector(".op-theory-more")?.addEventListener("click", () => {
      theoryAll = !theoryAll;
      renderHome();
    });
    if (scrollToTheory && theory) {
      scrollToTheory = false;
      theoryEl.scrollIntoView({ block: "start" });
    }
  }
  bindReports(home, reports, renderHome);
  bindPlan(home);
  ($("op-serious") as HTMLInputElement | null)?.addEventListener("change", async (e) => {
    seriousOnly = (e.target as HTMLInputElement).checked;
    await invoke("rep_serious_set", { on: seriousOnly }).catch(console.error);
    await Promise.all([loadReports(), loadRepProgress(), loadSummaries()]);
    renderHome();
  });
  home.querySelector(".op-games-toggle")?.addEventListener("click", () => {
    gamesOpen = !gamesOpen;
    renderHome();
  });
  home.querySelector(".op-cards-toggle")?.addEventListener("click", () => {
    cardsOpen = !cardsOpen;
    renderHome();
  });
  home.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) =>
    b.addEventListener("click", () => {
      const go = b.dataset.go;
      if (go === "learn") setView("browse");
      else if (go === "tree") openTree("white", null);
      else startTrain(go as TrainMode, null);
    }),
  );
  home.querySelectorAll<HTMLElement>(".op-mine-row[data-family]").forEach((row) => {
    const go = () => openPage(row.dataset.color as Color, row.dataset.family!);
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => e.key === "Enter" && go());
  });
  home.querySelectorAll<HTMLElement>(".op-card-row").forEach((row) => {
    const go = (e: Event) => {
      if ((e.target as HTMLElement).closest(".op-card-del")) return;
      const c = cards.find((x) => x.id === row.dataset.card);
      if (c) practiseCard(c);
    };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => e.key === "Enter" && go(e));
  });
  home.querySelectorAll<HTMLElement>(".op-card-del").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await invoke("card_delete", { id: b.dataset.id });
      await Promise.all([loadCards(), loadRepertoire()]);
      renderHome();
    }),
  );
}

/** Start an opening over after asking; true if it was reset. */
async function resetOpening(color: Color, family: string): Promise<boolean> {
  const moves = await invoke<Changed>("rep_delete_family", { color, family, dry: true }).then((c) => c.count).catch(() => 0);
  const ok = confirm(
    `${t("{family} als {side} zurücksetzen? Der Kurs fängt wieder bei „neu“ an – die Eröffnung bleibt in deiner Liste.", {
      family: openingName(family),
      side: SIDE[color],
    })}${moves ? ` ${tn(moves, "Dazu kommt 1 Zug aus deinem Repertoire (mit Karte).", "Dazu kommen {n} Züge aus deinem Repertoire (mit Karten).")}` : ""}`,
  );
  if (!ok) return false;
  if (moves) await invoke("rep_delete_family", { color, family, dry: false });
  status = await invoke<Status>("opening_reset", { color, family });
  await loadProgress();
  return true;
}

/** Practise one of your cards right now (afterwards "Weiter" continues with what's due). */
function practiseCard(c: CardInfo) {
  trainMode = "due";
  focus = null;
  consolidate = null;
  setView("train");
  const tk = ++token;
  startDrill(
    { kind: "card", id: `card:${c.id}`, color: c.color, name: "", eco: "", fen: c.fen, moves: [c.best[0].uci], status: "due", own: null, bookLen: 1, card: c },
    tk,
  );
}

/** Top of the board column: way back to the choice, and what you're doing. */
function renderTop() {
  const title =
    trainMode === "explore"
      ? t("Erkunden")
      : trainMode === "tree"
      ? treeFamily
        ? t("Mein Repertoire: {family} als {side}", { family: esc(openingName(treeFamily)), side: SIDE[treeColor] })
        : t("Mein Repertoire als {side}", { side: SIDE[treeColor] })
      : trainMode === "spar"
      ? treeFamily
        ? t("Sparring: {family} als {side}", { family: esc(openingName(treeFamily)), side: SIDE[treeColor] })
        : t("Sparring als {side}", { side: SIDE[treeColor] })
      : trainMode === "due"
      ? focus
        ? t("Karteikasten: {family} als {side}", { family: esc(openingName(focus.family)), side: SIDE[focus.color] })
        : t("Karteikasten")
      : trainMode === "own"
        ? t("Fehler aus deinen Partien")
        : focus
          ? t("Lernen: {family} als {side}", { family: esc(openingName(focus.family)), side: SIDE[focus.color] })
          : t("Lernen");
  const back = fromPage && page ? openingName(page.family) : t("Übersicht");
  $("op-top").innerHTML = `<button id="op-home-btn">← ${esc(back)}</button><span class="op-top-title">${title}</span>`;
  $("op-home-btn").addEventListener("click", () => setView(fromPage && page ? "opening" : "home"));
}

// ---------------------------------------------------------------------------
// opening list (full width, board thumbnails)

/** Fill thumbnails only when they scroll into view (149 boards stay light). */
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target as HTMLElement;
      el.innerHTML = miniPieces(el.dataset.fen!);
      thumbObserver.unobserve(el);
    }
  },
  { rootMargin: "200px" },
);

/** Two-tone bar: learned (green) and in progress (light green) out of `total`. */
function progressBar(total: number, started: number, learned: number): string {
  if (!total) return "";
  return `<span class="learn-bar" title="${t("{l} sitzen, {s} im Lernen, {n} neu", { l: learned, s: started - learned, n: total - started })}">
    <span class="lb-learned" style="width:${(learned / total) * 100}%"></span><span class="lb-started" style="width:${((started - learned) / total) * 100}%"></span></span>`;
}

/** Learning progress in words, like a flashcard box: "1 sitzt · 2 im Lernen · 5 neu · 1 fällig". */
function cardSummary(total: number, started: number, learned: number, due: number): string {
  const parts: string[] = [];
  if (learned) parts.push(tn(learned, "{n} sitzt", "{n} sitzen"));
  if (started - learned) parts.push(t("{n} im Lernen", { n: started - learned }));
  if (total - started) parts.push(t("{n} neu", { n: total - started }));
  if (due) parts.push(`<b>${t("{n} fällig", { n: due })}</b>`);
  return parts.join(" · ");
}

/** The five compartments of the flashcard box, filled up to the card's one. */
function pips(box: number): string {
  const cls = box >= 3 ? "sure" : "work";
  return `<span class="pips ${cls}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= box ? "on" : ""}"></i>`).join("")}</span>`;
}

/** One line's state: "neu", "Fach 2 · wieder morgen", "fällig", "sitzt ✓ · wieder in 7 Tagen". */
function lineState(l: LineInfo): string {
  if (l.boxLevel === 0) return t("neu");
  if (l.due) return `<b>${t("fällig")}</b>`;
  const again = t("wieder {when}", { when: relDays(l.dueAt) });
  return l.boxLevel >= 3 ? `${t("sitzt ✓")} · ${again}` : again;
}

const BOX_HELP = () =>
  t("Wie Karteikarten: Jeder Zug deines Repertoires ist eine Karte. Spielst du ihn richtig, rutscht die Karte ein Fach weiter und kommt später wieder (10 Min. → 1 Tag → 3 → 7 → 21 Tage). Ein Fehler schickt sie zurück in Fach 1. Ab Fach 3 sitzt sie.");

function renderList() {
  if (view !== "browse") return;
  const grid = $("op-grid");
  const q = ($("op-search") as HTMLInputElement).value.trim().toLowerCase();
  const mine = (f: Family) => (played[f.name]?.white ?? 0) + (played[f.name]?.black ?? 0);
  const learningCount = (f: Family) => (progress[`white|${f.name}`]?.started ?? 0) + (progress[`black|${f.name}`]?.started ?? 0);
  let items = families.filter((f) => !q || f.name.toLowerCase().includes(q) || openingName(f.name).toLowerCase().includes(q) || f.eco.toLowerCase() === q);
  if (sort === "az") items = [...items].sort((a, b) => openingName(a.name).localeCompare(openingName(b.name)));
  if (sort === "popular") items = [...items].sort((a, b) => b.lines - a.lines);
  if (sort === "mine") items = items.filter((f) => mine(f) > 0).sort((a, b) => mine(b) - mine(a));
  if (sort === "learning") {
    items = items.filter((f) => progress[`white|${f.name}`] || progress[`black|${f.name}`]).sort((a, b) => learningCount(b) - learningCount(a));
  }
  if (!items.length) {
    const empty: Record<Sort, string> = {
      popular: t("Nichts gefunden."),
      az: t("Nichts gefunden."),
      mine: t("Noch keine analysierten Partien mit erkannter Eröffnung."),
      learning: t("Du lernst noch keine Eröffnung – such dir eine aus und klick auf „lernen“."),
    };
    grid.innerHTML = `<p class="muted">${empty[sort]}</p>`;
    return;
  }
  grid.innerHTML = items
    .map((f) => {
      const p = played[f.name];
      const mineText =
        p && (p.white || p.black)
          ? `<div class="op-mine">${t("Deine Partien:")} ${[p.white ? t("{n}× Weiß", { n: p.white }) : "", p.black ? t("{n}× Schwarz", { n: p.black }) : ""].filter(Boolean).join(", ")}</div>`
          : "";
      const side = (color: Color) => {
        const pr = progress[`${color}|${f.name}`];
        const started = !!pr && pr.started > 0;
        const inRep = repertoire[color].includes(f.name);
        return `<div class="op-side-row">
          <button class="op-learn ${started ? "primary" : ""}" data-color="${color}" data-family="${esc(f.name)}">
            <span class="pdot ${color}"></span>${started ? t("Weiterlernen als {side}", { side: SIDE[color] }) : t("Lernen als {side}", { side: SIDE[color] })}</button>
          ${pr ? `${progressBar(pr.lines, pr.started, pr.learned)}<span class="op-progress-text" title="${esc(BOX_HELP())}">${cardSummary(pr.lines, pr.started, pr.learned, pr.due)}</span>` : ""}
          ${inRep ? `<button class="op-remove" data-color="${color}" data-family="${esc(f.name)}" title="${t("Aus dem Repertoire nehmen (Lernstand bleibt)")}">✕</button>` : ""}
        </div>`;
      };
      return `<div class="op-card">
        <div class="mini-board cg-wrap big" data-fen="${esc(f.fen)}"></div>
        <div class="op-card-body">
          <div class="op-title" title="${esc(openingName(f.name))}">${esc(openingName(f.name))}</div>
          <div class="op-moves">${esc(fig(f.moves))}</div>
          <div class="muted op-meta">${esc(f.eco)} · ${tn(f.lines, "1 Linie", "{n} Linien")}</div>
          ${mineText}
          <div class="op-card-actions">${side("white")}${side("black")}</div>
        </div>
      </div>`;
    })
    .join("");
  grid.querySelectorAll<HTMLElement>(".mini-board").forEach((el) => thumbObserver.observe(el));
  grid.querySelectorAll<HTMLElement>(".op-learn").forEach((b) =>
    b.addEventListener("click", () => openPage(b.dataset.color as Color, b.dataset.family!)),
  );
  grid.querySelectorAll<HTMLElement>(".op-remove").forEach((b) =>
    b.addEventListener("click", async () => {
      await removeFromRepertoire(b.dataset.color as Color, b.dataset.family!);
      await loadProgress();
      renderList();
    }),
  );
}

// ---------------------------------------------------------------------------
// training sidebar: focus + variations, or the mix + a short repertoire summary

function renderSidebar() {
  if (!active || view !== "train") return;
  if (trainMode === "explore" || trainMode === "tree" || trainMode === "spar") {
    $("op-focus").hidden = true;
    $("op-variations").hidden = true;
    return;
  }
  const focusEl = $("op-focus");
  const varsEl = $("op-variations");
  // The course's sidebar – not for the flashcards of one opening.
  const course = !!focus && trainMode !== "due";
  focusEl.hidden = !course;
  varsEl.hidden = !course;
  if (!course || !focus) return;

  const p = progress[`${focus.color}|${focus.family}`];
  const sub = focus.line
    ? [...variations.flatMap((g) => g.lines), ...rareLines].find((l) => l.id === focus!.line)?.name
    : focus.variation;
  focusEl.innerHTML = `
    <div class="op-focus-top">
      <span class="pdot ${focus.color}"></span>
      <div class="op-focus-title"><b>${esc(openingName(focus.family))}</b> <span class="muted">${t("als {side}", { side: SIDE[focus.color] })}</span>
        ${sub ? `<div class="op-focus-sub">${t("nur:")} ${esc(varName(sub))} <button id="op-focus-all" class="link">${t("alle Varianten")}</button></div>` : ""}</div>
    </div>
    ${p ? `<div class="op-focus-progress">${progressBar(p.lines, p.started, p.learned)}<span class="muted">${cardSummary(p.lines, p.started, p.learned, p.due)}</span></div>` : ""}
    ${courseInfo()}
    <p class="panel-sub op-box-help">${BOX_HELP()}</p>
    ${p?.started ? `<button id="op-focus-reset" class="link">${t("Lernstand zurücksetzen")}</button>` : ""}`;
  document.getElementById("op-focus-reset")?.addEventListener("click", async () => {
    if (!focus || !(await resetOpening(focus.color, focus.family))) return;
    consolidate = null;
    await setFocus({ color: focus.color, family: focus.family });
  });
  document.getElementById("op-focus-all")?.addEventListener("click", () => setFocus({ color: focus!.color, family: focus!.family }));

  const current = drill?.kind === "line" ? drill.id : null;
  varsEl.innerHTML = `<h3>${t("Varianten")}</h3><p class="panel-sub">${t("Klick auf eine Variante, um nur sie zu lernen. Die Kästchen zeigen das Fach im Karteikasten: grün = sitzt, gestreift = im Lernen.")}</p>
    ${variations
      .map((g) => {
        const open = expanded.has(g.name);
        const selected = focus!.variation === g.name && !focus!.line;
        return `<div class="var-group ${selected ? "selected" : ""}">
          <div class="var-row">
            <button class="var-toggle" data-group="${esc(g.name)}" title="${open ? t("Zuklappen") : t("Linien zeigen")}">${open ? "▾" : "▸"}</button>
            <button class="var-name" data-group="${esc(g.name)}" title="${t("Nur diese Variante lernen")}">${esc(varName(g.name))}</button>
            ${progressBar(g.total, g.started, g.learned)}
            <span class="var-count">${groupState(g)}</span>
          </div>
          ${
            open
              ? `<div class="var-lines">${g.lines
                  .map((l) => {
                    const where = l.boxLevel ? t("Fach {n} von 5", { n: l.boxLevel }) : t("noch nicht gelernt");
                    return lineButton(l, current, `${t("Nur diese Linie lernen")} · ${where} · ${t("{n} Züge", { n: Math.ceil(l.plies / 2) })}`, lineState(l));
                  })
                  .join("")}</div>`
              : ""
          }
        </div>`;
      })
      .join("")}
    ${
      rareLines.length
        ? `<div class="var-rare">
            <button class="var-rare-toggle">${rareOpen ? "▾" : "▸"} ${t("Seltene Abweichungen ({n})", { n: rareLines.length })}</button>
            ${
              rareOpen
                ? `<p class="panel-sub">${t("Kommen auf deinem Niveau in weniger als 3 von 100 Partien vor und gehören deshalb nicht zum Kurs. Klick auf eine, um sie trotzdem zu lernen.")}</p>
                   <div class="var-lines">${rareLines
                     .map((l) => lineButton(l, current, `${t("Diese seltene Linie trotzdem lernen")} · ${t("{n} Züge", { n: Math.ceil(l.plies / 2) })}`, l.reach != null ? pct(l.reach) : ""))
                     .join("")}</div>`
                : ""
            }
          </div>`
        : ""
    }`;
  varsEl.querySelector(".var-rare-toggle")?.addEventListener("click", () => {
    rareOpen = !rareOpen;
    renderSidebar();
  });
  varsEl.querySelectorAll<HTMLElement>(".var-toggle").forEach((b) =>
    b.addEventListener("click", () => {
      const g = b.dataset.group!;
      if (expanded.has(g)) expanded.delete(g);
      else expanded.add(g);
      renderSidebar();
    }),
  );
  varsEl.querySelectorAll<HTMLElement>(".var-name").forEach((b) =>
    b.addEventListener("click", () => {
      expanded.add(b.dataset.group!);
      setFocus({ color: focus!.color, family: focus!.family, variation: b.dataset.group! });
    }),
  );
  varsEl.querySelectorAll<HTMLElement>(".var-line").forEach((b) =>
    b.addEventListener("click", () => setFocus({ color: focus!.color, family: focus!.family, line: b.dataset.line! })),
  );
}

// ---------------------------------------------------------------------------
// your repertoire as a tree

/** Open the tree of an opening (or of the whole repertoire for a colour). */
export async function openTree(color: Color, family: string | null, select: string | null = null, home: string | null = family) {
  trainMode = "tree";
  focus = null;
  treeColor = color;
  treeFamily = family;
  treeHome = home;
  tree = null;
  treeSel = null;
  treeWant = select;
  treeEditing = false;
  treeOpen.clear();
  setView("train");
  await loadTree(true);
}

/** The tree with the numbers at hand, then (with `fetch`) after getting the missing ones. */
async function loadTree(fetch: boolean) {
  const tk = ++treeToken;
  const args = { accounts: deps.accounts(), color: treeColor, family: treeFamily };
  try {
    const v = await invoke<TreeView>("rep_tree", args);
    if (tk !== treeToken) return;
    setTree(v);
  } catch (e) {
    console.error(e);
  }
  if (!fetch) return;
  treeFetching = true;
  renderTreePanel();
  try {
    const v = await invoke<TreeView>("rep_tree_prepare", args);
    if (tk === treeToken) setTree(v);
  } catch (e) {
    console.error(e);
  } finally {
    if (tk === treeToken) {
      treeFetching = false;
      renderTreePanel();
    }
  }
  if (tk === treeToken && trainMode === "tree") checkQuality(treeColor, treeFamily, tk);
  // The wanted position isn't in this opening's part: show the whole repertoire.
  if (tk === treeToken && treeWant && treeFamily) {
    treeFamily = null;
    tree = null;
    treeOpen.clear();
    renderTop();
    await loadTree(true);
  }
}

function setTree(v: TreeView) {
  tree = v;
  if (treeWant && v.nodes.some((n) => n.id === treeWant)) {
    treeSel = treeWant;
    treeWant = null;
  }
  if (!treeSel || !v.nodes.some((n) => n.id === treeSel)) treeSel = v.nodes[0]?.id ?? null;
  if (!treeOpen.size) v.nodes.filter((n) => n.depth === 0).forEach((n) => treeOpen.add(n.id));
  openPathTo(treeSel);
  renderTree();
}

/** Where your games leave theory and go wrong (from "Deine Eröffnungen"), by position. */
function treeExits(): Map<string, CostlyExit> {
  const out = new Map<string, CostlyExit>();
  for (const r of insights) if (r.color === treeColor && r.exit) out.set(r.exit.epd, r.exit);
  return out;
}

const treeNode = (id: string | null) => (id ? (tree?.nodes.find((n) => n.id === id) ?? null) : null);

/** Unfold everything above a node (so it's visible). */
function openPathTo(id: string | null) {
  for (let n = treeNode(id); n?.parent; n = treeNode(n.parent)) treeOpen.add(n.parent);
}

function selectNode(id: string) {
  treeSel = id;
  treeEditing = false;
  treeAltsOpen = false;
  openPathTo(id);
  renderTree();
}

function renderTree() {
  if (!active || view !== "train" || trainMode !== "tree") return;
  renderTreePanel();
  renderTreeDetail();
  renderTreeBoard();
}

/** The moves that lead to a node: "1…c6 2. d4 d5 3. e5". */
function treePath(n: TreeNode): string {
  const chain: TreeNode[] = [];
  for (let x: TreeNode | null = n; x; x = treeNode(x.parent)) chain.unshift(x);
  return chain
    .flatMap((x) => (x === n ? [x.opp] : [x.opp, x.mine]))
    .filter((m): m is string => !!m)
    .map((m) => fig(m))
    .join(" ");
}

function renderTreePanel() {
  if (!active || view !== "train" || trainMode !== "tree") return;
  const el = $("op-tree");
  if (!tree) {
    el.innerHTML = `<p class="muted">${t("Lade dein Repertoire …")}</p>`;
    return;
  }
  const v = tree;
  const cov = v.coverage;
  const f = fetching?.key === `${treeColor}|repertoire` ? fetching : null;
  const lichessStatus = treeFetching
    ? f?.waiting
      ? t("Lichess bittet um eine kurze Pause – in einer Minute geht es weiter …")
      : `${t("Hole bei Lichess, was auf deinem Niveau gespielt wird …")}${f ? ` ${tn(f.done, "1 Stellung geholt", "{n} Stellungen geholt")}` : ""}`
    : v.error
      ? `${esc(v.error)}${
          v.ratings ? "" : ` <button class="link" id="tree-token">${t("Lichess-Schlüssel eintragen")}</button><br>${t("Ohne ihn siehst du deine Züge und die Lücken aus deinen Partien, aber keine Abdeckung.")}`
        }`
      : "";
  const byId = new Map(v.nodes.map((n) => [n.id, n]));
  const visible = (n: TreeNode) => {
    for (let p = n.parent ? byId.get(n.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) if (!treeOpen.has(p.id)) return false;
    return true;
  };
  const exits = treeExits();
  const rows = v.nodes
    .filter(visible)
    .map((n) => {
      const open = treeOpen.has(n.id);
      const exit = exits.get(n.id);
      const reach =
        n.reach != null
          ? `<span class="tree-bar"><i class="${n.gap ? "gap" : ""}" style="width:${Math.min(100, n.reach * 100)}%"></i></span><span class="tree-pct">${pct(n.reach)}</span>`
          : `<span class="tree-pct muted">–</span>`;
      const state = n.gap
        ? `<span class="tree-state gap">${n.games ? tn(n.games, "1× in deinen Partien", "{n}× in deinen Partien") : ""}</span>`
        : `${pips(n.boxLevel)}<span class="tree-state ${n.due ? "due" : n.isNew ? "new" : ""}">${n.isNew ? t("neu") : n.due ? t("fällig") : n.boxLevel >= 3 ? t("sitzt") : t("im Lernen")}</span>`;
      return `<div class="tree-row ${n.id === treeSel ? "selected" : ""} ${n.verdict?.weak ? "weak" : ""}" style="padding-left:${n.depth * 14}px">
        ${n.hasChildren ? `<button class="tree-caret" data-toggle="${esc(n.id)}" aria-label="${open ? t("Zuklappen") : t("Aufklappen")}">${open ? "▾" : "▸"}</button>` : `<span class="tree-caret"></span>`}
        <button class="tree-move" data-sel="${esc(n.id)}">${n.opp ? `<span class="tree-opp">${esc(fig(n.opp))}</span>` : ""}${
          n.gap ? `<span class="tree-gap">+ ${t("Lücke")}</span>` : `<b>${esc(fig(n.mine ?? ""))}</b>`
 }${
          n.verdict?.weak
            ? `<span class="tree-weak" style="--c:${CLASSES[n.verdict.class].color}" title="${t("Stockfish hält diesen Zug für schwach")}">${CLASSES[n.verdict.class].symbol} ${CLASSES[n.verdict.class].label}</span>`
            : ""
        }${
          !n.gap && n.strays.length
            ? `<span class="tree-stray" title="${t("So oft hast du hier in deinen Partien etwas anderes gespielt")}">≠ ${n.strays.reduce((a, x) => a + x.times, 0)}×</span>`
            : ""
        }${exit ? `<span class="tree-exit" title="${t("Hier weichst du in deinen Partien ab und machst kurz danach einen Fehler")}">⚠ ${exit.times}×</span>` : ""}</button>
        <span class="tree-reach">${reach}</span>
        <span class="tree-card">${state}</span>
      </div>`;
    })
    .join("");
  const other = treeFamily
    ? `<button class="link" id="tree-scope">${t("Ganzes Repertoire als {side}", { side: SIDE[treeColor] })}</button>`
    : treeHome
      ? `<button class="link" id="tree-scope">${t("Nur {family}", { family: esc(openingName(treeHome)) })}</button>`
      : `<span class="segmented tree-colors">${(["white", "black"] as Color[])
          .map((c) => `<button data-tree-color="${c}" class="${c === treeColor ? "active" : ""}">${SIDE[c]}</button>`)
          .join("")}</span>`;
  const q = quality?.color === treeColor ? quality : null;
  // One quiet status line for what's going on in the background.
  const statusText = [lichessStatus, q ? t("Stockfish prüft deine Züge … {done} von {total}", { done: q.done, total: q.total }) : ""].filter(Boolean).join(" · ");
  const status = statusText ? `<p class="tree-status muted">${statusText}</p>` : "";
  const chip = (n: number, one: string, many: string, cls = "") => `<span class="tree-chip ${n ? cls : "zero"}">${tn(n, one, many)}</span>`;
  el.innerHTML = `
    <div class="tree-head">
      <div class="tree-cov-row"><span>${t("Abdeckung auf deinem Niveau")}</span><b>${cov != null ? pct(cov) : "–"}</b></div>
      <div class="tree-cov"><i style="width:${(cov ?? 0) * 100}%"></i></div>
      <div class="tree-chips">
        ${chip(v.gaps, "1 Lücke", "{n} Lücken", "gap")}
        ${chip(v.weak, "1 schwacher Zug", "{n} schwache Züge", "weak")}
        ${chip(v.due, "1 Karte fällig", "{n} Karten fällig", "due")}
        <span class="tree-chip">${tn(v.cards, "1 Karte", "{n} Karten")}</span>
      </div>
      <div class="tree-actions">
        ${v.gaps ? `<button class="primary" id="tree-next-gap">${t("Nächste Lücke")} →</button>` : `<span class="tree-ok">${t("Keine Lücken über 3 % ✓")}</span>`}
        ${v.weak ? `<button id="tree-next-weak" class="tree-weak-btn">${t("Schwacher Zug")} →</button>` : ""}
        ${v.cards ? `<button id="tree-spar" title="${t("Der Gegner spielt nach Häufigkeit durch deinen Baum, du antwortest mit deinen Zügen")}">${t("Sparring")} ▶</button>` : ""}
        ${treeHome ? `<button id="tree-course" title="${t("Die Eröffnung Zug für Zug mit Erklärungen lernen – was du lernst, kommt in dein Repertoire")}">${t("Mit dem Kurs lernen")}</button>` : ""}
      </div>
      <div class="tree-settings muted">
        <label class="tree-depth" title="${t("Lücken und Abdeckung zählen bis zu diesem Zug. Deine eigenen Züge danach bleiben im Baum.")}">${t("Bis Zug")}
          <select id="tree-depth">${DEPTHS.map((d) => `<option value="${d}" ${d === v.depth ? "selected" : ""}>${d ? d : t("alle")}</option>`).join("")}</select></label>
        ${other}
        ${v.ratings ? `<span>Lichess ${esc(v.ratings)}</span>` : ""}
      </div>
      ${status}
    </div>
    <div class="tree-rows">${rows || `<p class="muted">${t("Noch nichts in deinem Repertoire.")}</p>`}</div>
    <p class="panel-sub tree-legend">${t("Fett: dein Zug, einer pro Stellung. Davor der Zug des Gegners und wie oft er auf deinem Niveau kommt (Lichess). Kästchen: Fach im Karteikasten – eine Karte pro Zug.")}</p>
    ${
      treeHome
        ? `<div class="tree-foot">${
            progress[`${treeColor}|${treeHome}`]?.started || v.cards
              ? `<button class="link" id="tree-reset">${t("Eröffnung zurücksetzen")}</button>`
              : ""
          }${repertoire[treeColor].includes(treeHome) ? `<button class="link" id="tree-remove">${t("Aus „Deine Eröffnungen“ nehmen")}</button>` : ""}</div>`
        : ""
    }`;
  el.querySelectorAll<HTMLElement>("[data-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.toggle!;
      if (treeOpen.has(id)) treeOpen.delete(id);
      else treeOpen.add(id);
      renderTreePanel();
    }),
  );
  el.querySelectorAll<HTMLElement>("[data-sel]").forEach((b) => b.addEventListener("click", () => selectNode(b.dataset.sel!)));
  document.getElementById("tree-next-gap")?.addEventListener("click", () => {
    const gaps = v.nodes.filter((n) => n.gap).sort((a, b) => (b.reach ?? -1) - (a.reach ?? -1));
    if (gaps[0]) selectNode(gaps[0].id);
  });
  document.getElementById("tree-spar")?.addEventListener("click", startSpar);
  document.getElementById("tree-next-weak")?.addEventListener("click", () => {
    // The next weak move after the selected one (round the tree).
    const weak = v.nodes.filter((n) => n.verdict?.weak);
    const at = weak.findIndex((n) => n.id === treeSel);
    const next = weak[(at + 1) % weak.length];
    if (next) selectNode(next.id);
  });
  el.querySelectorAll<HTMLElement>("[data-tree-color]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.treeColor !== treeColor) openTree(b.dataset.treeColor as Color, null);
    }),
  );
  document.getElementById("tree-depth")?.addEventListener("change", async (e) => {
    const depth = Number((e.target as HTMLSelectElement).value);
    await invoke("rep_set_depth", { depth }).catch(console.error);
    await loadTree(true);
  });
  document.getElementById("tree-token")?.addEventListener("click", () => document.getElementById("btn-settings")?.click());
  document.getElementById("tree-course")?.addEventListener("click", () => treeHome && startFocus(treeColor, treeHome));
  document.getElementById("tree-reset")?.addEventListener("click", async () => {
    if (treeHome && (await resetOpening(treeColor, treeHome))) await loadTree(false);
  });
  document.getElementById("tree-remove")?.addEventListener("click", async () => {
    if (!treeHome) return;
    await removeFromRepertoire(treeColor, treeHome);
    await loadProgress();
    setView("home");
  });
  document.getElementById("tree-scope")?.addEventListener("click", () => {
    treeFamily = treeFamily ? null : treeHome;
    tree = null;
    treeSel = null;
    treeOpen.clear();
    renderTop();
    renderTreePanel();
    loadTree(true);
  });
  el.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
}

/** The selected position: what you play there, or what you could play. */
function renderTreeDetail() {
  const head = $("op-head");
  const text = $("op-text");
  const extra = $("op-extra");
  const actions = $("op-actions");
  const n = treeNode(treeSel);
  extra.innerHTML = "";
  actions.innerHTML = "";
  if (!n) {
    head.innerHTML = `<span class="coach-title">${t("Mein Repertoire")}</span>`;
    text.innerHTML = tree ? t("Noch nichts in deinem Repertoire. Lern eine Eröffnung, dann stehen ihre Züge hier.") : "";
    return;
  }
  head.innerHTML = `<span class="pz-tag op-review">${t("Dein Repertoire")}</span><span class="op-name">${n.opening ? esc(openingName(n.opening)) : ""}</span>`;
  const path = treePath(n);
  if (n.gap) {
    text.innerHTML = n.reach != null
      ? t("Nach {moves} kommt das in {p} der Partien auf deinem Niveau – du hast noch keine Antwort.", { moves: `<b>${esc(path)}</b>`, p: pct(n.reach) })
      : t("Nach {moves} hast du noch keine Antwort.", { moves: `<b>${esc(path)}</b>` });
    const facts = (s: TreeSuggestion) =>
      [
        s.book ? t("Theorie") : "",
        s.share != null ? t("{p} der Partien", { p: pct(s.share) }) : "",
        s.games ? tn(s.games, "deine Partien: 1×", "deine Partien: {n}×") : "",
      ]
        .filter(Boolean)
        .join(" · ");
    // Theory decides; outside theory, Stockfish's pick among the moves played here.
    let rec = n.suggestions.find((s) => s.uci === n.recommended) ?? null;
    let recWhy = t("Der Theoriezug – am häufigsten auf deinem Niveau gespielt");
    if (!rec) {
      n.suggestions.forEach((s) => treeEval(n.fen, s.uci));
      const scored = n.suggestions.map((s) => ({ s, r: treeEvals.get(`${n.fen}|${s.uci}`) })).filter((x) => x.r);
      if (n.suggestions.length && scored.length === n.suggestions.length) {
        scored.sort((x, y) => y.r!.winAfter - x.r!.winAfter || (y.s.share ?? 0) - (x.s.share ?? 0));
        rec = scored[0].s;
        recWhy = t("Keine Theorie mehr – Stockfishs Wahl unter den Zügen, die hier gespielt werden");
      }
    } else {
      treeEval(n.fen, rec.uci);
    }
    const others = n.suggestions.filter((s) => s !== rec);
    if (treeAltsOpen) others.forEach((s) => treeEval(n.fen, s.uci));
    const recHtml = rec
      ? `<div class="tree-rec">
          <span class="tree-rec-label">${t("Empfohlen")}</span>
          <span class="tree-rec-move"><b>${esc(fig(rec.san))}</b> ${evalBadge(n.fen, rec.uci)}</span>
          <span class="muted tree-rec-why">${recWhy}${facts(rec) ? ` · ${facts(rec)}` : ""}</span>
          <button class="primary" data-take="${esc(rec.uci)}">${t("Übernehmen")}</button>
        </div>`
      : n.suggestions.length
        ? `<p class="muted">${t("Stockfish prüft die Möglichkeiten …")}</p>`
        : `<p class="muted">${t("Hier gibt es keine Vorschläge – spiel deinen Zug auf dem Brett, Stockfish prüft ihn.")}</p>`;
    const othersHtml = others.length
      ? `<button class="link tree-alts-toggle">${treeAltsOpen ? "▾" : "▸"} ${t("Andere Möglichkeiten ({n})", { n: others.length })}</button>${
          treeAltsOpen
            ? `<div class="tree-suggs">${others
                .map(
                  (s) =>
                    `<button class="tree-sugg" data-take="${esc(s.uci)}"><b>${esc(fig(s.san))}</b> ${evalBadge(n.fen, s.uci)}<span class="muted">${facts(s)}</span></button>`,
                )
                .join("")}</div>
               <p class="muted tree-own-hint">${t("Oder spiel einen eigenen Zug auf dem Brett – Stockfish prüft ihn, bevor er ins Repertoire kommt.")}</p>`
            : ""
        }`
      : "";
    extra.innerHTML = recHtml + othersHtml;
    const gapExit = treeExits().get(n.id);
    if (gapExit) {
      extra.insertAdjacentHTML(
        "afterbegin",
        `<p class="tree-exit-note">⚠ ${tn(
          gapExit.times,
          "In einer deiner Partien hast du hier {move} gespielt und kurz danach einen Fehler gemacht.",
          "In {n} deiner Partien hast du hier {move} gespielt und kurz danach einen Fehler gemacht.",
          { move: `<b>${esc(numbered(gapExit.ply, gapExit.played))}</b>` },
        )}</p>`,
      );
    }
    extra.querySelector(".tree-alts-toggle")?.addEventListener("click", () => {
      treeAltsOpen = !treeAltsOpen;
      renderTreeDetail();
    });
    extra.querySelectorAll<HTMLElement>("[data-take]").forEach((b) => b.addEventListener("click", () => takeTreeMove(n, b.dataset.take!)));
    return;
  }
  if (treeEditing) {
    text.innerHTML = `${t("Statt {mine}: Spiel deinen neuen Zug auf dem Brett oder wähl einen hier.", { mine: `<b>${esc(fig(n.mine ?? ""))}</b>` })} <span class="muted">${t(
      "Er bekommt eine neue Karte. Was nur nach dem alten Zug kam, fällt aus deinem Repertoire.",
    )}</span>`;
    const options: { uci: string; san: string; note: string }[] = [];
    for (const x of n.strays) options.push({ uci: x.uci, san: x.played, note: tn(x.times, "1× in deinen Partien", "{n}× in deinen Partien") });
    for (const a of n.alts) if (!options.some((o) => o.uci === a.uci)) options.push({ uci: a.uci, san: a.san, note: t("{p} der Partien", { p: pct(a.share ?? 0) }) });
    options.forEach((o) => treeEval(n.fen, o.uci));
    extra.innerHTML = `${
      options.length
        ? `<div class="tree-suggs">${options
            .map((o) => `<button class="tree-sugg" data-uci="${esc(o.uci)}"><b>${esc(fig(o.san))}</b> ${evalBadge(n.fen, o.uci)}<span class="muted">${o.note}</span></button>`)
            .join("")}</div>`
        : ""
    }<p class="muted tree-own-hint">${t("Stockfish prüft jeden Zug, bevor er ins Repertoire kommt.")}</p>`;
    extra.querySelectorAll<HTMLElement>("[data-uci]").forEach((b) => b.addEventListener("click", () => takeTreeMove(n, b.dataset.uci!)));
    actions.innerHTML = `<button data-tree="cancel">${t("Abbrechen")}</button>`;
    actions.querySelector("[data-tree=cancel]")!.addEventListener("click", () => {
      treeEditing = false;
      renderTree();
    });
    return;
  }
  const card = n.isNew
    ? t("Neue Karte – kommt gleich im Karteikasten dran.")
    : n.due
      ? t("Fach {n} von 5 · heute fällig", { n: n.boxLevel })
      : t("Fach {n} von 5 · wieder {when}", { n: n.boxLevel, when: relDays(n.dueAt) });
  text.innerHTML = `${
    n.opp
      ? t("Auf {opp} spielst du {mine}.", { opp: `<b>${esc(fig(n.opp))}</b>`, mine: `<b>${esc(fig(n.mine ?? ""))}</b>` })
      : t("Du spielst {mine}.", { mine: `<b>${esc(fig(n.mine ?? ""))}</b>` })
  }<br><span class="muted">${card}${n.reach != null && n.depth > 0 ? ` · ${t("hierher kommen {p} der Partien", { p: pct(n.reach) })}` : ""}${
    n.games ? ` · ${tn(n.games, "1× in deinen Partien", "{n}× in deinen Partien")}` : ""
  }</span>`;
  const parts: string[] = [];
  const exit = treeExits().get(n.id);
  if (exit) {
    parts.push(
      `<p class="tree-exit-note">⚠ ${tn(
        exit.times,
        "In einer deiner Partien hast du hier {move} gespielt und kurz danach einen Fehler gemacht.",
        "In {n} deiner Partien hast du hier {move} gespielt und kurz danach einen Fehler gemacht.",
        { move: `<b>${esc(numbered(exit.ply, exit.played))}</b>` },
      )}${n.mine ? ` ${t("Dein Repertoire-Zug ist {mine}.", { mine: `<b>${esc(fig(n.mine))}</b>` })}` : ""}</p>`,
    );
  }
  if (n.verdict?.weak) {
    const v = n.verdict;
    parts.push(
      `<p class="tree-weak-note">${t("Stockfish hält {mine} für {phrase}.", { mine: `<b>${esc(fig(n.mine ?? ""))}</b>`, phrase: CLASSES[v.class].phrase })}${
        v.best ? ` ${t("Besser ist {best}.", { best: `<b>${esc(fig(v.best))}</b>` })} <button data-tree="best">${t("Zu {best} ändern", { best: esc(fig(v.best)) })}</button>` : ""
      }</p>`,
    );
  }
  if (n.strays.length) {
    parts.push(
      `<p class="tree-stray-note">≠ ${t("In deinen Partien hast du hier auch gespielt: {moves}.", {
        moves: n.strays.map((x) => `<b>${esc(fig(x.played))}</b> (${x.times}×)`).join(", "),
      })} <button class="link" data-tree="stray-game">${t("Letzte Partie")}</button></p>`,
    );
  }
  if (n.alts.length) {
    parts.push(
      `<span class="muted">${t("Andere Züge hier: {moves} – nicht in deinem Repertoire.", {
        moves: n.alts.map((a) => `${esc(fig(a.san))} (${pct(a.share ?? 0)})`).join(", "),
      })}</span>`,
    );
  }
  parts.push(`<label class="op-idea op-idea-edit"><span class="op-idea-label">${t("Deine Idee zu diesem Zug")}</span>
    <input type="text" id="tree-note" maxlength="300" value="${esc(n.note)}" placeholder="${t("Warum dieser Zug? Ein Satz reicht – z. B. „Läufer raus, bevor e6 ihn einsperrt“")}" /></label>`);
  extra.innerHTML = parts.join("");
  const noteInput = extra.querySelector<HTMLInputElement>("#tree-note")!;
  noteInput.addEventListener("change", async () => {
    const v = noteInput.value.trim();
    n.note = v;
    notes[treeColor][n.id] = v;
    await invoke("rep_set_note", { color: treeColor, epd: n.id, note: v }).catch(console.error);
  });
  noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") noteInput.blur();
  });
  extra.querySelector("[data-tree=best]")?.addEventListener("click", () => n.verdict?.bestUci && changeTreeMove(n.verdict.bestUci));
  extra.querySelector("[data-tree=stray-game]")?.addEventListener("click", () => {
    const x = n.strays[0];
    deps.openGame(x.gameId, x.ply);
  });
  actions.innerHTML = `${exit ? `<button data-tree="game">${t("Partie ansehen")}</button>` : ""}
    <button data-tree="change" title="${t("In dieser Stellung einen anderen Zug spielen")}">${t("Zug ändern")}</button>
    <button data-tree="delete" title="${t("Diesen Zug und alles, was nur danach kommt, aus deinem Repertoire nehmen")}">${t("Zweig löschen")}</button>
    <button data-tree="practise" class="primary">${t("Diese Karte üben")}</button>`;
  actions.querySelector("[data-tree=practise]")!.addEventListener("click", () => practiseMove(n));
  actions.querySelector("[data-tree=game]")?.addEventListener("click", () => exit && deps.openGame(exit.gameId, exit.ply - 1));
  actions.querySelector("[data-tree=change]")!.addEventListener("click", () => {
    treeEditing = true;
    renderTree();
  });
  actions.querySelector("[data-tree=delete]")!.addEventListener("click", () => deleteTreeMove(n));
}

function renderTreeBoard() {
  const n = treeNode(treeSel);
  if (!n) return;
  const open = n.gap || treeEditing;
  const shown = open ? n.fen : (n.fenAfter ?? n.fen);
  const last = open ? n.oppUci : n.mineUci;
  deps.board.set({
    fen: shown,
    orientation: treeColor,
    turnColor: sideOf(shown),
    lastMove: last ? [sq(last, true), sq(last, false)] : undefined,
    check: false,
    movable: { color: undefined, dests: new Map() },
  });
  deps.board.setAutoShapes([]);
  if (open) {
    // A gap (or another move): play your answer on the board.
    const id = n.id;
    invoke<PositionInfo>("position_info", { fen: n.fen }).then((info) => {
      if (trainMode !== "tree" || treeSel !== id || !(n.gap || treeEditing)) return;
      deps.board.set({ movable: { color: treeColor, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
    });
  }
}

async function treeMove(orig: Key, dest: Key, promotion?: string) {
  const n = treeNode(treeSel);
  if (!n?.gap && !treeEditing) return renderTreeBoard();
  try {
    const played = await invoke<PlayedMove>("play_move", { fen: n!.fen, from: orig, to: dest, promotion });
    moveSound(played.san);
    await takeTreeMove(n!, played.uci);
  } catch {
    renderTreeBoard();
  }
}

/** Let Stockfish check the moves of the tree it hasn't seen yet (in the background). */
async function checkQuality(color: Color, family: string | null, tk: number) {
  try {
    const v = await invoke<TreeView>("rep_check_quality", { accounts: deps.accounts(), color, family });
    if (trainMode === "tree" && tk === treeToken && view === "train") {
      // Keep what's on screen (numbers from Lichess) – only the verdicts are new.
      if (tree) {
        const byId = new Map(v.nodes.map((n) => [n.id, n.verdict]));
        tree.nodes.forEach((n) => (n.verdict = byId.get(n.id) ?? n.verdict));
        tree.weak = tree.nodes.filter((n) => n.verdict?.weak).length;
        tree.checked = tree.nodes.filter((n) => n.verdict).length;
      }
      quality = null;
      renderTree();
    }
    return v;
  } catch (e) {
    console.error(e);
    return null;
  } finally {
    quality = null;
  }
}

/** Stockfish's verdict on a move (once per position and move; the detail redraws when it's there). */
function treeEval(fen: string, uci: string): Promise<MoveReview | null> {
  const key = `${fen}|${uci}`;
  if (treeEvals.has(key)) return Promise.resolve(treeEvals.get(key)!);
  let run = treeEvalRuns.get(key);
  if (!run) {
    run = treeEvalQueue.then(() =>
      invoke<MoveReview>("evaluate_move", { fen, uci })
        .catch(() => null)
        .then((r) => {
          treeEvals.set(key, r);
          treeEvalRuns.delete(key);
          const n = treeNode(treeSel);
          if (n && n.fen === fen && trainMode === "tree" && view === "train") renderTreeDetail();
          return r;
        }),
    );
    treeEvalQueue = run;
    treeEvalRuns.set(key, run);
  }
  return run;
}

/** The verdict as a small badge ("…" while Stockfish thinks). */
function evalBadge(fen: string, uci: string): string {
  const key = `${fen}|${uci}`;
  if (!treeEvals.has(key)) return treeEvalRuns.has(key) ? `<span class="muted tree-eval">…</span>` : "";
  const r = treeEvals.get(key);
  if (!r) return "";
  const c = CLASSES[r.classification];
  return `<span class="tree-eval" style="color:${c.color}" title="${t("Stockfish: {label}", { label: c.label })}">${c.symbol} ${c.label}</span>`;
}

/** A move for the selected position – a gap or another move – after Stockfish had a look (asks if it's weak). */
async function takeTreeMove(n: TreeNode, uci: string) {
  const known = n.suggestions.find((s) => s.uci === uci);
  if (!known?.book) {
    const r = await treeEval(n.fen, uci);
    if (r && WEAK.includes(r.classification)) {
      const ok = confirm(
        t("Stockfish hält {move} für {phrase}.", { move: fig(r.san), phrase: CLASSES[r.classification].phrase }) +
          (r.bestSan && r.bestSan !== r.san ? ` ${t("Besser ist {best}.", { best: fig(r.bestSan) })}` : "") +
          ` ${t("Trotzdem in dein Repertoire übernehmen?")}`,
      );
      if (!ok) return renderTreeBoard();
    }
  }
  if (n.gap) await setTreeMove(uci);
  else await changeTreeMove(uci);
}

/** Your answer for the selected gap: into the repertoire, as a new card. */
async function setTreeMove(uci: string) {
  const n = treeNode(treeSel);
  if (!n) return;
  try {
    await invoke("rep_set_move", { color: treeColor, path: n.path, uci });
  } catch (e) {
    console.error(e);
    return;
  }
  // The numbers after your new move may be missing: fetch them too.
  await loadTree(true);
}

/** Another move for the selected position (asks first if moves after the old one go). */
async function changeTreeMove(uci: string) {
  const n = treeNode(treeSel);
  if (!n || n.gap) return;
  if (uci === n.mineUci) {
    treeEditing = false;
    return renderTree();
  }
  if (!(await changeMoveAt(treeColor, n, uci, () => loadTree(false)))) return renderTreeBoard();
  treeEditing = false;
  await loadTree(true);
}

/** Another move in one of your positions (asks first if moves after the old one go); true if changed. */
async function changeMoveAt(color: Color, n: TreeNode, uci: string, reload: () => unknown): Promise<boolean> {
  const args = { color, path: n.path, uci };
  try {
    const gone = (await invoke<Changed>("rep_change_move", { ...args, dry: true })).count;
    if (
      gone &&
      !confirm(
        tn(
          gone,
          "Nach {mine} hast du noch 1 weiteren Zug im Repertoire. Er fällt mit weg. Trotzdem ändern?",
          "Nach {mine} hast du noch {n} weitere Züge im Repertoire. Sie fallen mit weg. Trotzdem ändern?",
          { mine: fig(n.mine ?? "") },
        ),
      )
    ) {
      return false;
    }
    const done = await invoke<Changed>("rep_change_move", { ...args, dry: false });
    const text = `${t("Zug geändert.")}${done.count ? ` ${tn(done.count, "1 Zug danach entfernt.", "{n} Züge danach entfernt.")}` : ""}`;
    if (done.undo) undoToast(text, done.undo, reload);
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

/** Take the selected move and what only follows from it out of the repertoire. */
async function deleteTreeMove(n: TreeNode) {
  const args = { color: treeColor, path: n.path };
  const gone = await invoke<Changed>("rep_delete_move", { ...args, dry: true }).then((c) => c.count).catch(() => 0);
  if (!gone) return;
  const ok = confirm(
    gone > 1
      ? t("{mine} und {n} Züge danach aus deinem Repertoire nehmen? Ihre Karten werden gelöscht.", { mine: fig(n.mine ?? ""), n: gone - 1 })
      : t("{mine} aus deinem Repertoire nehmen? Die Karte wird gelöscht.", { mine: fig(n.mine ?? "") }),
  );
  if (!ok) return;
  const done = await invoke<Changed>("rep_delete_move", { ...args, dry: false });
  if (done.undo) undoToast(tn(done.count, "1 Zug entfernt.", "{n} Züge entfernt."), done.undo, () => loadTree(false));
  await loadTree(false);
}

/** A change to your repertoire and how to undo it (see tree.rs). */
interface Changed {
  count: number;
  undo: unknown;
}

let toastTimer: number | undefined;

/** "Gelöscht · Rückgängig" for a few seconds after a change to your repertoire. */
function undoToast(text: string, undo: unknown, reload: () => unknown) {
  let el = document.getElementById("op-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "op-toast";
    el.className = "op-toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  const box = el;
  box.innerHTML = `<span>${esc(text)}</span><button>${t("Rückgängig")}</button>`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (box.hidden = true), 8000);
  box.querySelector("button")!.addEventListener("click", async () => {
    clearTimeout(toastTimer);
    box.hidden = true;
    await invoke("rep_restore", { snapshot: undo }).catch(console.error);
    await reload();
  });
}

// ---------------------------------------------------------------------------
// sparring: the opponent plays through your tree (by how often moves come up
// at your level), you answer with your moves

interface Spar {
  /** Your position now (null before the first move). */
  at: TreeNode | null;
  fen: string;
  lastMove?: string;
  phase: "opp" | "you" | "wrong" | "end";
  /** How the run ended: a reply you have no answer to, or the end of your repertoire. */
  end: "gap" | "leaf" | null;
  right: number;
  wrong: number;
  /** Your moves played wrong in this run (shown at the end). */
  missed: TreeNode[];
  tried: string | null;
}

let spar: Spar | null = null;

/** Start a sparring run through the tree on screen. */
function startSpar() {
  if (!tree?.nodes.length) return;
  trainMode = "spar";
  spar = { at: null, fen: START_FEN, phase: "opp", end: null, right: 0, wrong: 0, missed: [], tried: null };
  setView("train");
  sparNext(null);
}

/** The opponent's reply after your move in `parent` (null: from the root), by how often it comes up. */
function sparNext(parent: string | null) {
  const sp = spar!;
  const kids = tree!.nodes.filter((n) => n.parent === parent);
  if (!kids.length) {
    sp.phase = "end";
    sp.end = "leaf";
    successSound();
    return render();
  }
  // The tree starts in your own position: no opponent move first.
  const root = kids.find((n) => !n.opp);
  if (root) {
    sp.at = root;
    sp.fen = root.fen;
    sp.lastMove = undefined;
    sp.phase = "you";
    return render();
  }
  const known = kids.map((n) => n.reach).filter((r): r is number => r != null && r > 0);
  const floor = known.length ? Math.min(...known) : 1;
  const weights = kids.map((n) => (n.reach != null && n.reach > 0 ? n.reach : floor));
  let pick = Math.random() * weights.reduce((a, b) => a + b, 0);
  let node = kids[kids.length - 1];
  for (let i = 0; i < kids.length; i++) {
    pick -= weights[i];
    if (pick <= 0) {
      node = kids[i];
      break;
    }
  }
  sp.phase = "opp";
  render();
  const tk = token;
  timer = window.setTimeout(() => {
    if (tk !== token || spar !== sp) return;
    sp.at = node;
    sp.fen = node.fen;
    sp.lastMove = node.oppUci ?? undefined;
    if (node.opp) moveSound(node.opp);
    if (node.gap) {
      sp.phase = "end";
      sp.end = "gap";
    } else {
      sp.phase = "you";
    }
    render();
  }, Math.max(350, deps.animMs() + 150));
}

async function sparMove(orig: Key, dest: Key, promotion?: string) {
  const sp = spar;
  const n = sp?.at;
  if (!sp || !n || (sp.phase !== "you" && sp.phase !== "wrong")) return render();
  const tk = token;
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen: n.fen, from: orig, to: dest, promotion });
  } catch {
    return render();
  }
  if (tk !== token || spar !== sp) return;
  if (played.uci !== n.mineUci) {
    errorSound();
    sp.tried = played.san;
    if (sp.phase === "you") {
      // A mistake sends the card back to box 1 (once per move and run).
      sp.wrong++;
      sp.missed.push(n);
      sp.phase = "wrong";
      invoke("opening_record", { id: `m:${n.id}`, color: treeColor, success: false }).catch(console.error);
    }
    return render();
  }
  moveSound(played.san);
  if (sp.phase === "you") sp.right++;
  sp.fen = n.fenAfter ?? played.fen;
  sp.lastMove = played.uci;
  sp.tried = null;
  sparNext(n.id);
}

function renderSpar() {
  const sp = spar;
  if (!sp) return;
  const n = sp.at;
  const shapes: DrawShape[] = [];
  if (sp.phase === "wrong" && n?.mineUci) shapes.push({ orig: sq(n.mineUci, true), dest: sq(n.mineUci, false), brush: "green" });
  deps.board.set({
    fen: sp.fen,
    orientation: treeColor,
    turnColor: sideOf(sp.fen),
    lastMove: sp.lastMove ? [sq(sp.lastMove, true), sq(sp.lastMove, false)] : undefined,
    check: false,
    movable: { color: undefined, dests: new Map() },
  });
  deps.board.setAutoShapes(shapes);
  if ((sp.phase === "you" || sp.phase === "wrong") && n) {
    const tk = token;
    invoke<PositionInfo>("position_info", { fen: n.fen }).then((info) => {
      if (tk !== token || spar !== sp || (sp.phase !== "you" && sp.phase !== "wrong")) return;
      deps.board.set({ movable: { color: treeColor, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
    });
  }
  renderSparText();
}

function renderSparText() {
  const sp = spar;
  if (!sp) return;
  const head = $("op-head");
  const text = $("op-text");
  const extra = $("op-extra");
  const actions = $("op-actions");
  const n = sp.at;
  head.innerHTML = `<span class="pz-tag op-review">${t("Sparring")}</span><span class="op-name">${n?.opening ? esc(openingName(n.opening)) : ""}</span>
    <span class="muted op-spar-score">✓ ${sp.right} · ✗ ${sp.wrong}</span>`;
  extra.innerHTML = "";
  const moves = n ? treePath(n) : "";
  switch (sp.phase) {
    case "opp":
      text.innerHTML = `<span class="muted">${t("Der Gegner zieht …")}</span>`;
      break;
    case "you":
      text.innerHTML = `${moves ? `${esc(moves)}<br>` : ""}<b>${t("Du bist dran.")}</b> ${t("Was spielst du hier?")}`;
      break;
    case "wrong":
      text.innerHTML = `${esc(moves)}<br>${t("{move} ist nicht dein Zug. Dein Repertoire-Zug ist {mine} – spiel ihn nach.", {
        move: `<b>${esc(fig(sp.tried ?? ""))}</b>`,
        mine: `<b>${esc(fig(n?.mine ?? ""))}</b>`,
      })} <span class="muted">${t("Die Karte geht zurück in Fach 1.")}</span>`;
      if (n?.note) extra.innerHTML = `<p class="op-idea"><span class="op-idea-label">${t("Deine Idee:")}</span> ${esc(n.note)}</p>`;
      break;
    case "end": {
      const result = t("{right} Züge richtig, {wrong} falsch.", { right: sp.right, wrong: sp.wrong });
      text.innerHTML =
        sp.end === "gap" && n
          ? `${esc(moves)}<br>${t("Hier hast du noch <b>keine Antwort</b> – das war das Ende dieser Runde.")} ${result}`
          : `${t("<b class=\"ok\">Ende deines Repertoires</b> in dieser Linie.")} ${result}`;
      if (sp.missed.length) {
        extra.innerHTML = `<span class="muted">${t("Daneben:")}</span> ${sp.missed.map((m) => `${esc(fig(m.opp ?? ""))} → <b>${esc(fig(m.mine ?? ""))}</b>`).join(" · ")}`;
      }
      break;
    }
  }
  actions.innerHTML =
    sp.phase === "end"
      ? `${sp.end === "gap" ? `<button data-spar="gap">${t("Lücke füllen")}</button>` : ""}<button data-spar="tree">${t("Zum Baum")}</button><button data-spar="again" class="primary end">${t("Nochmal")} →</button>`
      : `<button data-spar="tree" class="end">${t("Beenden")}</button>`;
  actions.querySelector("[data-spar=again]")?.addEventListener("click", startSpar);
  actions.querySelector("[data-spar=tree]")?.addEventListener("click", () => openTree(treeColor, treeFamily, sp.at?.id ?? null, treeHome));
  actions.querySelector("[data-spar=gap]")?.addEventListener("click", () => openTree(treeColor, treeFamily, n?.id ?? null, treeHome));
}

// ---------------------------------------------------------------------------
// the opening page: learn first – your costly exits from theory, then practice

export function openPage(color: Color, family: string) {
  page = { color, family };
  pageTree = null;
  pageHarmless = false;
  pageRatings = null;
  setView("opening");
}

/** The opening's part of your repertoire, then Stockfish's verdicts on it. */
async function loadPage() {
  const p = page;
  if (!p) return;
  const args = { accounts: deps.accounts(), color: p.color, family: p.family };
  await Promise.all([loadProgress(), theory ? null : loadTheory(), insights.length ? null : loadRecs(), reports.length ? null : loadReports()]);
  try {
    const [tv, detail] = await Promise.all([
      invoke<TreeView>("rep_tree", args),
      invoke<FamilyDetail>("opening_family_detail", { color: p.color, family: p.family }).catch(() => null),
    ]);
    pageTree = tv;
    pageRatings = detail?.ratings ?? "";
  } catch (e) {
    console.error(e);
  }
  if (page !== p || view !== "opening") return;
  renderPage();
  if (pageTree?.cards) {
    const v = await invoke<TreeView>("rep_check_quality", args).catch(() => null);
    quality = null;
    if (v && page === p) {
      pageTree = v;
      if (view === "opening") renderPage();
    }
  }
}

/** Theory exits of this opening: those that cost you something, and the rest. */
function pageExits(): { costly: TheoryExit[]; harmless: TheoryExit[] } {
  const all = (theory?.positions ?? []).filter((x) => page && x.color === page.color && x.family === page.family);
  // Like the verdict in the list: anything but "Hält" (analysed games only).
  const costly = all.filter((x) => x.analysed > 0 && (x.errorsAfter > 0 || (x.avgLoss ?? 0) >= COSTLY_LOSS));
  return { costly, harmless: all.filter((x) => !costly.includes(x)) };
}

/** Where your games in this opening left your repertoire. */
function pageReports(): GameReport[] {
  return page ? reports.filter((r) => r.color === page!.color && r.family === page!.family) : [];
}

/**
 * The course has every theory line until you ask Lichess what is played at
 * your level (then rare sidelines leave the course): the button for that.
 */
function levelHtml(key: string): string {
  const r = prepared.get(key);
  const row = (text: string, button = "") => `<div class="opn-level"><span class="muted">${text}</span>${button}</div>`;
  if (preparing.has(key)) {
    const f = fetching?.key === key ? fetching : null;
    return row(
      f?.waiting
        ? t("Lichess bittet um eine kurze Pause – in einer Minute geht es weiter …")
        : `${t("Ich frage bei Lichess nach, welche Antworten deine Gegner hier wirklich spielen …")}${f ? ` ${tn(f.done, "1 Stellung geholt", "{n} Stellungen geholt")}` : ""}`,
    );
  }
  if (r?.state === "noToken") return row(t("Dafür braucht es einen Lichess-Schlüssel."), `<button class="link" id="opn-token">${t("Einstellungen")}</button>`);
  if (pageRatings) {
    const note = r?.state === "partial" && r.error ? ` ${esc(r.error)}` : "";
    return row(t("Kurs auf dein Niveau zugeschnitten (Lichess {ratings}).", { ratings: esc(pageRatings) }) + note);
  }
  return row(t("Der Kurs enthält alle Theorielinien."), `<button id="opn-level">${t("Was wird auf meinem Niveau gespielt?")}</button>`);
}

/** Average loss of winning chances (percentage points) from which leaving theory counts as bad. */
const COSTLY_LOSS = 3;

function renderPage() {
  if (!active || view !== "opening" || !page) return;
  const { color, family } = page;
  const key = `${color}|${family}`;
  const p = progress[key];
  const sum = summaries[key];
  const ins = insightOf[key];
  const v = pageTree;
  const begun = (p?.started ?? 0) > 0;
  const facts = [
    p?.lines ? t("{learned} von {lines} Linien gelernt", { learned: p.learned, lines: p.lines }) : "",
    sum?.coverage != null ? t("{p} abgedeckt", { p: pct(sum.coverage) }) : "",
    ins ? tn(ins.games, "1 Partie", "{n} Partien") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const { costly, harmless } = pageExits();
  const weak = v?.nodes.filter((n) => n.verdict?.weak) ?? [];
  const q = quality?.color === color ? quality : null;
  const due = v?.due ?? 0;
  $("op-opening").innerHTML = `
    <div class="op-home-head opn-head">
      <button id="opn-back">← ${t("Übersicht")}</button>
      <h2>${esc(openingName(family))} <span class="muted">${t("als {side}", { side: SIDE[color] })}</span></h2>
    </div>
    ${facts ? `<p class="muted opn-facts">${facts}</p>` : ""}
    <div class="opn-main">
      <button class="opn-big primary" id="opn-learn">
        <b>${begun ? t("Weiterlernen") : t("Eröffnung lernen")} →</b>
        <span>${t("Die nächste wichtige Linie, Zug für Zug mit Erklärungen. Was du kannst, kommt in deinen Karteikasten.")}</span>
      </button>
      <button class="opn-big" id="opn-spar" ${v?.cards ? "" : "disabled"}>
        <b>${t("Sparring")} ▶</b>
        <span>${v?.cards ? t("Der Gegner spielt, was auf deinem Niveau kommt – du antwortest mit deinen Zügen.") : t("Sobald du die ersten Linien kannst.")}</span>
      </button>
      ${
        due
          ? `<button class="opn-big" id="opn-due"><b>${t("Karteikasten")}</b><span>${tn(due, "1 Karte aus dieser Eröffnung ist fällig.", "{n} Karten aus dieser Eröffnung sind fällig.")}</span></button>`
          : ""
      }
    </div>
    ${levelHtml(key)}
    ${
      weak.length
        ? `<div class="op-home-mine opn-weak">
            <h3>${t("Schwache Züge in deinem Repertoire")}</h3>
            <div class="op-mine-list">${weak
              .map(
                (n) => `<div class="op-mine-row">
                  <span class="op-mine-name">${esc(treePathIn(v!, n))} <b>${esc(fig(n.mine ?? ""))}</b><br>
                    <span class="muted">${t("Stockfish: {label}", { label: CLASSES[n.verdict!.class].label })}${n.verdict!.best ? ` · ${t("besser {best}", { best: esc(fig(n.verdict!.best)) })}` : ""}</span></span>
                  ${n.verdict!.bestUci ? `<button data-weak="${esc(n.id)}" class="primary">${t("Zu {best} ändern", { best: esc(fig(n.verdict!.best ?? "")) })}</button>` : ""}
                </div>`,
              )
              .join("")}</div>
          </div>`
        : ""
    }
    <div class="op-home-mine" id="opn-exits">
      <h3>${t("Hier fällst du aus der Theorie")}</h3>
      ${
        costly.length
          ? `<p class="panel-sub">${t("Stellen aus deinen Partien, an denen du die Theorie verlassen hast und es dich etwas gekostet hat – Stockfish fand deinen Zug schwach, oder kurz danach kam ein Fehler. Lern die Linie dahinter.")}</p>${theoryListHtml(costly)}`
          : `<p class="muted">${
              (theory?.positions ?? []).some((x) => x.color === color && x.family === family)
                ? t("Keine teuren Stellen – wo du die Theorie verlässt, hat es dich bisher nichts gekostet.")
                : t("In deinen analysierten Partien fällst du hier nicht aus der Theorie.")
            }</p>`
      }
      ${
        harmless.length
          ? `<button class="link opn-harmless">${pageHarmless ? "▾" : "▸"} ${tn(harmless.length, "1 weitere Abweichung (hält oder noch nicht analysiert)", "{n} weitere Abweichungen (halten oder noch nicht analysiert)")}</button>${pageHarmless ? theoryListHtml(harmless) : ""}`
          : ""
      }
    </div>
    ${
      pageReports().length
        ? `<div id="opn-reports">${reportsHtml(pageReports(), false)}</div>`
        : ""
    }
    <div class="opn-foot">
      ${q ? `<span class="muted">${t("Stockfish prüft deine Züge … {done} von {total}", { done: q.done, total: q.total })}</span>` : v?.cards && !weak.length && v.checked ? `<span class="muted">✓ ${t("Stockfish hat deine Züge geprüft – keine schwachen dabei.")}</span>` : ""}
      <button class="link" id="opn-tree">${t("Repertoire-Baum ansehen")}</button>
      ${begun || v?.cards ? `<button class="link" id="opn-reset">${t("Eröffnung zurücksetzen")}</button>` : ""}
      ${repertoire[color].includes(family) ? `<button class="link" id="opn-remove">${t("Aus „Deine Eröffnungen“ nehmen")}</button>` : ""}
    </div>`;
  const el = $("op-opening");
  $("opn-back").addEventListener("click", () => setView("home"));
  $("opn-learn").addEventListener("click", () => {
    fromPage = true;
    startFocus(color, family);
  });
  document.getElementById("opn-spar")?.addEventListener("click", () => {
    if (!v) return;
    fromPage = true;
    tree = v;
    treeColor = color;
    treeFamily = treeHome = family;
    startSpar();
  });
  document.getElementById("opn-due")?.addEventListener("click", () => {
    fromPage = true;
    startTrain("due", { color, family });
  });
  document.getElementById("opn-token")?.addEventListener("click", () => {
    prepared.delete(key);
    document.getElementById("btn-settings")?.click();
  });
  document.getElementById("opn-level")?.addEventListener("click", async () => {
    const r = prepareRelevance(color, family);
    renderPage();
    await r;
    if (page?.color === color && page.family === family) loadPage();
  });
  const repEl = document.getElementById("opn-reports");
  if (repEl) bindReports(repEl, pageReports(), renderPage);
  const exitsEl = $("opn-exits");
  bindTheoryList(exitsEl, {
    openGame: deps.openGame,
    learnLine: (g, ply, c, f) => {
      fromPage = true;
      learnLineForGame(g, ply, c, f);
    },
  });
  exitsEl.querySelector(".opn-harmless")?.addEventListener("click", () => {
    pageHarmless = !pageHarmless;
    renderPage();
  });
  el.querySelectorAll<HTMLElement>("[data-weak]").forEach((b) =>
    b.addEventListener("click", async () => {
      const n = v?.nodes.find((x) => x.id === b.dataset.weak);
      if (!n?.verdict?.bestUci) return;
      if (await changeMoveAt(color, n, n.verdict.bestUci, loadPage)) loadPage();
    }),
  );
  $("opn-tree").addEventListener("click", () => {
    fromPage = true;
    openTree(color, family);
  });
  document.getElementById("opn-reset")?.addEventListener("click", async () => {
    if (await resetOpening(color, family)) loadPage();
  });
  document.getElementById("opn-remove")?.addEventListener("click", async () => {
    await removeFromRepertoire(color, family);
    await loadProgress();
    setView("home");
  });
}

/** The moves to a node of a tree: "1.e4 c6 2.d4 d5 3.e5" (your move not included). */
function treePathIn(v: TreeView, n: TreeNode): string {
  const byId = new Map(v.nodes.map((x) => [x.id, x]));
  const chain: TreeNode[] = [];
  for (let x: TreeNode | undefined = n; x; x = x.parent ? byId.get(x.parent) : undefined) chain.unshift(x);
  return chain
    .flatMap((x) => (x === n ? [x.opp] : [x.opp, x.mine]))
    .filter((m): m is string => !!m)
    .map((m) => fig(m))
    .join(" ");
}

/** Practise one move of your repertoire now (afterwards "Weiter" goes on with what's due). */
function practiseMove(n: TreeNode) {
  if (!n.mineUci) return;
  trainMode = "due";
  focus = null;
  consolidate = null;
  setView("train");
  const tk = ++token;
  startDrill(
    {
      kind: "move",
      id: `m:${n.id}`,
      color: treeColor,
      name: n.opening ?? "",
      eco: "",
      fen: START_FEN,
      moves: [...n.path, n.mineUci],
      status: "due",
      own: null,
      bookLen: n.path.length + 1,
      card: null,
      askFrom: n.path.length,
    },
    tk,
  );
}

// ---------------------------------------------------------------------------
// drills

/** "3…f6" / "12. Nf3" – a move with its number (figurines). */
function numbered(ply: number, san: string): string {
  const n = Math.ceil(ply / 2);
  return `${n}${ply % 2 ? ". " : "…"}${fig(san)}`;
}

/** Games and costly theory exits in an opening (row of "Deine Eröffnungen"). */
function gamesCell(color: Color, family: string): string {
  const g = insightOf[`${color}|${family}`];
  if (!g) return `<span class="op-games muted">–</span>`;
  const errors = g.theoryErrors
    ? ` · <span class="${g.theoryErrors >= 2 ? "op-games-bad" : ""}" title="${t("Analysierte Partien, in denen du zuerst die Theorie verlassen und kurz danach einen Fehler gemacht hast")}">${t("{n}× aus der Theorie gefallen", { n: g.theoryErrors })}</span>`
    : "";
  const devs = reports.filter((r) => r.color === color && r.family === family).reduce((a, r) => a + r.times, 0);
  const off = devs ? ` · <span title="${t("So oft haben deine Partien dein Repertoire verlassen – Details auf der Seite der Eröffnung")}">${tn(devs, "1× abgewichen", "{n}× abgewichen")}</span>` : "";
  return `<span class="op-games muted">${tn(g.games, "1 Partie", "{n} Partien")}${errors}${off}</span>`;
}

// ---------------------------------------------------------------------------
// the daily plan: what's worth doing today, best first

interface PlanItem {
  key: string;
  title: string;
  text: string;
  /** Still to do. */
  open: boolean;
  /** What the item works on (opening, game moment) – enough to start it again later. */
  arg?: { color: Color; family: string | null; gameId?: string; ply?: number };
}

/** Today's plan as stored: which items, their titles, which are done, how far along. */
interface StoredPlan {
  /** Format version: older plans (done on click) are made again. */
  v: number;
  day: string;
  items: { key: string; title: string; text: string; arg?: PlanItem["arg"] }[];
  done: string[];
  /** Mistakes from your games solved today (the item is done after `OWN_GOAL`). */
  own?: number;
}

const OWN_GOAL = 3;
const PUZZLE_GOAL = 10;
/** The plan item being worked on (finishing it marks it done). */
let planActive: string | null = null;
/** Puzzles tried today (from the puzzle profile). */
let puzzlesToday = 0;
/** `ownCount` has been loaded (0 before that means nothing). */
let ownLoaded = false;

const PLAN_KEY = "lern-plan";
const PLAN_VERSION = 2;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** A costly exit from theory: you left it and it cost you (analysed games). */
const costlyExit = (x: TheoryExit) => x.analysed > 0 && (x.errorsAfter > 0 || (x.avgLoss ?? 0) >= COSTLY_LOSS);

/**
 * What's worth doing now, best first: the flashcards that are due, the most
 * costly thing in your openings (a weak repertoire move, else where you drop
 * out of theory and it costs you), your mistakes from games, a new line in the
 * opening that pays off most – only if the flashcards aren't piling up – and
 * puzzles for tactics.
 */
function planCandidates(): PlanItem[] {
  const out: PlanItem[] = [];
  const due = (status?.white.due ?? 0) + (status?.black.due ?? 0) + (status?.cardsDue ?? 0);
  if (due) {
    out.push({
      key: "due",
      title: t("Karteikasten"),
      text: tn(due, "1 Karte ist fällig.", "{n} Karten sind fällig."),
      open: true,
    });
  }
  const weak = Object.entries(summaries).find(([, x]) => x.weak > 0);
  const exit = (theory?.positions ?? []).find(costlyExit);
  if (weak) {
    const [color, family] = weak[0].split("|") as [Color, string];
    out.push({
      key: `weak:${weak[0]}`,
      title: t("Schwachen Zug verbessern"),
      text: t("In {family} als {side} hält Stockfish einen deiner Züge für schwach.", { family: openingName(family), side: SIDE[color] }),
      open: true,
      arg: { color, family },
    });
  } else if (exit) {
    const num = `${Math.ceil(exit.ply / 2)}${exit.ply % 2 ? "." : "…"}`;
    out.push({
      key: `exit:${exit.gameId}:${exit.ply}`,
      title: t("Linie lernen: {name}", { name: openingName(exit.family ?? exit.opening ?? "") }),
      text: t("Hier fällst du aus der Theorie und es kostet dich: {move}.", { move: `${num} ${exit.played.map((m) => m.san).join(", ")}` }),
      open: true,
      arg: { color: exit.color, family: exit.family, gameId: exit.gameId, ply: exit.ply },
    });
  }
  if (ownCount) {
    out.push({
      key: "own",
      title: t("Fehler aus deinen Partien"),
      text: tn(ownCount, "1 Stellung, in der du danebengegriffen hast.", "{n} Stellungen, in denen du danebengegriffen hast."),
      open: true,
    });
  }
  // Something new only while the flashcards keep up.
  if (due < 20) {
    const pick =
      insights.find((r) => r.score > 0 && (progress[`${r.color}|${r.family}`]?.learned ?? 0) < (progress[`${r.color}|${r.family}`]?.lines ?? Infinity)) ??
      myOpenings().find((o) => o.p && o.p.started < o.p.lines);
    if (pick) {
      out.push({
        key: `learn:${pick.color}|${pick.family}`,
        title: t("Neue Linie: {family}", { family: openingName(pick.family) }),
        text: t("Als {side} – die nächste wichtige Linie, mit Erklärungen.", { side: SIDE[pick.color] }),
        open: true,
        arg: { color: pick.color, family: pick.family },
      });
    }
  }
  out.push({ key: "puzzles", title: t("10 Puzzles"), text: t("Taktik – entscheidet die meisten Partien."), open: true });
  return out.slice(0, 5);
}

function loadPlan(): StoredPlan | null {
  try {
    const p = JSON.parse(store.get(PLAN_KEY) ?? "null") as StoredPlan | null;
    return p?.day === today() && p.v === PLAN_VERSION ? p : null;
  } catch {
    return null;
  }
}

/** Today's plan: made once a day (so it doesn't jump around); an item is done when it really is. */
function plan(): PlanItem[] {
  const live = planCandidates();
  let stored = loadPlan();
  if (!stored) {
    // Only make it once the data is there (the flashcards' status at least).
    if (!status) return live;
    stored = { v: PLAN_VERSION, day: today(), items: live.map(({ key, title, text, arg }) => ({ key, title, text, arg })), done: [] };
    store.set(PLAN_KEY, JSON.stringify(stored));
  }
  const s = stored;
  return s.items.map((it) => {
    const now = live.find((x) => x.key === it.key);
    return { ...it, ...(now ?? {}), open: !itemDone(it.key, s) };
  });
}

function itemDone(key: string, s: StoredPlan): boolean {
  if (s.done.includes(key)) return true;
  const due = (status?.white.due ?? 0) + (status?.black.due ?? 0) + (status?.cardsDue ?? 0);
  if (key === "due") return !!status && due === 0;
  if (key.startsWith("weak:")) return summaries[key.slice(5)]?.weak === 0;
  if (key === "own") return (s.own ?? 0) >= OWN_GOAL || (ownLoaded && ownCount === 0);
  if (key === "puzzles") return puzzlesToday >= PUZZLE_GOAL;
  // A line (from a costly exit or a new one): done once you played it cleanly.
  return false;
}

/** Start a plan item; finishing it (see `planProgress`) marks it done. */
function startPlanItem(x: PlanItem) {
  planActive = x.key;
  const a = x.arg;
  if (x.key === "due") startTrain("due", null);
  else if (x.key === "own") startTrain("own", null);
  else if (x.key === "puzzles") deps.openPuzzles();
  else if (x.key.startsWith("weak:") && a?.family) openPage(a.color, a.family);
  else if (x.key.startsWith("exit:") && a?.gameId && a.ply != null) learnLineForGame(a.gameId, a.ply, a.color, a.family);
  else if (x.key.startsWith("learn:") && a?.family) startFocus(a.color, a.family);
}

/** A drill was finished: count it for the plan item being worked on. */
function planProgress(d: Drill, clean: boolean) {
  const key = planActive;
  const s = loadPlan();
  if (!key || !s) return;
  if (key === "own" && d.kind === "own") {
    s.own = (s.own ?? 0) + 1;
  } else if ((key.startsWith("exit:") || key.startsWith("learn:")) && d.kind === "line" && clean && d.status !== "new" && d.status !== "relearn") {
    // The line played once without arrows and without a mistake (practice after the lesson, or a known line).
    if (!s.done.includes(key)) s.done.push(key);
  } else {
    return;
  }
  store.set(PLAN_KEY, JSON.stringify(s));
}

function planHtml(): string {
  const items = plan();
  if (!items.length) return "";
  const left = items.filter((x) => x.open).length;
  return `<div class="op-plan">
      <div class="op-plan-head">
        <h3>${t("Dein Plan für heute")}</h3>
        <span class="muted">${left ? t("{done} von {all} erledigt", { done: items.length - left, all: items.length }) : `✓ ${t("Für heute geschafft")}`}</span>
        ${left ? `<button class="primary" id="op-plan-go">${items.length - left ? t("Weiter") : t("Plan starten")} →</button>` : ""}
      </div>
      <ol class="op-plan-list">${items
        .map(
          (x, i) => `<li class="${x.open ? "" : "done"}">
            <button class="op-plan-item" data-plan="${i}" title="${x.open ? "" : t("Erledigt – du kannst es trotzdem noch einmal machen")}">
              <span class="op-plan-check">${x.open ? i + 1 : "✓"}</span>
              <span><b>${esc(x.title)}</b><br><span class="muted">${esc(x.text)}</span></span>
            </button></li>`,
        )
        .join("")}</ol>
    </div>`;
}

function bindPlan(el: HTMLElement) {
  const items = plan();
  const run = (x: PlanItem | undefined) => {
    if (x) startPlanItem(x);
  };
  el.querySelectorAll<HTMLElement>("[data-plan]").forEach((b) => b.addEventListener("click", () => run(items[Number(b.dataset.plan)])));
  el.querySelector("#op-plan-go")?.addEventListener("click", () => run(items.find((x) => x.open)));
}

/** Home: everything from your games in one folded block (details live on the opening pages). */
function gamesBlockHtml(): string {
  const exits = theory?.positions.length ?? 0;
  if (!exits && !reports.length) return "";
  const summary = [
    exits ? tn(exits, "1 Stelle, an der du die Theorie verlässt", "{n} Stellen, an denen du die Theorie verlässt") : "",
    reports.length ? tn(reports.length, "1 Abweichung von deinem Repertoire", "{n} Abweichungen von deinem Repertoire") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="op-home-mine op-games-block">
      ${progressHtml()}
      <button class="op-cards-toggle op-games-toggle">${gamesOpen ? "▾" : "▸"} ${t("Alles aus deinen Partien")} <span class="muted">· ${summary}</span></button>
      ${gamesOpen ? `${reportsHtml(reports, true)}${theoryHtml()}` : `<p class="panel-sub">${t("Pro Eröffnung findest du das auch auf ihrer Seite – mit „Linie lernen“.")}</p>`}
      <label class="op-serious"><input type="checkbox" id="op-serious" ${seriousOnly ? "checked" : ""}/> ${t("Nur ernsthafte Partien mit dem Repertoire vergleichen (ohne Bots und Bullet)")}</label>
    </div>`;
}

/** "Im Repertoire: Ø 5,5 deiner Züge – vorher 3,0": does the learning show in your games? */
function progressHtml(): string {
  const p = repProgress;
  if (!p || p.recent == null) return "";
  const fmt = (x: number) => x.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const trend =
    p.before == null
      ? ""
      : p.recent > p.before + 0.2
        ? `<span class="op-trend up">↑ ${t("vorher {n}", { n: fmt(p.before) })}</span>`
        : p.recent < p.before - 0.2
          ? `<span class="op-trend down">↓ ${t("vorher {n}", { n: fmt(p.before) })}</span>`
          : `<span class="op-trend">${t("vorher {n}", { n: fmt(p.before) })}</span>`;
  return `<div class="op-progress-stat" title="${t("Wie viele deiner Repertoire-Züge du im Schnitt spielst, bevor eine Partie dein Repertoire verlässt – in deinen letzten {n} Partien, verglichen mit den {n} davor.", { n: p.window })}">
      <span>${t("In deinen letzten Partien spielst du im Schnitt")}</span>
      <b>${t("{n} Züge aus deinem Repertoire", { n: fmt(p.recent) })}</b>
      ${trend}
    </div>`;
}

/** Wire the buttons of a list made by `reportsHtml`. */
function bindReports(el: HTMLElement, list: GameReport[], rerender: () => void) {
  el.querySelectorAll<HTMLElement>("[data-report]").forEach((b) =>
    b.addEventListener("click", () => {
      const r = list[Number(b.dataset.report)];
      if (b.dataset.act === "game") deps.openGame(r.gameId, r.ply);
      else {
        if (view === "opening") fromPage = true;
        openTree(r.color, r.family, r.epd);
      }
    }),
  );
  el.querySelector(".op-reports-more")?.addEventListener("click", () => {
    reportsAll = !reportsAll;
    rerender();
  });
}

/** "Abgleich mit deinen Partien": where your games left your repertoire (`withOpening`: name each opening). */
function reportsHtml(list: GameReport[], withOpening: boolean): string {
  if (!list.length) return "";
  const shown = reportsAll ? list : list.slice(0, REPORTS_FOLDED);
  const rows = shown
    .map((r, i) => {
      const what =
        r.kind === "deviation"
          ? t("{opp}: du hast {played} gespielt, dein Zug ist {mine}.", {
              opp: `<b>${esc(fig(r.opp ?? "–"))}</b>`,
              played: `<b>${esc(fig(r.played ?? ""))}</b>`,
              mine: `<b>${esc(fig(r.mine ?? ""))}</b>`,
            })
          : t("Auf {opp} hast du noch keine Antwort (gespielt: {played}).", {
              opp: `<b>${esc(fig(r.opp ?? "–"))}</b>`,
              played: esc(fig(r.played ?? "–")),
            });
      return `<div class="op-mine-row op-report">
        ${withOpening ? `<span class="pdot ${r.color}"></span>` : ""}
        <span class="op-mine-name">${
          withOpening ? `${r.opening ? `<b>${esc(openingName(r.opening))}</b> ` : ""}<span class="muted">${t("als {side}", { side: SIDE[r.color] })}</span><br>` : ""
        }<span class="op-report-what">${what}</span></span>
        <span class="op-games muted">${tn(r.times, "1 Partie", "{n} Partien")} · ${relAgo(r.createdAt)}</span>
        <button data-report="${i}" data-act="tree">${r.kind === "gap" ? t("Lücke füllen") : t("Im Baum")}</button>
        <button data-report="${i}" data-act="game" class="link">${t("Partie")}</button>
      </div>`;
    })
    .join("");
  const more =
    list.length > REPORTS_FOLDED
      ? `<button class="link op-reports-more">${reportsAll ? t("Weniger zeigen") : t("Alle {n} zeigen", { n: list.length })}</button>`
      : "";
  return `<div class="op-home-mine">
      <h3>${t("Abgleich mit deinen Partien")}</h3>
      <p class="panel-sub">${t("Wo deine Partien dein Repertoire verlassen: ein anderer Zug als deiner, oder ein Gegnerzug, auf den du noch keine Antwort hast. Spielst du in einer neuen Partie anders, ist die Karte wieder fällig.")}</p>
      <div class="op-mine-list">${rows}</div>
      ${more}
    </div>`;
}

/** "vor 3 Tagen" for a past time. */
function relAgo(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  return days <= 0 ? t("heute") : days === 1 ? t("gestern") : t("vor {n} Tagen", { n: days });
}

/** "Hier verlässt du die Theorie": the positions where you keep leaving the known lines. */
function theoryHtml(): string {
  const positions = theory?.positions ?? [];
  if (!positions.length) return "";
  const more =
    positions.length > THEORY_FOLDED
      ? `<button class="link op-theory-more">${theoryAll ? t("Weniger zeigen") : t("Alle {n} zeigen", { n: positions.length })}</button>`
      : "";
  return `<div class="op-home-mine" id="op-theory-exits">
      <h3>${t("Hier verlässt du die Theorie")}</h3>
      <p class="panel-sub">${t("Stellungen, in denen du immer wieder als Erster die bekannten Eröffnungslinien verlässt. Abweichen ist nicht automatisch schlecht – entscheidend ist, ob es dich etwas kostet (dafür müssen die Partien analysiert sein).")} ${t("Mit „Linie lernen“ lernst du die ganze Eröffnung bis zu dieser Stellung.")}</p>
      ${theoryListHtml(positions, theoryAll ? positions.length : THEORY_FOLDED)}
      ${more}
    </div>`;
}

/** Openings recommended to learn: the top ones by what your games say. */
const MAX_RECOMMENDED = 3;

interface MyOpening {
  color: Color;
  family: string;
  /** Learning progress (openings you learn or have started). */
  p: FamilyProgress | null;
  /** What your games say (openings you play). */
  r: Insight | null;
  recommended: boolean;
}

/** One list for what you learn and what you play (from 3 games): the ones most
 *  worth learning first, then the rest by what's due and how far you are. */
function myOpenings(): MyOpening[] {
  const recommended = new Set(
    insights
      .filter((r) => r.score > 0)
      .slice(0, MAX_RECOMMENDED)
      .map((r) => `${r.color}|${r.family}`),
  );
  const keys = new Set([...Object.keys(progress), ...insights.filter((r) => r.games >= 3).map((r) => `${r.color}|${r.family}`)]);
  return [...keys]
    .map((key) => {
      const [color, family] = key.split("|") as [Color, string];
      return { color, family, p: progress[key] ?? null, r: insightOf[key] ?? null, recommended: recommended.has(key) };
    })
    .sort(
      (a, b) =>
        Number(b.recommended) - Number(a.recommended) ||
        (b.recommended ? (b.r?.score ?? 0) - (a.r?.score ?? 0) : 0) ||
        (b.p?.due ?? 0) - (a.p?.due ?? 0) ||
        (b.p?.started ?? 0) - (a.p?.started ?? 0) ||
        (b.r?.games ?? 0) - (a.r?.games ?? 0) ||
        openingName(a.family).localeCompare(openingName(b.family)),
    );
}

/** One of your openings: how much of it your repertoire covers, and your games with it. Opens the tree. */
function openingRow({ color, family, recommended }: MyOpening): string {
  const sum = summaries[`${color}|${family}`];
  const cov = sum?.coverage ?? null;
  const state = !sum?.cards
    ? t("Noch nicht angefangen")
    : [
        cov != null ? t("{p} abgedeckt", { p: pct(cov) }) : tn(sum.cards, "1 Zug", "{n} Züge"),
        sum.gaps ? tn(sum.gaps, "1 Lücke", "{n} Lücken") : "",
        sum.due ? `<b>${t("{n} fällig", { n: sum.due })}</b>` : "",
        sum.weak ? `<span class="op-weak">${tn(sum.weak, "1 schwacher Zug", "{n} schwache Züge")}</span>` : "",
      ]
        .filter(Boolean)
        .join(" · ");
  return `<div class="op-mine-row op-open ${recommended ? "recommended" : ""}" data-color="${color}" data-family="${esc(family)}" role="button" tabindex="0" title="${t("Diese Eröffnung lernen")}">
    <span class="pdot ${color}"></span>
    <span class="op-mine-name"><b>${esc(openingName(family))}</b> <span class="muted">${t("als {side}", { side: SIDE[color] })}</span>${
      recommended ? ` <span class="op-badge" title="${t("Kommt in deinen Partien oft vor und du kennst noch wenig davon – oder du fällst hier oft aus der Theorie.")}">${t("Empfohlen")}</span>` : ""
    }</span>
    <span class="learn-bar" title="${t("Abdeckung auf deinem Niveau")}"><span class="lb-learned" style="width:${(cov ?? 0) * 100}%"></span></span>
    <span class="op-progress-text">${state}</span>
    ${gamesCell(color, family)}
    <span class="op-open-go" aria-hidden="true">›</span>
  </div>`;
}

/** "2,5 %" – how often a line comes up at your level. */
function pct(reach: number): string {
  const v = reach * 100;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: v < 1 ? 1 : 0 })} %`;
}

/** One line in the variation list (also the rare ones). */
function lineButton(l: LineInfo, current: string | null, title: string, state: string): string {
  const how = [
    l.reach != null ? t("auf deinem Niveau in {p} der Partien", { p: pct(l.reach) }) : "",
    l.inGames ? t("kam in deinen Partien vor") : "",
  ].filter(Boolean);
  return `<button class="var-line ${l.id === current ? "current" : ""} ${focus!.line === l.id ? "selected" : ""}" data-line="${esc(l.id)}" title="${esc([title, ...how].join(" · "))}">
    ${pips(l.boxLevel)}
    <span class="line-name">${esc(varName(l.name))}${l.inGames ? ` <span class="line-games" title="${t("kam in deinen Partien vor")}">●</span>` : ""}</span>
    <span class="line-state">${state}</span></button>`;
}

/** Where the course's lines come from (under the progress bar). */
function courseInfo(): string {
  if (!focus) return "";
  const r = prepared.get(`${focus.color}|${focus.family}`);
  if (detailRatings) {
    const note = r?.state === "partial" && r.error ? ` <span class="muted">${esc(r.error)}</span>` : "";
    return `<p class="panel-sub op-course-info">${t("Der Kurs enthält die Linien, die auf deinem Niveau (Lichess {ratings}) häufig vorkommen, und die aus deinen Partien.", { ratings: esc(detailRatings) })}${note}</p>`;
  }
  if (r?.state === "noToken") {
    return `<p class="panel-sub op-course-info">${t("Tipp: Mit einem Lichess-Schlüssel (Einstellungen) lernst du zuerst die Linien, die auf deinem Niveau wirklich gespielt werden – seltene Nebenvarianten kommen dann nicht mehr in den Kurs.")}</p>`;
  }
  return "";
}

/** A variation group's state in a few words. */
function groupState(g: VariationGroup): string {
  if (g.due) return `<b>${t("{n} fällig", { n: g.due })}</b>`;
  if (!g.started) return t("neu");
  if (g.learned === g.total) return t("sitzt ✓");
  if (g.total === 1) return t("im Lernen");
  return t("{l} von {n} sitzen", { l: g.learned, n: g.total });
}

function startDrill(d: Drill | null, tk: number) {
  drill = d;
  failed = false;
  hint = false;
  verdict = null;
  wrongTry = null;
  resultDue = null;
  resultBox = null;
  history = [];
  finished = false;
  deps.board.setShapes([]);
  showTheory(null);
  if (!d) {
    phase = "empty";
    render();
    return;
  }
  fen = d.fen;
  lastMove = undefined;
  step = 0;
  setupSound();
  renderSidebar();
  // First lesson of an opening: a short introduction before the first move.
  if (d.status === "new" && !(progress[`${d.color}|${familyOf(d)}`]?.started ?? 0)) {
    phase = "intro";
    const base = families.find((f) => f.name === familyOf(d));
    if (base) showTheory(base.fen);
    return render();
  }
  continueLine(tk);
}

const familyOf = (d: Drill) => d.name.split(":")[0].trim();

/** "Weiter" in the lesson: start it, or show the opponent's next move. */
function advance() {
  if (phase === "intro") {
    showTheory(null);
    return continueLine(token);
  }
  if (phase === "next") opponentMove(token, 0);
}

async function loadNext() {
  const tk = ++token;
  clearTimeout(timer);
  // Consolidation: replay the line just learned until it sits.
  if (consolidate) {
    return startDrill({ ...consolidate.line, status: "practice" }, tk);
  }
  phase = "loading";
  render();
  let d: Drill | null;
  try {
    const mode = trainMode === "learn" ? "repertoire" : trainMode;
    d = await invoke<Drill | null>("opening_next", { accounts: deps.accounts(), last: windowLast(), mode, focus });
  } catch (e) {
    if (tk !== token) return;
    phase = "empty";
    render(String(e));
    return;
  }
  if (tk !== token) return;
  startDrill(d, tk);
}

/** Play the opponent's moves until it's your turn (or the line is over). */
function continueLine(tk: number) {
  const d = drill!;
  if (!sequential(d)) {
    phase = "solve";
    return render();
  }
  if (step >= d.moves.length) return finish(tk);
  // A repertoire move: the moves before it come quickly, both sides.
  if (d.kind === "move" && step < (d.askFrom ?? 0)) return opponentMove(tk, step === 0 ? 400 : PRELUDE_MS);
  if (sideOf(fen) === d.color) {
    phase = "solve";
    return render();
  }
  // In a lesson the opponent's move waits for "Weiter" (time to read).
  if (learning()) {
    phase = "next";
    return render();
  }
  opponentMove(tk, step === 0 ? 500 : deps.animMs() + 250);
}

function opponentMove(tk: number, delay: number) {
  const d = drill!;
  phase = "opponent";
  render();
  const n = nav;
  timer = window.setTimeout(async () => {
    if (tk !== token || n !== nav) return;
    const played = await play(fen, d.moves[step]);
    if (tk !== token || n !== nav) return;
    history.push({ fen, lastMove, step });
    fen = played.fen;
    lastMove = played.uci;
    moveSound(played.san);
    step++;
    // While learning, explain every move; otherwise only your own (so the
    // text doesn't give away the answer you're asked for).
    if (learning()) showTheory(fen, moveText(step - 1, played.san));
    continueLine(tk);
  }, delay);
}

/** "Schwarz spielt 1…c5." – shown in a lesson when Wikibooks has nothing. */
function moveText(ply: number, san: string): string {
  const n = Math.floor(ply / 2) + 1;
  const move = `<b>${n}${ply % 2 ? "…" : ". "}${esc(fig(san))}</b>`;
  return t("{side} spielt {move}.", { side: SIDE[ply % 2 ? "black" : "white"], move });
}

function play(from: string, uci: string): Promise<PlayedMove> {
  return invoke<PlayedMove>("play_move", { fen: from, from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

export async function openingMove(orig: Key, dest: Key, promotion?: string) {
  if (trainMode === "explore") return explorerMove(orig, dest, promotion);
  if (trainMode === "tree") return treeMove(orig, dest, promotion);
  if (trainMode === "spar") return sparMove(orig, dest, promotion);
  const d = drill;
  if (!d || (phase !== "solve" && phase !== "wrong")) return render();
  const tk = token;
  const n = nav;
  const expected = d.moves[step];
  const promo = expected && expected.slice(0, 4) === orig + dest ? expected[4] : promotion;
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: orig, to: dest, promotion: promo });
  } catch {
    return render();
  }
  if (tk !== token || n !== nav) return;

  if (played.uci === expected) return correct(played, tk);
  // Your mistakes and your own cards: any good move counts, not only the engine's.
  if (d.kind === "own" || d.kind === "card") {
    phase = "checking";
    showTry(played);
    try {
      verdict = await invoke<MoveReview>("evaluate_move", { fen, uci: played.uci });
    } catch {
      verdict = null;
    }
    if (tk !== token) return;
    if (verdict && ACCEPTED.includes(verdict.classification)) return correct(played, tk);
  }
  if (!learning()) failed = true;
  wrongTry = played;
  phase = "wrong";
  errorSound();
  showTry(played);
  timer = window.setTimeout(() => {
    if (tk === token && phase === "wrong") render();
  }, 900);
}

function correct(played: PlayedMove, tk: number) {
  moveSound(played.san);
  history.push({ fen, lastMove, step });
  fen = played.fen;
  lastMove = played.uci;
  step++;
  wrongTry = null;
  hint = false;
  if (!sequential(drill!)) return finish(tk);
  showTheory(fen, learning() ? moveText(step - 1, played.san) : undefined);
  continueLine(tk);
}

/** Show the correct move (counts as a mistake) and carry on. */
async function showMove() {
  const d = drill;
  if (!d || !d.moves[step]) return;
  const tk = token;
  const n = nav;
  if (!learning()) failed = true;
  const played = await play(fen, d.moves[step]);
  if (tk !== token || n !== nav) return;
  correct(played, tk);
}

async function finish(tk: number) {
  const d = drill!;
  phase = "done";
  if (!failed) successSound();
  // Replayed after "Zurück": the result already counts.
  if (finished) return render();
  finished = true;
  planProgress(d, !failed);

  enteredBox = false;
  if (d.status === "practice" && consolidate) {
    // Consolidation run: count clean runs in a row. The first one without a
    // mistake puts a new line into the flashcard box; nothing else is recorded.
    consolidate.runs++;
    consolidate.clean = failed ? 0 : consolidate.clean + 1;
    const enter = !failed && !consolidate.recorded;
    if (enter) consolidate.recorded = enteredBox = true;
    if (consolidate.clean >= CONSOLIDATE_RUNS || consolidate.runs >= CONSOLIDATE_MAX) {
      // Without a single clean run the line stays new (comes again with arrows).
      endedInBox = consolidate.recorded;
      consolidate = null;
    }
    render();
    if (!enter) return;
    await record(d, true, tk);
    await Promise.all([loadProgress(), loadVariations()]);
    if (tk !== token) return;
    renderSidebar();
    renderText();
    return;
  }

  render();
  // A new line only counts once you've played it without arrows (above);
  // a forgotten one goes back to box 1 right away.
  if (d.status !== "new") await record(d, d.status === "relearn" ? false : !failed, tk);
  if (tk !== token) return;
  // A line was just taught: consolidate it right away (without arrows).
  if (learning()) consolidate = { line: { ...d, status: "new" }, clean: 0, runs: 0, recorded: d.status === "relearn" };
  await Promise.all([loadProgress(), loadVariations()]);
  if (tk !== token) return;
  renderSidebar();
  renderText();
}

/** Store a drill's result (Leitner box) and show where the card went. */
async function record(d: Drill, success: boolean, tk: number) {
  try {
    const r = await invoke<{ boxLevel: number; due: number; status: Status }>("opening_record", { id: d.id, color: d.color, success });
    if (tk !== token) return;
    resultBox = r.boxLevel;
    resultDue = r.due;
    status = r.status;
  } catch (e) {
    console.error(e);
  }
}

/** Forgotten the line: start it over with arrows (the card goes back to box 1). */
function relearn() {
  const d = drill;
  if (!d || d.kind !== "line") return;
  const tk = ++token;
  clearTimeout(timer);
  consolidate = null;
  startDrill({ ...d, status: "relearn" }, tk);
}

/** Index of the last position in the history where it was your move. */
function backTarget(): number {
  const d = drill;
  if (!d || d.kind !== "line") return -1;
  for (let i = history.length - 1; i >= 0; i--) if (sideOf(history[i].fen) === d.color) return i;
  return -1;
}

/** "Zurück": take back your last move (and the opponent's answer). Doesn't count as a mistake. */
function back() {
  const i = backTarget();
  if (i < 0 || phase === "loading" || phase === "checking") return;
  const h = history[i];
  history.length = i;
  nav++;
  clearTimeout(timer);
  fen = h.fen;
  lastMove = h.lastMove;
  step = h.step;
  wrongTry = null;
  verdict = null;
  hint = false;
  phase = "solve";
  deps.board.cancelMove();
  showTheory(learning() ? fen : null);
  render();
}

/**
 * Show the explanation of a position, if Wikibooks has one: the first
 * paragraph (usually about the move just played), the rest folded away.
 * `fallback` is shown instead when there is no text (lesson: "Weiß spielt …").
 */
async function showTheory(f: string | null, fallback?: string) {
  theoryFen = f;
  const box = $("op-theory");
  if (!f) {
    stopSpeech();
    box.hidden = true;
    return;
  }
  let text = theoryCache.get(f);
  if (text === undefined) {
    text = await invoke<OpeningText | null>("opening_text", { fen: f }).catch(() => null);
    theoryCache.set(f, text);
  }
  if (theoryFen !== f) return;
  if (!text) {
    if (fallback) {
      stopSpeech();
      box.innerHTML = `<h3>${t("Eröffnungstheorie")}</h3><div class="op-theory-text"><p>${fallback}</p></div>`;
      box.hidden = false;
    }
    // Otherwise keep the previous text: it still describes the line.
    return;
  }
  // Reading aloud is about the text on screen: another text stops it.
  if (speakingKey() !== f) stopSpeech();
  const [first, ...rest] = text.paragraphs.map((p) => `<p>${esc(fig(p))}</p>`);
  box.innerHTML = `
    <h3><span>${t("Eröffnungstheorie")}${text.untranslated ? ` <span class="muted">${t("(englisch)")}</span>` : ""}</span>
      <button class="op-speak" hidden></button></h3>
    <div class="op-speak-offer" hidden></div>
    <div class="op-theory-text">${first ?? ""}${rest.length ? `<details><summary>${t("mehr dazu")}</summary>${rest.join("")}</details>` : ""}</div>
    <p class="op-theory-source">${t("Quelle:")} <a href="#" data-url="${esc(text.url)}">Wikibooks – Chess Opening Theory</a> · CC BY-SA 4.0</p>`;
  box.hidden = false;
  box.querySelector<HTMLElement>(".op-theory-text")!.scrollTop = 0;
  box.querySelector("a[data-url]")!.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("open_opening_source", { url: text.url }).catch(console.error);
  });
  const speakBtn = box.querySelector<HTMLButtonElement>(".op-speak")!;
  speakBtn.dataset.key = f;
  speakBtn.addEventListener("click", () => {
    if (speakingKey() === f) stopSpeech();
    else readAloud(f, text, false);
  });
  renderSpeakButton();
  renderSpeakOffer();
  if (await speechUsable()) speakBtn.hidden = false;
}

// --- reading the theory text aloud -------------------------------------------

/** The question "download the natural voice?" and the download (null: nothing to show). */
let speakOffer:
  | null
  | { state: "ask"; lang: SpeechLang; mb: number; voice: string; system: boolean }
  | { state: "download"; lang: SpeechLang; done: number; total: number }
  | { state: "error"; lang: SpeechLang; message: string; system: boolean } = null;
/** "Use the system voice" was chosen (until the app restarts). */
let useSystemVoice = false;
let usable: Promise<boolean> | null = null;

/** Can anything read aloud here (a natural voice to download, or a system voice)? Asked once. */
function speechUsable(): Promise<boolean> {
  usable ??= speechStatus("de")
    .then((st) => st.piper.supported || st.system)
    .catch(() => false);
  return usable;
}

/** What the box shows: the first paragraph, the rest only if "mehr dazu" is open. */
function visibleParagraphs(text: OpeningText): string[] {
  const open = document.querySelector<HTMLDetailsElement>("#op-theory .op-theory-text details")?.open ?? false;
  return open ? text.paragraphs : text.paragraphs.slice(0, 1);
}

function textLang(text: OpeningText): SpeechLang {
  return text.untranslated || lang === "en" ? "en" : "de";
}

/**
 * Read the text aloud with the natural voice if it's downloaded; else offer
 * the download (or use the system voice, if chosen). `afterDownload`: never ask again.
 */
async function readAloud(f: string, text: OpeningText, afterDownload: boolean) {
  const language = textLang(text);
  const st = await speechStatus(language).catch(() => null);
  if (!st) return;
  const engine = st.piper.installed ? "piper" : (useSystemVoice || !st.piper.supported || afterDownload) && st.system ? "system" : null;
  if (engine) {
    speakOffer = null;
    renderSpeakOffer();
    speak(f, visibleParagraphs(text).join("\n"), language, engine).catch((e) => {
      speakOffer = { state: "error", lang: language, message: String(e), system: st.system && engine === "piper" };
      renderSpeakOffer();
    });
    return;
  }
  if (!st.piper.supported) return;
  speakOffer = { state: "ask", lang: language, mb: Math.ceil(st.piper.downloadSize / 1e6), voice: st.piper.voice, system: st.system };
  renderSpeakOffer();
}

async function downloadVoice(language: SpeechLang) {
  speakOffer = { state: "download", lang: language, done: 0, total: 0 };
  renderSpeakOffer();
  try {
    await installVoice(language, (done, total) => {
      if (speakOffer?.state !== "download") return;
      speakOffer.done = done;
      speakOffer.total = total;
      renderSpeakOffer();
    });
  } catch (e) {
    const message = String(e);
    speakOffer = message === "cancelled" ? null : { state: "error", lang: language, message, system: false };
    renderSpeakOffer();
    return;
  }
  speakOffer = null;
  renderSpeakOffer();
  // Read the text that is on screen now.
  const f = theoryFen;
  const text = f ? theoryCache.get(f) : null;
  if (f && text && textLang(text) === language) readAloud(f, text, true);
}

function renderSpeakOffer() {
  const box = document.querySelector<HTMLElement>("#op-theory .op-speak-offer");
  if (!box) return;
  const o = speakOffer;
  box.hidden = !o;
  if (!o) {
    box.innerHTML = "";
    return;
  }
  const systemBtn = (show: boolean) => (show ? `<button data-act="system">${t("Systemstimme verwenden")}</button>` : "");
  if (o.state === "ask") {
    box.innerHTML = `
      <p>${t("Für eine natürliche Vorlesestimme („{voice}“) werden einmalig ca. <b>{mb} MB</b> heruntergeladen.", { voice: esc(o.voice), mb: o.mb })}</p>
      <div class="op-speak-actions">
        <button class="primary" data-act="download">${t("Herunterladen")}</button>
        ${systemBtn(o.system)}
        <button class="link" data-act="close">${t("Abbrechen")}</button>
      </div>`;
  } else if (o.state === "download") {
    const mb = (b: number) => Math.round(b / 1e6);
    box.innerHTML = `
      <p>${o.total ? t("Stimme wird heruntergeladen … {done} von {total} MB", { done: mb(o.done), total: mb(o.total) }) : t("Stimme wird heruntergeladen …")}</p>
      <div class="op-speak-actions">
        <progress max="${o.total || 1}" value="${o.done}"></progress>
        <button class="link" data-act="cancel">${t("Abbrechen")}</button>
      </div>`;
  } else {
    box.innerHTML = `
      <p class="error">${esc(o.message)}</p>
      <div class="op-speak-actions">
        <button data-act="download">${t("Nochmal versuchen")}</button>
        ${systemBtn(o.system)}
        <button class="link" data-act="close">${t("Schließen")}</button>
      </div>`;
  }
  box.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "download") downloadVoice(o.lang);
      else if (act === "cancel") cancelVoiceInstall();
      else {
        speakOffer = null;
        renderSpeakOffer();
        if (act === "system") {
          useSystemVoice = true;
          const f = theoryFen;
          const text = f ? theoryCache.get(f) : null;
          if (f && text) readAloud(f, text, false);
        }
      }
    }),
  );
}

/** 🔊 / ⏹ on the theory text, depending on whether it is being read. */
function renderSpeakButton() {
  const btn = document.querySelector<HTMLButtonElement>("#op-theory .op-speak");
  if (!btn) return;
  const on = speakingKey() !== null && speakingKey() === btn.dataset.key;
  btn.textContent = on ? "⏹" : "🔊";
  btn.title = on ? t("Vorlesen beenden") : t("Vorlesen");
  btn.classList.toggle("on", on);
}

onSpeechChange(renderSpeakButton);

function showTry(played: PlayedMove) {
  deps.board.set({
    fen: played.fen,
    lastMove: [sq(played.uci, true), sq(played.uci, false)],
    check: played.check,
    movable: { color: undefined, dests: new Map() },
  });
  renderText();
}

// ---------------------------------------------------------------------------
// rendering the drill

function render(error?: string) {
  if (!active || view !== "train" || trainMode === "explore") return;
  if (trainMode === "tree") return renderTree();
  if (trainMode === "spar") return renderSpar();
  const d = drill;
  if (d && phase !== "loading" && phase !== "empty") {
    const shapes: DrawShape[] = [];
    const expected = d.moves[step];
    if (hint && phase === "solve" && expected) shapes.push({ orig: sq(expected, true), brush: "green" });
    // Learning a new line: show every move you're supposed to play.
    if (learning() && phase === "solve" && expected) {
      shapes.push({ orig: sq(expected, true), dest: sq(expected, false), brush: "green" });
    }
    // After a wrong try in a repertoire line, show the right move as an arrow.
    if (phase === "wrong" && sequential(d) && expected) {
      shapes.push({ orig: sq(expected, true), dest: sq(expected, false), brush: "green" });
    }
    deps.board.set({
      fen,
      orientation: d.color,
      turnColor: sideOf(fen),
      lastMove: lastMove ? [sq(lastMove, true), sq(lastMove, false)] : undefined,
      check: false,
      movable: { color: undefined, dests: new Map() },
    });
    deps.board.setAutoShapes(shapes);
    if (phase === "solve" || phase === "wrong") {
      const tk = token;
      invoke<PositionInfo>("position_info", { fen }).then((info) => {
        if (tk !== token || !active || (phase !== "solve" && phase !== "wrong")) return;
        deps.board.set({ movable: { color: d.color, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
      });
    }
  }
  renderText(error);
}

function relDays(due: number): string {
  const minutes = Math.round((due - Date.now()) / 60_000);
  if (minutes < 60) return minutes <= 1 ? t("gleich") : t("in {n} Minuten", { n: minutes });
  const days = Math.round(minutes / 1440);
  if (days <= 1) return t("morgen");
  return t("in {n} Tagen", { n: days });
}

/** "Zug 5 von 9" plus a marker where the named theory ends. */
function lineProgress(d: Drill): string {
  if (d.kind !== "line") return "";
  const mine = d.moves.filter((_, i) => (i % 2 === 0) === (d.color === "white")).length;
  const done = d.moves.slice(0, step).filter((_, i) => (i % 2 === 0) === (d.color === "white")).length;
  const engine = step >= d.bookLen && d.moves.length > d.bookLen;
  const mark = engine
    ? ` · <span class="engine-mark" title="${t("Die benannte Theorie ist zu Ende; ab hier die beste Fortsetzung laut Stockfish")}">${t("Engine-Fortsetzung")}</span>`
    : "";
  return `<span class="muted">${t("Zug {i} von {n}", { i: Math.min(done + 1, mine), n: mine })}${mark}</span>`;
}

/** Where a card comes from. */
function cardOrigin(c: Card): string {
  const date = new Date(c.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
  const from = c.source === "review" ? t("aus einer Review") : c.source === "play" ? t("aus einer Partie gegen Stockfish") : t("aus „Erkunden“");
  return `${from} <span class="muted">· ${date}</span>`;
}

/** The best moves of a card, after you've played. */
function bestMovesHtml(c: Card): string {
  return `<div class="card-best"><div class="muted">${t("Beste Züge laut Stockfish:")}</div>
    <ol>${c.best
      .map((b) => `<li><b>${esc(fig(b.san))}</b> <span class="card-score">${scoreText(b.score)}</span> <span class="muted">${esc(fig(b.line))}</span></li>`)
      .join("")}</ol>
    ${c.played ? `<div class="muted">${t("Damals gespielt: {move}", { move: `<b>${esc(fig(c.played))}</b>` })}</div>` : ""}</div>`;
}

function renderText(error?: string) {
  if (!active || view !== "train") return;
  if (trainMode === "tree") return renderTreeDetail();
  if (trainMode === "spar") return renderSparText();
  const head = $("op-head");
  const text = $("op-text");
  const extra = $("op-extra");
  const actions = $("op-actions");
  extra.innerHTML = "";
  const d = drill;

  if (phase === "loading") {
    head.innerHTML = `<span class="muted">${t("Bereite die nächste Linie vor …")}</span>`;
    text.innerHTML = "";
    actions.innerHTML = "";
    return;
  }
  if (phase === "empty" || !d) {
    const title = trainMode === "due" ? t("Alles wiederholt") : trainMode === "own" ? t("Nichts offen") : t("Alles gelernt");
    head.innerHTML = `<span class="coach-title">${title}</span>`;
    text.innerHTML = error
      ? `<span class="error">${esc(error)}</span>`
      : trainMode === "due"
        ? t("Für heute ist nichts mehr fällig. Die Karten kommen zur rechten Zeit wieder.")
        : trainMode === "own"
          ? t("Gerade keine Eröffnungsfehler aus deinen Partien fällig – gelöste Stellungen ruhen eine Weile.")
          : t("Alle Varianten hier sind gelernt und gerade nichts fällig. Die Wiederholungen kommen zur rechten Zeit – oder wähl rechts eine andere Variante.");
    actions.innerHTML = `${trainMode === "due" && ownCount ? `<button data-act="own">${t("Fehler aus deinen Partien üben ({n})", { n: ownCount })}</button>` : ""}<button data-act="home" class="primary end">${t("Zur Übersicht")}</button>`;
    bindActions(d);
    return;
  }

  const tag =
    d.kind === "card"
      ? `<span class="pz-tag own">${t("Deine Karte")}</span>`
      : d.kind === "own"
      ? `<span class="pz-tag own">${t("Aus deiner Partie")}</span>`
      : d.status === "new" || d.status === "relearn"
        ? `<span class="pz-tag mixed">${d.status === "relearn" ? t("Nochmal lernen") : t("Neu lernen")}</span>`
        : d.status === "practice"
          ? `<span class="pz-tag op-practice-tag">${t("Festigen")} ${(consolidate?.clean ?? 0) + (phase === "done" ? 0 : 1)}/${CONSOLIDATE_RUNS}</span>`
          : `<span class="pz-tag op-review">${t("Wiederholung")}</span>`;
  const shortName = varName(d.name.includes(":") ? d.name.split(":").slice(1).join(":").trim() : d.name);
  head.innerHTML = d.card
    ? `${tag}<span class="op-name">${cardOrigin(d.card)}</span>`
    : `${tag}<span class="op-name" title="${esc(openingName(d.name))}">${esc(d.kind === "move" && !d.name ? t("Dein Repertoire") : focus ? shortName : openingName(d.name))}</span>`;

  const side = SIDE[d.color];
  const expected = d.moves[step];
  switch (phase) {
    case "intro":
      text.innerHTML = `${t("<b>So geht die Lektion:</b> Mit <b>Weiter</b> siehst du den nächsten Zug deines Gegners, deine eigenen Züge spielst du selbst nach dem grünen Pfeil. Unten steht zu jedem Zug, worum es geht.")}<br>${lineProgress(d)}`;
      break;
    case "next":
      text.innerHTML = `${t("Lies die Erklärung unten, dann weiter mit <b>Weiter</b> (oder →).")}<br>${lineProgress(d)}`;
      break;
    case "opponent":
      text.innerHTML =
        d.kind === "move"
          ? `<span class="muted">${t("Die Züge bis zur Stellung …")}</span>`
          : `<span class="muted">${t("Der Gegner zieht …")}</span><br>${lineProgress(d)}`;
      break;
    case "solve":
      if (d.card) {
        text.innerHTML = `<b>${t("{side} am Zug.", { side })}</b> ${t("Was spielst du hier?")}${
          d.card.played ? ` <span class="muted">${t("Damals kam {move}.", { move: `<b>${esc(fig(d.card.played))}</b>` })}</span>` : ""
        }`;
      } else if (d.kind === "own" && d.own) {
        const num = Math.ceil(d.own.ply / 2) + (d.own.ply % 2 ? "." : "...");
        text.innerHTML = t("Gegen {name} hast du hier {move} gespielt – {phrase}. Was ist besser?", {
          name: esc(playerName(d.own.opponent)),
          move: `<b>${num} ${esc(fig(d.own.san))}</b>`,
          phrase: CLASSES[d.own.classification].phrase,
        });
      } else if (learning()) {
        text.innerHTML = `${t("<b>Du bist dran:</b> spiel den grünen Pfeil nach.")}<br>${lineProgress(d)}`;
      } else if (d.status === "practice") {
        text.innerHTML = `${t("<b>Jetzt ohne Pfeile:</b> spiel die Linie, die du gerade gelernt hast.")}<br>${lineProgress(d)}`;
      } else {
        text.innerHTML = `<b>${t("{side} am Zug.", { side })}</b> ${t("Welcher Zug gehört zu deinem Repertoire?")}${d.status === "early" ? ` <span class="muted">${t("(vorgezogen)")}</span>` : ""}<br>${lineProgress(d)}`;
      }
      if (hint && expected) text.innerHTML += `<br><span class="hint-text">${t("Tipp: Zieh von {square}.", { square: expected.slice(0, 2) })}</span>`;
      break;
    case "checking":
      text.innerHTML = `<span class="muted">${t("Prüfe deinen Zug …")}</span>`;
      break;
    case "wrong":
      if (d.kind === "move") {
        text.innerHTML = t("{move} ist nicht dein Zug in dieser Stellung. Der grüne Pfeil zeigt deinen Repertoire-Zug – spiel ihn nach.", {
          move: `<b>${esc(fig(wrongTry?.san ?? ""))}</b>`,
        });
      } else if (d.kind === "line" && learning()) {
        text.innerHTML = t("Das ist nicht der markierte Zug – spiel den grünen Pfeil nach.");
      } else if (d.kind === "line") {
        text.innerHTML = t("{move} gehört nicht zu dieser Linie. Der grüne Pfeil zeigt den richtigen Zug – spiel ihn nach.", {
          move: `<b>${esc(fig(wrongTry?.san ?? ""))}</b>`,
        });
      } else {
        text.innerHTML = verdict
          ? `${badgeHtml(verdict.classification)} ${t("{move} ist {phrase}", { move: `<b>${esc(fig(verdict.san))}</b>`, phrase: CLASSES[verdict.classification].phrase })}. ${esc(fig(commentOf(verdict)))} <span class="muted">${t("Versuch es nochmal.")}</span>`
          : `${t("Das ist nicht besser.")} <span class="muted">${t("Versuch es nochmal.")}</span>`;
      }
      break;
    case "done": {
      if (d.status === "practice") {
        text.innerHTML = consolidate
          ? failed
            ? t("Noch nicht ganz – <b>nochmal</b>. Zweimal fehlerfrei hintereinander, dann hast du sie drin.")
            : enteredBox
              ? t("<b class=\"ok\">Fehlerfrei!</b> Die Linie ist jetzt in deinem Karteikasten. Noch einmal zum Festigen.")
              : t("<b class=\"ok\">Fehlerfrei!</b> Noch einmal, dann hast du sie drin.")
          : endedInBox
            ? t("<b class=\"ok\">Eingeprägt.</b> Die Karte liegt jetzt in Fach 1 deines Karteikastens und kommt in 10 Minuten wieder.")
            : t("<b>Noch nicht drin.</b> Die Linie kommt noch nicht in den Karteikasten – beim nächsten Mal lernst du sie noch einmal mit Pfeilen.");
      } else if (learning()) {
        text.innerHTML =
          d.status === "new"
            ? t("<b class=\"ok\">Linie gezeigt.</b> Jetzt spielst du sie ohne Pfeile. Klappt sie einmal ohne Fehler, kommt sie in den Karteikasten.")
            : t("<b class=\"ok\">Linie gezeigt.</b> Jetzt spielst du sie ohne Pfeile, bis sie zweimal hintereinander klappt.");
      } else {
        const when = resultDue ? relDays(resultDue) : "";
        text.innerHTML = failed
          ? t("<b>Geschafft</b> – mit Fehlern. Die Karte geht zurück in Fach 1 und kommt <b>{when}</b> wieder.", { when: when || t("bald") })
          : resultBox && resultBox >= 3
            ? t("<b class=\"ok\">Richtig!</b> Die Karte rutscht in Fach {n} von 5 – <b>sie sitzt</b>. Wieder <b>{when}</b>.", { n: resultBox, when: when || "…" })
            : t("<b class=\"ok\">Richtig!</b> Die Karte rutscht in Fach {n} von 5 und kommt <b>{when}</b> wieder.", { n: resultBox ?? 1, when: when || "…" });
      }
      if (d.own) extra.innerHTML = `<span class="muted">${t("In der Partie:")}</span> ${esc(fig(d.own.comment))}`;
      if (d.card) extra.innerHTML = bestMovesHtml(d.card);
      break;
    }
  }
  if (d.kind === "move" && (phase === "done" || phase === "wrong")) ideaBox(d, extra);

  const game = d.own || d.card?.gameId ? `<button data-act="game">${t("Partie öffnen")}</button>` : "";
  // A mistake from your game: learn the whole opening line that leads there.
  const wholeLine = d.own && phase === "done" ? `<button data-act="line" title="${t("Die Eröffnungslinie bis zu dieser Stellung von Anfang an lernen")}">${t("Ganze Linie lernen")}</button>` : "";
  const backBtn =
    d.kind === "line"
      ? `<button data-act="back" title="${t("Deinen letzten Zug zurücknehmen (←)")}" ${backTarget() >= 0 && phase !== "checking" ? "" : "disabled"}>← ${t("Zurück")}</button>`
      : "";
  if (phase === "intro" || phase === "next") {
    actions.innerHTML = `${phase === "next" ? backBtn : ""}<button data-act="advance" class="primary end">${phase === "intro" ? t("Los geht's") : t("Weiter")} →</button>`;
    bindActions(d);
    return;
  }
  actions.innerHTML =
    phase === "done"
      ? `${backBtn}${game}${wholeLine}${d.kind === "line" && !learning() && failed ? `<button data-act="relearn">${t("Mit Pfeilen neu lernen")}</button>` : ""}<button data-act="next" class="primary end">${t("Weiter")} →</button>`
      : `${backBtn}${learning() ? "" : `<button data-act="hint" ${hint || phase !== "solve" ? "disabled" : ""}>${t("Tipp")}</button>`}
         ${learning() || d.kind !== "line" ? "" : `<button data-act="relearn" title="${t("Die Linie von vorn mit allen Pfeilen zeigen. Die Karte kommt zurück in Fach 1.")}">${t("Mit Pfeilen neu lernen")}</button>`}
         ${learning() ? "" : `<button data-act="show" ${phase === "solve" || phase === "wrong" ? "" : "disabled"}>${sequential(d) ? t("Zug zeigen") : t("Lösung zeigen")}</button>`}
         ${game}
         <button data-act="skip" class="end">${t("Überspringen")}</button>`;
  bindActions(d);
}

/** Your idea behind a repertoire move: shown after its card, or a field to write one. */
function ideaBox(d: Drill, el: HTMLElement) {
  const epd = d.id.slice(2);
  const note = notes[d.color][epd] ?? "";
  if (note) {
    el.innerHTML = `<p class="op-idea"><span class="op-idea-label">${t("Deine Idee:")}</span> ${esc(note)}</p>`;
    return;
  }
  if (phase !== "done") return;
  el.innerHTML = `<label class="op-idea op-idea-edit"><span class="op-idea-label">${t("Deine Idee zu diesem Zug")}</span>
    <input type="text" maxlength="300" placeholder="${t("Warum dieser Zug? Ein Satz reicht – z. B. „Läufer raus, bevor e6 ihn einsperrt“")}" /></label>`;
  const input = el.querySelector("input")!;
  const save = async () => {
    const v = input.value.trim();
    if (!v || notes[d.color][epd] === v) return;
    notes[d.color][epd] = v;
    await invoke("rep_set_note", { color: d.color, epd, note: v }).catch(console.error);
  };
  input.addEventListener("change", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
}

function bindActions(d: Drill | null) {
  $("op-actions")
    .querySelectorAll<HTMLButtonElement>("button[data-act]")
    .forEach((b) =>
      b.addEventListener("click", () => {
        switch (b.dataset.act) {
          case "hint":
            hint = true;
            render();
            break;
          case "show":
            showMove();
            break;
          case "back":
            back();
            break;
          case "relearn":
            relearn();
            break;
          case "next":
            loadNext();
            break;
          case "skip":
            consolidate = null;
            loadNext();
            break;
          case "game":
            if (d?.own) deps.openGame(d.own.gameId, d.own.ply);
            else if (d?.card?.gameId) deps.openGame(d.card.gameId, d.card.ply ?? 0);
            break;
          case "advance":
            advance();
            break;
          case "line":
            if (d?.own) learnLineForGame(d.own.gameId, d.own.ply, d.color, d.name ? familyOf(d) : null);
            break;
          case "home":
            setView("home");
            break;
          case "own":
            startTrain("own", null);
            break;
        }
      }),
    );
}
