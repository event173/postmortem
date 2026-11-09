// "Eröffnungen" tab (see repertoire.rs):
// - opening list (full width, board thumbnails): pick an opening, "Als Weiß/Schwarz lernen"
// - training: learn a new line with arrows, then consolidate it without arrows
//   until it sits twice in a row; reviews come back with spaced repetition
// - while learning one opening, its variations are listed with progress bars
//   and can be chosen individually
// - besides: the opening mistakes from your own games

import { invoke } from "@tauri-apps/api/core";
import type { Api } from "chessground/api";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";

import { windowLast } from "./stats";
import { CLASSES, type Account, type Class, type MoveReview, type PlayedMove, type PositionInfo } from "./types";
import { playerName, t, tn } from "./i18n";
import { $, badgeHtml, commentOf, esc, fig, miniPieces, store } from "./util";
import { errorSound, moveSound, setupSound, successSound } from "./sound";

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
  kind: "line" | "own";
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
}

interface Status {
  white: SideStatus;
  black: SideStatus;
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

type Mode = "mixed" | "repertoire" | "own";
type Sort = "popular" | "mine" | "learning" | "az";
type Phase = "loading" | "empty" | "opponent" | "solve" | "checking" | "wrong" | "done";

const ACCEPTED: Class[] = ["brilliant", "great", "best", "excellent"];
const SIDE: Record<Color, string> = { white: t("Weiß"), black: t("Schwarz") };
/** The dataset's variation names are English; only "Hauptvariante" (main line) is ours. */
const varName = (n: string) => (n === "Hauptvariante" ? t("Hauptvariante") : n);
/** Clean runs in a row needed before a newly learned line counts as consolidated. */
const CONSOLIDATE_RUNS = 2;
const CONSOLIDATE_MAX = 5;

let deps: OpeningDeps;
let active = false;
let view: "train" | "browse" = "train";

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
/** Consolidating a just-learned line: replay it without arrows. */
let consolidate: { line: Drill; clean: number; runs: number } | null = null;
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
let expanded = new Set<string>();

// choices
let mode: Mode = (store.get("op-mode") as Mode) || "mixed";
let sort: Sort = "popular";
let focus: Focus | null = null;

const sideOf = (f: string): Color => (f.split(" ")[1] === "w" ? "white" : "black");
const sq = (uci: string, from: boolean) => (from ? uci.slice(0, 2) : uci.slice(2, 4)) as Key;
/** A new line is taught with arrows, not tested. */
const learning = () => drill?.kind === "line" && (drill.status === "new" || drill.status === "relearn");

// ---------------------------------------------------------------------------
// setup and views

export function initOpenings(d: OpeningDeps) {
  deps = d;
  invoke<Family[]>("opening_families").then((f) => (families = f));

  document.querySelectorAll<HTMLElement>("#op-view button").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.v as "train" | "browse")),
  );
  $("op-back").addEventListener("click", () => setView("train"));
  document.querySelectorAll<HTMLElement>("#op-mode button").forEach((b) => {
    b.classList.toggle("active", b.dataset.m === mode);
    b.addEventListener("click", () => {
      mode = b.dataset.m as Mode;
      store.set("op-mode", mode);
      document.querySelectorAll<HTMLElement>("#op-mode button").forEach((x) => x.classList.toggle("active", x === b));
      loadNext();
    });
  });
  document.querySelectorAll<HTMLElement>("#op-sort button").forEach((b) =>
    b.addEventListener("click", () => {
      sort = b.dataset.s as Sort;
      document.querySelectorAll<HTMLElement>("#op-sort button").forEach((x) => x.classList.toggle("active", x === b));
      renderList();
    }),
  );
  $("op-search").addEventListener("input", renderList);
  $("op-manage").addEventListener("click", () => setView("browse"));
}

export function isOpeningMode(): boolean {
  return active;
}

export function enterOpenings() {
  active = true;
  deps.board.setShapes([]);
  setView("train");
  Promise.all([loadRepertoire(), loadProgress()]).then(() => {
    renderSidebar();
    if (!drill || phase === "empty") loadNext();
    else render();
  });
  loadPlayed();
}

export function leaveOpenings() {
  active = false;
  clearTimeout(timer);
  document.querySelector(".layout")!.classList.remove("op-browse-mode");
  $("op-browse-view").hidden = true;
}

