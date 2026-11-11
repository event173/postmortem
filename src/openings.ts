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

import { windowLast } from "./stats";
import { CLASSES, type Account, type Class, type MoveReview, type PlayedMove, type PositionInfo } from "./types";
import { playerName, t, tn } from "./i18n";
import { $, badgeHtml, commentOf, esc, fig, miniPieces } from "./util";
import { openingName } from "./opening-names";
import { errorSound, moveSound, setupSound, successSound } from "./sound";
import { explorerKey, explorerMove, explorerNav, startExplorer, stopExplorer } from "./explorer";
import { bindTheoryList, theoryListHtml, type TheoryReport } from "./theory-exits";

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

interface BestMove {
  uci: string;
  san: string;
  /** From your point of view. */
  score: { kind: "cp" | "mate" | "mated" | "won"; value?: number };
  line: string;
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
}

/** What the board is used for: learning (one opening), the due reviews, or your own mistakes. */
type TrainMode = "learn" | "due" | "own" | "explore" | "tree";
type View = "home" | "browse" | "train";
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
let summaries: Record<string, { coverage: number | null; gaps: number; cards: number; due: number }> = {};
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
  listen<{ color: Color; family: string; done: number; waiting: boolean }>("relevance-progress", (e) => {
    fetching = { key: `${e.payload.color}|${e.payload.family}`, done: e.payload.done, waiting: e.payload.waiting };
    if (trainMode === "tree" && view === "train") renderTreePanel();
    else if (phase === "loading") renderText();
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
  if (view !== "home") setView("home");
  else if (theory) renderHome();
}

/** The "Lernen" tab clicked again: back to the choice. */
export function openingsHome() {
  if (active && view !== "home") setView("home");
}

/** The buttons under the board, in "Erkunden" (false: not for us). */
export function openingNav(dir: "first" | "prev" | "next" | "last"): boolean {
  if (!active || view !== "train" || trainMode !== "explore") return false;
  explorerNav(dir);
  return true;
}

export function openingKey(e: KeyboardEvent): boolean {
  if (view !== "train") return false;
  if (trainMode === "explore") return explorerKey(e);
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
  if (v === "home") {
    renderHome();
    Promise.all([loadRepertoire(), loadProgress(), loadOwnCount(), loadCards(), loadRecs(), loadTheory()])
      .then(loadSummaries)
      .then(() => {
        renderHome();
        prepareInBackground();
      });
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

async function loadTheory() {
  theory = await invoke<TheoryReport>("theory_report", { accounts: deps.accounts(), last: windowLast() }).catch(() => null);
}

async function loadOwnCount() {
  try {
    ownCount = await invoke<number>("opening_own_count", { accounts: deps.accounts(), last: windowLast() });
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

/** In the background: the numbers for the openings you've started (this also
 *  takes rare, barely started lines out of the flashcards once) and for the
 *  suggestions (so they count the common lines, not all of them). */
async function prepareInBackground() {
  const keys = new Set([
    ...Object.entries(progress)
      .filter(([, p]) => p.started > 0)
      .map(([key]) => key),
    ...myOpenings()
      .filter((o) => o.recommended && o.r && !o.r.numbers)
      .map((o) => `${o.color}|${o.family}`),
  ]);
  let changed = false;
  for (const key of keys) {
    if (prepared.has(key)) continue;
    const [color, family] = key.split("|") as [Color, string];
    const r = await prepareRelevance(color, family);
    changed ||= !!r && (r.removed > 0 || r.state !== "noToken");
  }
  if (!changed) return;
  await Promise.all([loadRepertoire(), loadProgress(), loadRecs()]);
  await loadSummaries();
  renderHome();
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
    await addToRepertoire(f.color, f.family);
    if (!prepared.has(`${f.color}|${f.family}`)) {
      // First time this session: which lines are common at your level?
      const ready = prepareRelevance(f.color, f.family);
      token++;
      drill = null;
      phase = "loading";
      renderSidebar();
      render();
      await ready;
      if (focus !== f) return;
    }
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
  const begun = Object.values(progress).filter((p) => p.started > 0).length;
  const learnText = begun ? tn(begun, "1 begonnen", "{n} begonnen") : t("Eröffnung aussuchen");
  const tile = (go: string, icon: string, title: string, text: string, tip: string, opts: { hot?: boolean; off?: boolean } = {}) =>
    `<button class="op-tile ${opts.hot ? "hot" : ""}" data-go="${go}" title="${esc(tip)}" ${opts.off ? "disabled" : ""}>
      <span class="op-tile-icon">${icon}</span><b>${title}</b><span class="op-tile-text">${text}</span></button>`;

  const mine = myOpenings();

  $("op-home").innerHTML = `
    <div class="op-home-head">
      <h2>${t("Lernen")}</h2>
    </div>
    <div class="op-tiles">
      ${tile("due", ICON.due, t("Karteikasten"), dueText, t("Die Varianten und Karten wiederholen, die heute dran sind."), { hot: !!due, off: !due })}
      ${tile("own", ICON.own, t("Fehler aus deinen Partien"), ownText, t("Stellungen aus deinen Partien, in denen du in der Eröffnung danebengegriffen hast."), { off: !ownCount })}
      ${tile("learn", ICON.learn, t("Eröffnungen lernen"), learnText, t("Eröffnung und Farbe aussuchen. Dann Zug für Zug, mit Erklärung zu jedem Zug."))}
      ${tile("explore", ICON.explore, t("Erkunden"), t("Züge ausprobieren"), t("Welche Züge werden hier gespielt? Zug für Zug durchprobieren – mit deinen Partien, der Theorie und Lichess."))}
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
    <div class="op-home-mine">
      <h3>${t("Deine Eröffnungen")}</h3>
      ${
        mine.length
          ? `<p class="panel-sub">${t("Was du lernst und was du spielst (ab 3 Partien). Oben steht, wo sich Lernen am meisten lohnt. Ein Klick öffnet dein Repertoire in dieser Eröffnung.")}
               <span class="op-whole">${t("Ganzes Repertoire:")} <button class="link" data-whole="white">${t("Weiß")}</button> · <button class="link" data-whole="black">${t("Schwarz")}</button></span></p>
             <div class="op-mine-list">${mine.map(openingRow).join("")}</div>`
          : `<p class="muted">${t("Noch keine. Wähl oben „Eröffnungen lernen“.")}</p>`
      }
    </div>
    ${theoryHtml()}
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
  home.querySelector(".op-cards-toggle")?.addEventListener("click", () => {
    cardsOpen = !cardsOpen;
    renderHome();
  });
  home.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) =>
    b.addEventListener("click", () => {
      const go = b.dataset.go;
      if (go === "learn") setView("browse");
      else startTrain(go as TrainMode, null);
    }),
  );
  home.querySelectorAll<HTMLElement>(".op-mine-row[data-family]").forEach((row) => {
    const go = () => openTree(row.dataset.color as Color, row.dataset.family!);
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => e.key === "Enter" && go());
  });
  home.querySelectorAll<HTMLElement>("[data-whole]").forEach((b) => b.addEventListener("click", () => openTree(b.dataset.whole as Color, null)));
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
  const ok = confirm(
    t("Lernstand für {family} als {side} zurücksetzen? Alle Varianten fangen wieder bei „neu“ an – die Eröffnung bleibt in deiner Liste.", {
      family: openingName(family),
      side: SIDE[color],
    }),
  );
  if (!ok) return false;
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
      : trainMode === "due"
      ? t("Karteikasten")
      : trainMode === "own"
        ? t("Fehler aus deinen Partien")
        : focus
          ? t("Lernen: {family} als {side}", { family: esc(openingName(focus.family)), side: SIDE[focus.color] })
          : t("Lernen");
  $("op-top").innerHTML = `<button id="op-home-btn">← ${t("Übersicht")}</button><span class="op-top-title">${title}</span>`;
  $("op-home-btn").addEventListener("click", () => setView("home"));
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
  t("Wie Karteikarten: Jede Variante ist eine Karte. Spielst du sie richtig, rutscht sie ein Fach weiter und kommt später wieder (10 Min. → 1 Tag → 3 → 7 → 21 Tage). Ein Fehler schickt sie zurück in Fach 1. Ab Fach 3 sitzt sie.");

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
          <div class="muted op-meta">${esc(f.eco)} · ${tn(f.lines, "1 Variante", "{n} Varianten")}</div>
          ${mineText}
          <div class="op-card-actions">${side("white")}${side("black")}</div>
        </div>
      </div>`;
    })
    .join("");
  grid.querySelectorAll<HTMLElement>(".mini-board").forEach((el) => thumbObserver.observe(el));
  grid.querySelectorAll<HTMLElement>(".op-learn").forEach((b) =>
    b.addEventListener("click", () => startFocus(b.dataset.color as Color, b.dataset.family!)),
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
  if (trainMode === "explore" || trainMode === "tree") {
    $("op-focus").hidden = true;
    $("op-variations").hidden = true;
    return;
  }
  const focusEl = $("op-focus");
  const varsEl = $("op-variations");
  focusEl.hidden = !focus;
  varsEl.hidden = !focus;
  if (!focus) return;

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
export async function openTree(color: Color, family: string | null) {
  trainMode = "tree";
  focus = null;
  treeColor = color;
  treeFamily = treeHome = family;
  tree = null;
  treeSel = null;
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
}

function setTree(v: TreeView) {
  tree = v;
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
  const status = treeFetching
    ? `<p class="tree-status muted">${
        f?.waiting
          ? t("Lichess bittet um eine kurze Pause – in einer Minute geht es weiter …")
          : `${t("Hole bei Lichess, was auf deinem Niveau gespielt wird …")}${f ? ` ${tn(f.done, "1 Stellung geholt", "{n} Stellungen geholt")}` : ""}`
      }</p>`
    : v.error
      ? `<p class="tree-status muted">${esc(v.error)}</p>`
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
        ? `<span class="tree-state gap">${t("keine Antwort")}</span>`
        : `${pips(n.boxLevel)}<span class="tree-state ${n.due ? "due" : n.isNew ? "new" : ""}">${n.isNew ? t("neu") : n.due ? t("fällig") : n.boxLevel >= 3 ? t("sitzt") : t("im Lernen")}</span>`;
      return `<div class="tree-row ${n.id === treeSel ? "selected" : ""}" style="padding-left:${n.depth * 14}px">
        ${n.hasChildren ? `<button class="tree-caret" data-toggle="${esc(n.id)}" aria-label="${open ? t("Zuklappen") : t("Aufklappen")}">${open ? "▾" : "▸"}</button>` : `<span class="tree-caret"></span>`}
        <button class="tree-move" data-sel="${esc(n.id)}">${n.opp ? `<span class="tree-opp">${esc(fig(n.opp))}</span>` : ""}${
          n.gap ? `<span class="tree-gap">? ${t("Lücke")}</span>` : `<b>${esc(fig(n.mine ?? ""))}</b>`
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
      : "";
  el.innerHTML = `
    <div class="tree-head">
      <div class="tree-cov-row"><span>${t("Abdeckung auf deinem Niveau")}</span><b>${cov != null ? pct(cov) : "–"}</b></div>
      <div class="tree-cov"><i style="width:${(cov ?? 0) * 100}%"></i></div>
      <div class="muted tree-counts">${tn(v.gaps, "1 Lücke", "{n} Lücken")} · ${tn(v.cards, "1 Karte", "{n} Karten")} · ${t("{n} fällig", { n: v.due })}${v.ratings ? ` · Lichess ${esc(v.ratings)}` : ""}</div>
      ${status}
      <div class="tree-actions">
        ${v.gaps ? `<button class="primary" id="tree-next-gap">${t("Nächste Lücke")} →</button>` : `<span class="tree-ok">${t("Keine Lücken über 3 % ✓")}</span>`}
        ${treeHome ? `<button id="tree-course" title="${t("Die Eröffnung Zug für Zug mit Erklärungen lernen – was du lernst, kommt in dein Repertoire")}">${t("Mit dem Kurs lernen")}</button>` : ""}
        ${other}
      </div>
    </div>
    <div class="tree-rows">${rows || `<p class="muted">${t("Noch nichts in deinem Repertoire.")}</p>`}</div>
    <p class="panel-sub tree-legend">${t("Fett: dein Zug, einer pro Stellung. Davor der Zug des Gegners und wie oft er auf deinem Niveau kommt (Lichess). Kästchen: Fach im Karteikasten – eine Karte pro Zug.")}</p>
    ${
      treeHome
        ? `<div class="tree-foot">${
            progress[`${treeColor}|${treeHome}`]?.started
              ? `<button class="link" id="tree-reset">${t("Kurs-Lernstand zurücksetzen")}</button>`
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
  document.getElementById("tree-course")?.addEventListener("click", () => treeHome && startFocus(treeColor, treeHome));
  document.getElementById("tree-reset")?.addEventListener("click", async () => {
    if (treeHome && (await resetOpening(treeColor, treeHome))) renderTreePanel();
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
    text.innerHTML = `${
      n.reach != null
        ? t("Nach {moves} kommt das in {p} der Partien auf deinem Niveau – du hast noch keine Antwort.", { moves: `<b>${esc(path)}</b>`, p: pct(n.reach) })
        : t("Nach {moves} hast du noch keine Antwort.", { moves: `<b>${esc(path)}</b>` })
    } <b>${t("Was spielst du hier?")}</b> ${t("Spiel den Zug auf dem Brett oder wähl einen Vorschlag.")}`;
    extra.innerHTML = n.suggestions.length
      ? `<div class="tree-suggs">${n.suggestions
          .map(
            (s) =>
              `<button class="tree-sugg" data-uci="${esc(s.uci)}"><b>${esc(fig(s.san))}</b><span class="muted">${[
                s.share != null ? t("{p} der Partien", { p: pct(s.share) }) : "",
                s.book ? t("Theorie") : "",
              ]
                .filter(Boolean)
                .join(" · ")}</span></button>`,
          )
          .join("")}</div>`
      : "";
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
    extra.querySelectorAll<HTMLElement>("[data-uci]").forEach((b) => b.addEventListener("click", () => setTreeMove(b.dataset.uci!)));
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
  }<br><span class="muted">${card}${n.reach != null && n.depth > 0 ? ` · ${t("hierher kommen {p} der Partien", { p: pct(n.reach) })}` : ""}</span>`;
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
  if (n.alts.length) {
    parts.push(
      `<span class="muted">${t("Andere Züge hier: {moves} – nicht in deinem Repertoire.", {
        moves: n.alts.map((a) => `${esc(fig(a.san))} (${pct(a.share ?? 0)})`).join(", "),
      })}</span>`,
    );
  }
  extra.innerHTML = parts.join("");
  actions.innerHTML = `${exit ? `<button data-tree="game">${t("Partie ansehen")}</button>` : ""}<button data-tree="practise" class="primary">${t("Diese Karte üben")}</button>`;
  actions.querySelector("[data-tree=practise]")!.addEventListener("click", () => practiseMove(n));
  actions.querySelector("[data-tree=game]")?.addEventListener("click", () => exit && deps.openGame(exit.gameId, exit.ply - 1));
}

function renderTreeBoard() {
  const n = treeNode(treeSel);
  if (!n) return;
  const shown = n.gap ? n.fen : (n.fenAfter ?? n.fen);
  const last = n.gap ? n.oppUci : n.mineUci;
  deps.board.set({
    fen: shown,
    orientation: treeColor,
    turnColor: sideOf(shown),
    lastMove: last ? [sq(last, true), sq(last, false)] : undefined,
    check: false,
    movable: { color: undefined, dests: new Map() },
  });
  deps.board.setAutoShapes([]);
  if (n.gap) {
    // A gap: play your answer on the board.
    const id = n.id;
    invoke<PositionInfo>("position_info", { fen: n.fen }).then((info) => {
      if (trainMode !== "tree" || treeSel !== id) return;
      deps.board.set({ movable: { color: treeColor, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
    });
  }
}

async function treeMove(orig: Key, dest: Key, promotion?: string) {
  const n = treeNode(treeSel);
  if (!n?.gap) return renderTreeBoard();
  try {
    const played = await invoke<PlayedMove>("play_move", { fen: n.fen, from: orig, to: dest, promotion });
    moveSound(played.san);
    await setTreeMove(played.uci);
  } catch {
    renderTreeBoard();
  }
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
  return `<span class="op-games muted">${tn(g.games, "1 Partie", "{n} Partien")}${errors}</span>`;
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
      ]
        .filter(Boolean)
        .join(" · ");
  return `<div class="op-mine-row op-open ${recommended ? "recommended" : ""}" data-color="${color}" data-family="${esc(family)}" role="button" tabindex="0" title="${t("Dein Repertoire in dieser Eröffnung öffnen")}">
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
      box.innerHTML = `<h3>${t("Eröffnungstheorie")}</h3><div class="op-theory-text"><p>${fallback}</p></div>`;
      box.hidden = false;
    }
    // Otherwise keep the previous text: it still describes the line.
    return;
  }
  const [first, ...rest] = text.paragraphs.map((p) => `<p>${esc(fig(p))}</p>`);
  box.innerHTML = `
    <h3>${t("Eröffnungstheorie")}${text.untranslated ? ` <span class="muted">${t("(englisch)")}</span>` : ""}</h3>
    <div class="op-theory-text">${first ?? ""}${rest.length ? `<details><summary>${t("mehr dazu")}</summary>${rest.join("")}</details>` : ""}</div>
    <p class="op-theory-source">${t("Quelle:")} <a href="#" data-url="${esc(text.url)}">Wikibooks – Chess Opening Theory</a> · CC BY-SA 4.0</p>`;
  box.hidden = false;
  box.querySelector<HTMLElement>(".op-theory-text")!.scrollTop = 0;
  box.querySelector("a[data-url]")!.addEventListener("click", (e) => {
    e.preventDefault();
    invoke("open_opening_source", { url: text.url }).catch(console.error);
  });
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

// ---------------------------------------------------------------------------
// rendering the drill

function render(error?: string) {
  if (!active || view !== "train" || trainMode === "explore") return;
  if (trainMode === "tree") return renderTree();
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

/** Evaluation from your point of view: "+0,4", "−1,2", "Matt in 3". */
function scoreText(s: BestMove["score"]): string {
  if (s.kind === "mate") return (s.value ?? 0) > 0 ? t("Matt in {n}", { n: s.value ?? 0 }) : t("wird matt in {n}", { n: -(s.value ?? 0) });
  if (s.kind === "won") return t("Matt");
  if (s.kind === "mated") return t("matt");
  const v = (s.value ?? 0) / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
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
  const head = $("op-head");
  const text = $("op-text");
  const extra = $("op-extra");
  const actions = $("op-actions");
  extra.innerHTML = "";
  const d = drill;

  if (phase === "loading") {
    const key = focus ? `${focus.color}|${focus.family}` : "";
    if (focus && preparing.has(key)) {
      // First lesson of an opening this session: the numbers from Lichess.
      const f = fetching?.key === key ? fetching : null;
      head.innerHTML = `<span class="coach-title">${t("Was wird auf deinem Niveau gespielt?")}</span>`;
      text.innerHTML = f?.waiting
        ? t("Lichess bittet um eine kurze Pause – in einer Minute geht es weiter …")
        : `${t("Ich frage bei Lichess nach, welche Antworten deine Gegner hier wirklich spielen. Beim ersten Mal dauert das etwas, danach geht es sofort.")}${
            f ? `<br><span class="muted">${tn(f.done, "1 Stellung geholt", "{n} Stellungen geholt")}</span>` : ""
          }`;
      actions.innerHTML = "";
      return;
    }
    head.innerHTML = `<span class="muted">${t("Bereite die nächste Variante vor …")}</span>`;
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
        text.innerHTML = `${t("<b>Jetzt ohne Pfeile:</b> spiel die Variante, die du gerade gelernt hast.")}<br>${lineProgress(d)}`;
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
        text.innerHTML = t("{move} gehört nicht zu dieser Variante. Der grüne Pfeil zeigt den richtigen Zug – spiel ihn nach.", {
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
              ? t("<b class=\"ok\">Fehlerfrei!</b> Die Variante liegt jetzt in Fach 1 deines Karteikastens. Noch einmal zum Festigen.")
              : t("<b class=\"ok\">Fehlerfrei!</b> Noch einmal, dann hast du sie drin.")
          : endedInBox
            ? t("<b class=\"ok\">Eingeprägt.</b> Die Karte liegt jetzt in Fach 1 deines Karteikastens und kommt in 10 Minuten wieder.")
            : t("<b>Noch nicht drin.</b> Die Variante kommt noch nicht in den Karteikasten – beim nächsten Mal lernst du sie noch einmal mit Pfeilen.");
      } else if (learning()) {
        text.innerHTML =
          d.status === "new"
            ? t("<b class=\"ok\">Variante gezeigt.</b> Jetzt spielst du sie ohne Pfeile. Klappt sie einmal ohne Fehler, kommt sie in den Karteikasten.")
            : t("<b class=\"ok\">Variante gezeigt.</b> Jetzt spielst du sie ohne Pfeile, bis sie zweimal hintereinander klappt.");
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
         ${learning() || d.kind !== "line" ? "" : `<button data-act="relearn" title="${t("Die Variante von vorn mit allen Pfeilen zeigen. Die Karte kommt zurück in Fach 1.")}">${t("Mit Pfeilen neu lernen")}</button>`}
         ${learning() ? "" : `<button data-act="show" ${phase === "solve" || phase === "wrong" ? "" : "disabled"}>${sequential(d) ? t("Zug zeigen") : t("Lösung zeigen")}</button>`}
         ${game}
         <button data-act="skip" class="end">${t("Überspringen")}</button>`;
  bindActions(d);
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
