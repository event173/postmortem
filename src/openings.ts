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
import { $, badgeHtml, esc, fig, miniPieces, store } from "./util";
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
  /** "practice" = consolidating a just-learned line (frontend only). */
  status: "new" | "due" | "early" | "practice";
  own: OwnMistake | null;
  /** Named theory moves; after that comes the engine's continuation. */
  bookLen: number;
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
const SIDE: Record<Color, string> = { white: "Weiß", black: "Schwarz" };
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
const learning = () => drill?.kind === "line" && drill.status === "new";

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
  return `<span class="learn-bar" title="${learned} sicher, ${started - learned} in Arbeit, ${total - started} neu">
    <span class="lb-learned" style="width:${(learned / total) * 100}%"></span><span class="lb-started" style="width:${((started - learned) / total) * 100}%"></span></span>`;
}

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
      popular: "Nichts gefunden.",
      az: "Nichts gefunden.",
      mine: "Noch keine analysierten Partien mit erkannter Eröffnung.",
      learning: "Du lernst noch keine Eröffnung – such dir eine aus und klick auf „lernen“.",
    };
    grid.innerHTML = `<p class="muted">${empty[sort]}</p>`;
    return;
  }
  grid.innerHTML = items
    .map((f) => {
      const p = played[f.name];
      const mineText =
        p && (p.white || p.black)
          ? `<div class="op-mine">Deine Partien: ${[p.white ? `${p.white}× Weiß` : "", p.black ? `${p.black}× Schwarz` : ""].filter(Boolean).join(", ")}</div>`
          : "";
      const side = (color: Color) => {
        const pr = progress[`${color}|${f.name}`];
        const started = !!pr && pr.started > 0;
        const inRep = repertoire[color].includes(f.name);
        return `<div class="op-side-row">
          <button class="op-learn ${started ? "primary" : ""}" data-color="${color}" data-family="${esc(f.name)}">
            <span class="pdot ${color}"></span>${started ? "Weiterlernen" : "Lernen"} als ${SIDE[color]}</button>
          ${pr ? `${progressBar(pr.lines, pr.started, pr.learned)}<span class="op-progress-text">${pr.learned}/${pr.lines}${pr.due ? ` · <b>${pr.due} fällig</b>` : ""}</span>` : ""}
          ${inRep ? `<button class="op-remove" data-color="${color}" data-family="${esc(f.name)}" title="Aus dem Repertoire nehmen (Lernstand bleibt)">✕</button>` : ""}
        </div>`;
      };
      return `<div class="op-card">
        <div class="mini-board cg-wrap big" data-fen="${esc(f.fen)}"></div>
        <div class="op-card-body">
          <div class="op-title" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="op-moves">${esc(fig(f.moves))}</div>
          <div class="muted op-meta">${esc(f.eco)} · ${f.lines} Varianten</div>
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
         <div class="muted">${due ? `<b>${due}</b> Varianten fällig` : "Nichts fällig"}</div>`
      : `<span class="muted">Noch keine Eröffnungen gewählt.</span>`;
    return;
  }

  const p = progress[`${focus.color}|${focus.family}`];
  const sub = focus.line
    ? variations.flatMap((g) => g.lines).find((l) => l.id === focus!.line)?.name
    : focus.variation;
  focusEl.innerHTML = `
    <div class="op-focus-top">
      <span class="pdot ${focus.color}"></span>
      <div class="op-focus-title"><b>${esc(focus.family)}</b> <span class="muted">als ${SIDE[focus.color]}</span>
        ${sub ? `<div class="op-focus-sub">nur: ${esc(sub)} <button id="op-focus-all" class="link">alle Varianten</button></div>` : ""}</div>
      <button id="op-focus-x" class="icon" title="Lernen beenden – zurück zum gemischten Training">✕</button>
    </div>
    ${p ? `<div class="op-focus-progress">${progressBar(p.lines, p.started, p.learned)}<span class="muted">${p.learned} sicher · ${p.started - p.learned} in Arbeit · ${p.lines - p.started} neu</span></div>` : ""}`;
  $("op-focus-x").addEventListener("click", () => setFocus(null));
  document.getElementById("op-focus-all")?.addEventListener("click", () => setFocus({ color: focus!.color, family: focus!.family }));

  const current = drill?.kind === "line" ? drill.id : null;
  varsEl.innerHTML = `<h3>Varianten</h3><p class="panel-sub">Klick auf eine Variante, um nur sie zu lernen. Grün = sicher, hell = in Arbeit.</p>
    ${variations
      .map((g) => {
        const open = expanded.has(g.name);
        const selected = focus!.variation === g.name && !focus!.line;
        return `<div class="var-group ${selected ? "selected" : ""}">
          <div class="var-row">
            <button class="var-toggle" data-group="${esc(g.name)}" title="${open ? "Zuklappen" : "Linien zeigen"}">${open ? "▾" : "▸"}</button>
            <button class="var-name" data-group="${esc(g.name)}" title="Nur diese Variante lernen">${esc(g.name)}</button>
            ${progressBar(g.total, g.started, g.learned)}
            <span class="var-count">${g.learned}/${g.total}${g.due ? ` · <b>${g.due}</b>` : ""}</span>
          </div>
          ${
            open
              ? `<div class="var-lines">${g.lines
                  .map((l) => {
                    const state = l.boxLevel === 0 ? "new" : l.boxLevel >= 3 ? "learned" : "started";
                    const label = state === "new" ? "neu" : state === "learned" ? "sicher" : `Stufe ${l.boxLevel}`;
                    return `<button class="var-line ${l.id === current ? "current" : ""} ${focus!.line === l.id ? "selected" : ""}" data-line="${esc(l.id)}" title="Nur diese Linie lernen">
                      <span class="line-dot ${state}" title="${label}${l.due ? ", fällig" : ""}"></span>
                      <span class="line-name">${esc(l.name)}</span>
                      <span class="muted">${Math.ceil(l.plies / 2)} Z.</span></button>`;
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

function startDrill(d: Drill | null, t: number) {
  drill = d;
  failed = false;
  hint = false;
  verdict = null;
  wrongTry = null;
  resultDue = null;
  resultBox = null;
  deps.board.setShapes([]);
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
  continueLine(t);
}

async function loadNext() {
  const t = ++token;
  clearTimeout(timer);
  // Consolidation: replay the line just learned until it sits.
  if (consolidate) {
    return startDrill({ ...consolidate.line, status: "practice" }, t);
  }
  phase = "loading";
  render();
  let d: Drill | null;
  try {
    d = await invoke<Drill | null>("opening_next", { accounts: deps.accounts(), last: windowLast(), mode, focus });
  } catch (e) {
    if (t !== token) return;
    phase = "empty";
    render(String(e));
    return;
  }
  if (t !== token) return;
  startDrill(d, t);
}

/** Play the opponent's moves until it's your turn (or the line is over). */
function continueLine(t: number) {
  const d = drill!;
  if (d.kind === "own") {
    phase = "solve";
    return render();
  }
  if (step >= d.moves.length) return finish(t);
  if (sideOf(fen) === d.color) {
    phase = "solve";
    return render();
  }
  phase = "opponent";
  render();
  timer = window.setTimeout(
    async () => {
      if (t !== token) return;
      const played = await play(fen, d.moves[step]);
      if (t !== token) return;
      fen = played.fen;
      lastMove = played.uci;
      moveSound(played.san);
      step++;
      continueLine(t);
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
  const t = token;
  const expected = d.moves[step];
  const promo = expected && expected.slice(0, 4) === orig + dest ? expected[4] : promotion;
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: orig, to: dest, promotion: promo });
  } catch {
    return render();
  }
  if (t !== token) return;

  if (played.uci === expected) return correct(played, t);
  if (d.kind === "own") {
    phase = "checking";
    showTry(played);
    try {
      verdict = await invoke<MoveReview>("evaluate_move", { fen, uci: played.uci });
    } catch {
      verdict = null;
    }
    if (t !== token) return;
    if (verdict && ACCEPTED.includes(verdict.classification)) return correct(played, t);
  }
  if (!learning()) failed = true;
  wrongTry = played;
  phase = "wrong";
  errorSound();
  showTry(played);
  timer = window.setTimeout(() => {
    if (t === token && phase === "wrong") render();
  }, 900);
}

function correct(played: PlayedMove, t: number) {
  moveSound(played.san);
  fen = played.fen;
  lastMove = played.uci;
  step++;
  wrongTry = null;
  hint = false;
  if (drill!.kind === "own") return finish(t);
  continueLine(t);
}

/** Show the correct move (counts as a mistake) and carry on. */
async function showMove() {
  const d = drill;
  if (!d || !d.moves[step]) return;
  const t = token;
  if (!learning()) failed = true;
  const played = await play(fen, d.moves[step]);
  if (t !== token) return;
  correct(played, t);
}

async function finish(t: number) {
  const d = drill!;
  phase = "done";
  if (!failed) successSound();

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
      success: !failed,
    });
    if (t !== token) return;
    resultBox = r.boxLevel;
    resultDue = r.due;
    status = r.status;
  } catch (e) {
    console.error(e);
  }
  // A line was just taught: consolidate it right away (without arrows).
  if (d.kind === "line" && d.status === "new") consolidate = { line: d, clean: 0, runs: 0 };
  await Promise.all([loadProgress(), loadVariations()]);
  if (t !== token) return;
  renderSidebar();
  renderText();
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
      const t = token;
      invoke<PositionInfo>("position_info", { fen }).then((info) => {
        if (t !== token || !active || (phase !== "solve" && phase !== "wrong")) return;
        deps.board.set({ movable: { color: d.color, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
      });
    }
  }
  renderText(error);
}

function relDays(due: number): string {
  const minutes = Math.round((due - Date.now()) / 60_000);
  if (minutes < 60) return minutes <= 1 ? "gleich" : `in ${minutes} Minuten`;
  const days = Math.round(minutes / 1440);
  if (days <= 1) return "morgen";
  return `in ${days} Tagen`;
}

/** "Zug 5 von 9" plus a marker where the named theory ends. */
function lineProgress(d: Drill): string {
  if (d.kind !== "line") return "";
  const mine = d.moves.filter((_, i) => (i % 2 === 0) === (d.color === "white")).length;
  const done = d.moves.slice(0, step).filter((_, i) => (i % 2 === 0) === (d.color === "white")).length;
  const engine = step >= d.bookLen && d.moves.length > d.bookLen;
  return `<span class="muted">Zug ${Math.min(done + 1, mine)} von ${mine}${engine ? " · <span class=\"engine-mark\" title=\"Die benannte Theorie ist zu Ende; ab hier die beste Fortsetzung laut Stockfish\">Engine-Fortsetzung</span>" : ""}</span>`;
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
    head.innerHTML = `<span class="muted">Bereite die nächste Variante vor …</span>`;
    text.innerHTML = "";
    actions.innerHTML = "";
    return;
  }
  if (phase === "empty" || !d) {
    head.innerHTML = `<span class="coach-title">${focus ? "Alles gelernt" : "Nichts zu üben"}</span>`;
    text.innerHTML = error
      ? `<span class="error">${esc(error)}</span>`
      : focus
        ? `Alle Varianten hier sind gelernt und gerade nichts fällig. Die Wiederholungen kommen zur rechten Zeit – oder wähl rechts eine andere Variante.`
        : mode === "own"
          ? `Gerade keine Eröffnungsfehler aus deinen Partien fällig – gelöste Stellungen ruhen eine Weile.`
          : `Such dir unter „Eröffnungen wählen“ aus, was du lernen willst.`;
    actions.innerHTML = focus ? "" : `<button data-act="browse" class="primary">Eröffnungen wählen</button>`;
    bindActions(d);
    return;
  }

  const tag =
    d.kind === "own"
      ? `<span class="pz-tag own">Aus deiner Partie</span>`
      : d.status === "new"
        ? `<span class="pz-tag mixed">Neu lernen</span>`
        : d.status === "practice"
          ? `<span class="pz-tag op-practice-tag">Festigen ${(consolidate?.clean ?? 0) + (phase === "done" ? 0 : 1)}/${CONSOLIDATE_RUNS}</span>`
          : `<span class="pz-tag op-review">Wiederholung</span>`;
  const shortName = d.name.includes(":") ? d.name.split(":").slice(1).join(":").trim() : d.name;
  head.innerHTML = `${tag}<span class="op-name" title="${esc(d.name)}">${esc(focus ? shortName : d.name)}</span>`;

  const side = SIDE[d.color];
  const expected = d.moves[step];
  switch (phase) {
    case "opponent":
      text.innerHTML = `<span class="muted">Der Gegner zieht …</span><br>${lineProgress(d)}`;
      break;
    case "solve":
      if (d.kind === "own" && d.own) {
        const num = Math.ceil(d.own.ply / 2) + (d.own.ply % 2 ? "." : "...");
        text.innerHTML = `Gegen ${esc(d.own.opponent)} hast du hier <b>${num} ${esc(fig(d.own.san))}</b> gespielt – ${CLASSES[d.own.classification].phrase}. Was ist besser?`;
      } else if (learning()) {
        text.innerHTML = `<b>Spiel den grünen Pfeil nach.</b> Der Gegner antwortet, merk dir die Zugfolge.<br>${lineProgress(d)}`;
      } else if (d.status === "practice") {
        text.innerHTML = `<b>Jetzt ohne Pfeile:</b> spiel die Variante, die du gerade gelernt hast.<br>${lineProgress(d)}`;
      } else {
        text.innerHTML = `<b>${side} am Zug.</b> Welcher Zug gehört zu deinem Repertoire?${d.status === "early" ? ` <span class="muted">(vorgezogen)</span>` : ""}<br>${lineProgress(d)}`;
      }
      if (hint && expected) text.innerHTML += `<br><span class="hint-text">Tipp: Zieh von ${expected.slice(0, 2)}.</span>`;
      break;
    case "checking":
      text.innerHTML = `<span class="muted">Prüfe deinen Zug …</span>`;
      break;
    case "wrong":
      if (d.kind === "line" && learning()) {
        text.innerHTML = `Das ist nicht der markierte Zug – spiel den grünen Pfeil nach.`;
      } else if (d.kind === "line") {
        text.innerHTML = `<b>${esc(fig(wrongTry?.san ?? ""))}</b> gehört nicht zu dieser Variante. Der grüne Pfeil zeigt den richtigen Zug – spiel ihn nach.`;
      } else {
        text.innerHTML = verdict
          ? `${badgeHtml(verdict.classification)} <b>${esc(fig(verdict.san))}</b> ist ${CLASSES[verdict.classification].phrase}. ${esc(fig(verdict.comment))} <span class="muted">Versuch es nochmal.</span>`
          : `Das ist nicht besser. <span class="muted">Versuch es nochmal.</span>`;
      }
      break;
    case "done": {
      if (d.status === "practice") {
        text.innerHTML = consolidate
          ? failed
            ? `Noch nicht ganz – <b>nochmal</b>. Zweimal fehlerfrei hintereinander, dann sitzt sie.`
            : `<b class="ok">Fehlerfrei!</b> Noch einmal, dann sitzt sie.`
          : `<b class="ok">Variante sitzt.</b> Sie kommt zur Wiederholung wieder, bevor du sie vergisst.`;
      } else if (d.kind === "line" && d.status === "new") {
        text.innerHTML = `<b class="ok">Variante gezeigt.</b> Jetzt spielst du sie ohne Pfeile, bis sie zweimal hintereinander sitzt.`;
      } else {
        const when = resultDue ? relDays(resultDue) : "";
        text.innerHTML = failed
          ? `<b>Geschafft</b> – mit Fehlern. Kommt <b>${when || "bald"}</b> nochmal.`
          : `<b class="ok">Richtig!</b> Nächste Wiederholung <b>${when || "…"}</b>${resultBox ? ` <span class="muted">(Stufe ${resultBox}/5)</span>` : ""}.`;
      }
      if (d.own) extra.innerHTML = `<span class="muted">In der Partie:</span> ${esc(fig(d.own.comment))}`;
      break;
    }
  }

  const game = d.own ? `<button data-act="game">Partie öffnen</button>` : "";
  actions.innerHTML =
    phase === "done"
      ? `${game}<button data-act="next" class="primary end">Weiter →</button>`
      : `${learning() ? "" : `<button data-act="hint" ${hint || phase !== "solve" ? "disabled" : ""}>Tipp</button>`}
         ${learning() ? "" : `<button data-act="show" ${phase === "solve" || phase === "wrong" ? "" : "disabled"}>${d.kind === "line" ? "Zug zeigen" : "Lösung zeigen"}</button>`}
         ${game}
         <button data-act="skip" class="end">Überspringen</button>`;
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