export function openingKey(e: KeyboardEvent): boolean {
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

function setView(v: "train" | "browse") {
  view = v;
  // The opening list takes the whole width; the board is hidden meanwhile.
  document.querySelector(".layout")!.classList.toggle("op-browse-mode", v === "browse" && active);
  $("op-browse-view").hidden = !(v === "browse" && active);
  $("openings").hidden = !(v === "train" && active);
  if (v === "browse") {
    renderList();
    Promise.all([loadProgress(), loadRepertoire()]).then(renderList);
  } else {
    // The board was hidden (size 0): let chessground measure it again before
    // drawing, otherwise the first arrow is drawn with zero size and stays invisible.
    if (active) deps.board.redrawAll();
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
    return;
  }
  variations = await invoke<VariationGroup[]>("opening_family_detail", { color: focus.color, family: focus.family });
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
  if (f) await addToRepertoire(f.color, f.family);
  await Promise.all([loadVariations(), loadProgress()]);
  renderSidebar();
  loadNext();
}

/** Start learning from the opening list. Also used by "Üben" in the statistics. */
export async function startFocus(color: Color, family: string) {
  setView("train");
  await setFocus({ color, family });
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
  let items = families.filter((f) => !q || f.name.toLowerCase().includes(q) || f.eco.toLowerCase() === q);
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
          <div class="op-title" title="${esc(f.name)}">${esc(f.name)}</div>
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
  const focusEl = $("op-focus");
  const varsEl = $("op-variations");
  const summaryEl = $("op-summary");
  $("op-mode").hidden = !!focus;
  focusEl.hidden = !focus;
  varsEl.hidden = !focus;
  summaryEl.hidden = !!focus;

  if (!focus) {
    const fams = [
      ...repertoire.white.map((f) => `<span class="pdot white"></span>${esc(f)}`),
      ...repertoire.black.map((f) => `<span class="pdot black"></span>${esc(f)}`),
    ];
    const due = (status?.white.due ?? 0) + (status?.black.due ?? 0);
    summaryEl.querySelector(".op-summary-body")!.innerHTML = fams.length
      ? `<div class="op-rep-list">${fams.map((f) => `<span class="op-rep">${f}</span>`).join("")}</div>
         <div class="muted">${due ? t("<b>{n}</b> Varianten fällig", { n: due }) : t("Nichts fällig")}</div>`
      : `<span class="muted">${t("Noch keine Eröffnungen gewählt.")}</span>`;
    return;
  }

  const p = progress[`${focus.color}|${focus.family}`];
  const sub = focus.line
    ? variations.flatMap((g) => g.lines).find((l) => l.id === focus!.line)?.name
    : focus.variation;
  focusEl.innerHTML = `
    <div class="op-focus-top">
      <span class="pdot ${focus.color}"></span>
      <div class="op-focus-title"><b>${esc(focus.family)}</b> <span class="muted">${t("als {side}", { side: SIDE[focus.color] })}</span>
        ${sub ? `<div class="op-focus-sub">${t("nur:")} ${esc(varName(sub))} <button id="op-focus-all" class="link">${t("alle Varianten")}</button></div>` : ""}</div>
      <button id="op-focus-x" class="icon" title="${t("Lernen beenden – zurück zum gemischten Training")}">✕</button>
    </div>
    ${p ? `<div class="op-focus-progress">${progressBar(p.lines, p.started, p.learned)}<span class="muted">${cardSummary(p.lines, p.started, p.learned, p.due)}</span></div>` : ""}
    <p class="panel-sub op-box-help">${BOX_HELP()}</p>`;
  $("op-focus-x").addEventListener("click", () => setFocus(null));
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
                    return `<button class="var-line ${l.id === current ? "current" : ""} ${focus!.line === l.id ? "selected" : ""}" data-line="${esc(l.id)}" title="${t("Nur diese Linie lernen")} · ${where} · ${t("{n} Züge", { n: Math.ceil(l.plies / 2) })}">
                      ${pips(l.boxLevel)}
                      <span class="line-name">${esc(varName(l.name))}</span>
                      <span class="line-state">${lineState(l)}</span></button>`;
                  })
                  .join("")}</div>`
              : ""
          }
        </div>`;
      })
      .join("")}`;
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
// drills

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
  continueLine(tk);
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
  if (d.kind === "own") {
    phase = "solve";
    return render();
  }
  if (step >= d.moves.length) return finish(tk);
  if (sideOf(fen) === d.color) {
    phase = "solve";
    return render();
  }
  phase = "opponent";
  render();
  const n = nav;
  timer = window.setTimeout(
    async () => {
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
      if (learning()) showTheory(fen);
      continueLine(tk);
    },
    step === 0 ? 500 : deps.animMs() + 250,
  );
}

function play(from: string, uci: string): Promise<PlayedMove> {
  return invoke<PlayedMove>("play_move", { fen: from, from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

export async function openingMove(orig: Key, dest: Key, promotion?: string) {
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
  if (d.kind === "own") {
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
  if (drill!.kind === "own") return finish(tk);
  showTheory(fen);
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

  if (d.status === "practice" && consolidate) {
    // Consolidation run: count clean runs in a row; nothing is recorded.
    consolidate.runs++;
    consolidate.clean = failed ? 0 : consolidate.clean + 1;
    if (consolidate.clean >= CONSOLIDATE_RUNS || consolidate.runs >= CONSOLIDATE_MAX) consolidate = null;
    render();
    return;
  }

  render();
  try {
    const r = await invoke<{ boxLevel: number; due: number; status: Status }>("opening_record", {
      id: d.id,
      color: d.color,
      // Learning a forgotten line again: the card goes back to box 1.
      success: d.status === "relearn" ? false : !failed,
    });
    if (tk !== token) return;
    resultBox = r.boxLevel;
    resultDue = r.due;
    status = r.status;
  } catch (e) {
    console.error(e);
  }
  // A line was just taught: consolidate it right away (without arrows).
  if (learning()) consolidate = { line: { ...d, status: "new" }, clean: 0, runs: 0 };
  await Promise.all([loadProgress(), loadVariations()]);
  if (tk !== token) return;
  renderSidebar();
  renderText();
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

/** Show the explanation of a position, if Wikibooks has one. */
async function showTheory(f: string | null) {
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
  // Keep the previous text when this position has none: it still describes the line.
  if (!text) return;
  box.innerHTML = `
    <h3>${t("Eröffnungstheorie")}${text.untranslated ? ` <span class="muted">${t("(englisch)")}</span>` : ""}</h3>
    <div class="op-theory-text">${text.paragraphs.map((p) => `<p>${esc(fig(p))}</p>`).join("")}</div>
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
  if (!active || view !== "train") return;
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
    if (phase === "wrong" && d.kind === "line" && expected) {
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

function renderText(error?: string) {
  if (!active || view !== "train") return;
  const head = $("op-head");
  const text = $("op-text");
  const extra = $("op-extra");
  const actions = $("op-actions");
  extra.innerHTML = "";
  const d = drill;

  if (phase === "loading") {
    head.innerHTML = `<span class="muted">${t("Bereite die nächste Variante vor …")}</span>`;
    text.innerHTML = "";
    actions.innerHTML = "";
    return;
  }
  if (phase === "empty" || !d) {
    head.innerHTML = `<span class="coach-title">${focus ? t("Alles gelernt") : t("Nichts zu üben")}</span>`;
    text.innerHTML = error
      ? `<span class="error">${esc(error)}</span>`
      : focus
        ? t("Alle Varianten hier sind gelernt und gerade nichts fällig. Die Wiederholungen kommen zur rechten Zeit – oder wähl rechts eine andere Variante.")
        : mode === "own"
          ? t("Gerade keine Eröffnungsfehler aus deinen Partien fällig – gelöste Stellungen ruhen eine Weile.")
          : t("Such dir unter „Eröffnungen wählen“ aus, was du lernen willst.");
    actions.innerHTML = focus ? "" : `<button data-act="browse" class="primary">${t("Eröffnungen wählen")}</button>`;
    bindActions(d);
    return;
  }

  const tag =
    d.kind === "own"
      ? `<span class="pz-tag own">${t("Aus deiner Partie")}</span>`
      : d.status === "new" || d.status === "relearn"
        ? `<span class="pz-tag mixed">${d.status === "relearn" ? t("Nochmal lernen") : t("Neu lernen")}</span>`
        : d.status === "practice"
          ? `<span class="pz-tag op-practice-tag">${t("Festigen")} ${(consolidate?.clean ?? 0) + (phase === "done" ? 0 : 1)}/${CONSOLIDATE_RUNS}</span>`
          : `<span class="pz-tag op-review">${t("Wiederholung")}</span>`;
  const shortName = d.name.includes(":") ? d.name.split(":").slice(1).join(":").trim() : varName(d.name);
  head.innerHTML = `${tag}<span class="op-name" title="${esc(d.name)}">${esc(focus ? shortName : d.name)}</span>`;

  const side = SIDE[d.color];
  const expected = d.moves[step];
  switch (phase) {
    case "opponent":
      text.innerHTML = `<span class="muted">${t("Der Gegner zieht …")}</span><br>${lineProgress(d)}`;
      break;
    case "solve":
      if (d.kind === "own" && d.own) {
        const num = Math.ceil(d.own.ply / 2) + (d.own.ply % 2 ? "." : "...");
        text.innerHTML = t("Gegen {name} hast du hier {move} gespielt – {phrase}. Was ist besser?", {
          name: esc(playerName(d.own.opponent)),
          move: `<b>${num} ${esc(fig(d.own.san))}</b>`,
          phrase: CLASSES[d.own.classification].phrase,
        });
      } else if (learning()) {
        text.innerHTML = `${t("<b>Spiel den grünen Pfeil nach.</b> Der Gegner antwortet, merk dir die Zugfolge.")}<br>${lineProgress(d)}`;
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
      if (d.kind === "line" && learning()) {
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
            : t("<b class=\"ok\">Fehlerfrei!</b> Noch einmal, dann hast du sie drin.")
          : t("<b class=\"ok\">Eingeprägt.</b> Die Karte liegt jetzt in Fach 1 deines Karteikastens und kommt in 10 Minuten wieder.");
      } else if (learning()) {
        text.innerHTML = t("<b class=\"ok\">Variante gezeigt.</b> Jetzt spielst du sie ohne Pfeile, bis sie zweimal hintereinander klappt.");
      } else {
        const when = resultDue ? relDays(resultDue) : "";
        text.innerHTML = failed
          ? t("<b>Geschafft</b> – mit Fehlern. Die Karte geht zurück in Fach 1 und kommt <b>{when}</b> wieder.", { when: when || t("bald") })
          : resultBox && resultBox >= 3
            ? t("<b class=\"ok\">Richtig!</b> Die Karte rutscht in Fach {n} von 5 – <b>sie sitzt</b>. Wieder <b>{when}</b>.", { n: resultBox, when: when || "…" })
            : t("<b class=\"ok\">Richtig!</b> Die Karte rutscht in Fach {n} von 5 und kommt <b>{when}</b> wieder.", { n: resultBox ?? 1, when: when || "…" });
      }
      if (d.own) extra.innerHTML = `<span class="muted">${t("In der Partie:")}</span> ${esc(fig(d.own.comment))}`;
      break;
    }
  }

  const game = d.own ? `<button data-act="game">${t("Partie öffnen")}</button>` : "";
  const backBtn =
    d.kind === "line"
      ? `<button data-act="back" title="${t("Deinen letzten Zug zurücknehmen (←)")}" ${backTarget() >= 0 && phase !== "checking" ? "" : "disabled"}>← ${t("Zurück")}</button>`
      : "";
  actions.innerHTML =
    phase === "done"
      ? `${backBtn}${game}${d.kind === "line" && !learning() && failed ? `<button data-act="relearn">${t("Mit Pfeilen neu lernen")}</button>` : ""}<button data-act="next" class="primary end">${t("Weiter")} →</button>`
      : `${backBtn}${learning() ? "" : `<button data-act="hint" ${hint || phase !== "solve" ? "disabled" : ""}>${t("Tipp")}</button>`}
         ${learning() || d.kind !== "line" ? "" : `<button data-act="relearn" title="${t("Die Variante von vorn mit allen Pfeilen zeigen. Die Karte kommt zurück in Fach 1.")}">${t("Mit Pfeilen neu lernen")}</button>`}
         ${learning() ? "" : `<button data-act="show" ${phase === "solve" || phase === "wrong" ? "" : "disabled"}>${d.kind === "line" ? t("Zug zeigen") : t("Lösung zeigen")}</button>`}
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
            break;
          case "browse":
            setView("browse");
            break;
        }
      }),
    );
}
