import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Key } from "chessground/types";
import type { DrawShape } from "chessground/draw";
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import "./styles.css";
import "./pieces.css";
import { lang, locale, playerName, t, tn } from "./i18n";
import { $, badgeHtml, commentOf, esc, fig, platformLabel, speedLabel, store } from "./util";
import { openingName } from "./opening-names";
import { autoAnalyse, initStats, loadStats } from "./stats";
import { errorSound, moveSound, preloadSounds, setupSound, successSound } from "./sound";
import { enterPuzzles, initPuzzles, isPuzzleMode, leavePuzzles, puzzleKey, puzzleMove, puzzleNav } from "./puzzles";
import { enterPlay, initPlay, isPlayMode, leavePlay, playHome, playMove } from "./play";
import { bindCardButton, type CardRequest } from "./cards";
import { enterOpenings, initOpenings, isOpeningMode, leaveOpenings, openingKey, openingMove, openingNav, openingsHome, showTheoryExits, startFocus } from "./openings";
import { autoAnalysePref, displayPrefs, initSettings, refinePref } from "./settings";

import {
  BAD,
  CLASSES,
  SUMMARY_ORDER,
  type Class,
  type GameInfo,
  type GameReview,
  type LiveInfo,
  type MoveReview,
  type PlayedMove,
  type PositionInfo,
  type Progress,
  type Refutation,
  type Account,
  type Platform,
  type Score,
  type StoredGame,
  type SyncResult,
  type VarNode,
} from "./types";

type Color = "white" | "black";


const state = {
  /** Which platform's games are shown ("all" = both). */
  view: "lichess" as Platform | "all",
  /** Your username per platform. */
  names: { lichess: "", chesscom: "", local: "Du" } as Record<Platform, string>,
  games: [] as GameInfo[],
  cached: new Set<string>(),
  game: null as GameInfo | null,
  review: null as GameReview | null,
  ply: 0,
  orientation: "white" as Color,
  /** Side line the user played on the board, branching off after `basePly`. */
  variation: null as { basePly: number; nodes: VarNode[] } | null,
  /** Whether the board currently shows the variation, and how far into it (0 = branch point). */
  inVar: false,
  varIndex: 0,
  liveEnabled: true,
  /** Accuracy of both sides per analysed game (shown in the list). */
  accuracy: new Map<string, { white: number; black: number }>(),
  /** Favourite games (ids). */
  favorites: new Set<string>(),
  /** Your mistakes + misses + blunders per analysed game (for the filter). */
  errors: new Map<string, number>(),
  /** All stored games of the shown accounts, loaded when a filter is used (the list shows the newest 500). */
  allGames: null as GameInfo[] | null,
};

/** Game list filter. */
const filter = { q: "", fav: false, result: "", color: "", speed: "", analysis: "" };
const filterActive = () => !!(filter.q || filter.fav || filter.result || filter.color || filter.speed || filter.analysis);
/** At most this many games are listed at once (the rest via the filter). */
const LIST_MAX = 300;

/** Piece animation length (setting); playback steps are a bit longer so moves never overlap. */
let animMs = displayPrefs().animMs;

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const board: Api = Chessground($("board"), {
  fen: START_FEN,
  // Not viewOnly: chessground binds its drag listeners only once, at creation.
  // Moves are blocked via `movable.color` until a review is loaded instead.
  coordinates: displayPrefs().coordinates,
  animation: { enabled: animMs > 0, duration: animMs },
  draggable: { enabled: true, showGhost: true },
  // Right-click drag draws arrows, right-click on a square a circle (like Lichess):
  // green; Shift/Ctrl = red, Alt = blue, both = yellow. Left-click erases.
  drawable: { enabled: true, visible: true, eraseOnClick: true, defaultSnapToValidMove: true },
  premovable: { enabled: false },
  movable: { free: false, color: undefined, showDests: true, events: { after: (orig, dest) => onUserMove(orig, dest) } },
});

// After a window size change (fullscreen on/off, maximise) measure the board
// again once the layout has settled; chessground's own observer can see an
// intermediate size during the transition.
let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => board.redrawAll(), 150);
});

// ---------------------------------------------------------------------------
// small helpers





/** The accounts whose games are shown, given the platform switch. */
function accounts(): Account[] {
  const platforms: Platform[] = state.view === "all" ? ["lichess", "chesscom", "local"] : [state.view];
  return platforms.filter((p) => state.names[p]).map((p) => ({ source: p, username: state.names[p] }));
}

function userColor(game: GameInfo): Color | null {
  const u = state.names[game.source ?? "lichess"].toLowerCase();
  if (!u) return null;
  if (game.white.name.toLowerCase() === u) return "white";
  if (game.black.name.toLowerCase() === u) return "black";
  return null;
}

function formatScore(s: Score): string {
  switch (s.kind) {
    case "cp": {
      const v = s.value / 100;
      return (v > 0 ? "+" : "") + v.toFixed(1);
    }
    case "mate":
      return `M${Math.abs(s.value)}`;
    default:
      return "#";
  }
}

/** The review predates English comments (only matters in English) or the
 *  comments about your opponent's moves ("Schwarz hatte Matt"). */
function outdatedComments(r: GameReview): "language" | "perspective" | null {
  if (lang === "en" && r.moves.some((m) => !m.commentEn)) return "language";
  if (r.moves.some((m) => !m.commentOther)) return "perspective";
  return null;
}

function badgeSvg(cls: Class): string {
  const c = CLASSES[cls];
  const size = c.symbol.length > 1 ? 44 : 56;
  return `<g transform="translate(66 -10)">
    <circle cx="22" cy="22" r="22" fill="${c.color}" stroke="#fff" stroke-width="3"/>
    <text x="22" y="23" text-anchor="middle" dominant-baseline="central" fill="#fff"
      font-family="system-ui, sans-serif" font-weight="800" font-size="${size * 0.5}">${esc(c.symbol)}</text>
  </g>`;
}



// ---------------------------------------------------------------------------
// engine status

async function checkEngine() {
  const el = $("engine-status");
  try {
    const s = await invoke<{ found: boolean; path: string | null }>("engine_status");
    if (s.found) {
      el.className = "engine-status ok";
      el.textContent = t("Stockfish bereit");
      el.title = s.path ?? "";
    } else {
      el.className = "engine-status warn";
      el.textContent = t("Stockfish fehlt: sudo apt install stockfish");
    }
  } catch (e) {
    el.className = "engine-status warn";
    el.textContent = String(e);
  }
}

// ---------------------------------------------------------------------------
// loading games


async function load(input: string) {
  input = input.trim();
  if (!input || state.view === "all") return;
  const list = $("games-list");
  if (input.includes("/") || input.includes(".org") || input.includes(".com")) {
    list.innerHTML = `<p class="empty">${t("Lade Partie …")}</p>`;
    try {
      const game = await invoke<GameInfo>("fetch_game", { url: input });
      state.games = [game];
      renderGames();
      selectGame(game);
    } catch (e) {
      list.innerHTML = `<p class="empty error">${esc(String(e))}</p>`;
    }
    return;
  }
  state.names[state.view] = input;
  store.set(`name-${state.view}`, input);
  await showStoredGames();
  if (currentTab === "stats") loadStats();
  syncGames();
}

/** Switch between Lichess, chess.com and both. */
function setView(view: Platform | "all") {
  state.view = view;
  store.set("view", view);
  document.querySelectorAll<HTMLElement>(".source-switch button").forEach((b) => b.classList.toggle("active", b.dataset.src === view));
  const input = $("load-input") as HTMLInputElement;
  const submit = document.querySelector<HTMLButtonElement>("#load-form button")!;
  if (view === "all" || view === "local") {
    input.value = "";
    input.disabled = submit.disabled = true;
    input.placeholder = view === "local" ? t("Partien gegen den Computer und eingespielte") : t("Namen unter „Lichess“ und „chess.com“ festlegen");
  } else {
    input.disabled = submit.disabled = false;
    input.value = state.names[view];
    input.placeholder = view === "lichess" ? t("Lichess-Name oder Partielink") : t("chess.com-Name");
  }
  setSyncStatus("ok", "");
  showStoredGames();
  if (currentTab === "stats") loadStats();
  syncGames();
}

document.querySelectorAll<HTMLElement>(".source-switch button").forEach((b) =>
  b.addEventListener("click", () => setView(b.dataset.src as Platform | "all")),
);

/** Changes whenever the shown accounts change, so stale async results are dropped. */
const accountsKey = () => JSON.stringify(accounts());

/** Show the games already stored locally (instant, works offline). */
async function showStoredGames() {
  const key = accountsKey();
  const accs = accounts();
  if (!accs.length) {
    state.games = [];
    renderGames();
    $("games-list").innerHTML =
      state.view === "all"
        ? `<p class="empty">${t("Lege unter „Lichess“ und/oder „chess.com“ deinen Namen fest.")}</p>`
        : `<p class="empty">${t("Gib deinen {platform}-Namen ein, um deine Partien zu laden.", { platform: platformLabel(state.view) })}</p>`;
    return;
  }
  try {
    const stored = await invoke<StoredGame[]>("list_games", { accounts: accs });
    if (key !== accountsKey()) return;
    state.games = stored;
    state.cached = new Set(stored.filter((g) => g.analysed).map((g) => g.id));
    for (const g of stored) if (g.accuracy) state.accuracy.set(g.id, g.accuracy);
    state.allGames = null;
    renderGames();
    if (filterActive()) loadFilterData();
  } catch (e) {
    $("games-list").innerHTML = `<p class="empty error">${esc(String(e))}</p>`;
  }
}

let syncing = false;

function setSyncStatus(kind: "busy" | "ok" | "offline" | "error", text: string) {
  const el = $("sync-status");
  el.className = `sync ${kind}`;
  el.textContent = text;
  el.title = kind === "error" ? text : "";
}

/** Pull new games (or, with `older`, the next older batch) for every shown account. */
async function syncGames(older = false) {
  const key = accountsKey();
  const accs = accounts();
  if (!accs.length || syncing) return;
  syncing = true;
  setSyncStatus("busy", older ? t("Lade ältere …") : t("Synchronisiere …"));
  if (!state.games.length) $("games-list").innerHTML = `<p class="empty">${t("Lade Partien …")}</p>`;
  let added = 0;
  let offline = false;
  const errors: string[] = [];
  for (const account of accs) {
    try {
      const res = await invoke<SyncResult>("sync_games", { account, older });
      added += res.added;
      offline ||= res.offline;
    } catch (e) {
      errors.push(`${platformLabel(account.source)}: ${e}`);
    }
  }
  syncing = false;
  if (key !== accountsKey()) return;
  if (added) await showStoredGames();
  if (errors.length) {
    setSyncStatus("error", t("Fehlgeschlagen"));
    $("sync-status").title = errors.join("\n");
  } else if (offline) {
    setSyncStatus("offline", t("Offline"));
  } else {
    setSyncStatus("ok", added ? t("{n} neu", { n: added }) : older ? t("Keine älteren") : t("Aktuell"));
  }
  // New games get analysed in the background, so statistics and puzzles keep up.
  if (added && !older && autoAnalysePref()) autoAnalyse(added);
  if (!state.games.length) {
    $("games-list").innerHTML = errors.length
      ? `<p class="empty error">${esc(errors.join(" · "))}</p>`
      : offline
        ? `<p class="empty">${t("Offline – und für diesen Namen sind noch keine Partien gespeichert.")}</p>`
        : state.view === "local"
          ? `<p class="empty">${t("Noch keine eigenen Partien – spiele im Reiter „Spielen“ gegen den Computer oder spiel eine Partie mit <b>+</b> oben ein.")}</p>`
          : `<p class="empty">${t("Keine Standard-Partien gefunden.")}</p>`;
  }
}

$("btn-sync").addEventListener("click", () => syncGames());

// Background analysis (automatic after a sync, or started in the statistics):
// show its progress next to the game list.
listen<{ done: number; total: number; finished: boolean }>("batch-progress", (e) => {
  if (syncing) return;
  const p = e.payload;
  if (p.finished) setSyncStatus("ok", t("Analysiert ✓"));
  else setSyncStatus("busy", t("Analysiere {done}/{total} …", { done: p.done, total: p.total }));
});

// ---------------------------------------------------------------------------
// tabs: Review | Statistik | Puzzles

type Tab = "review" | "stats" | "puzzles" | "openings" | "play";
const TABS: Tab[] = ["review", "stats", "puzzles", "openings", "play"];

/** Another mode (puzzles, openings, play) owns the board right now. */
const boardTaken = () => isPuzzleMode() || isOpeningMode() || isPlayMode();
let currentTab: Tab = "review";

function showTab(tab: Tab) {
  if (tab === currentTab) return;
  const leaving = currentTab;
  currentTab = tab;
  const layout = document.querySelector(".layout")!;
  layout.classList.toggle("stats-mode", tab === "stats");
  layout.classList.toggle("puzzle-mode", tab === "puzzles" || tab === "openings" || tab === "play");
  $("stats").hidden = tab !== "stats";
  $("puzzles").hidden = tab !== "puzzles";
  $("openings").hidden = tab !== "openings";
  $("play").hidden = tab !== "play";
  for (const t of TABS) $(`tab-${t}`).classList.toggle("active", t === tab);

  if (leaving === "puzzles" || leaving === "openings" || leaving === "play") {
    if (leaving === "puzzles") leavePuzzles();
    else if (leaving === "openings") leaveOpenings();
    else leavePlay();
    // Give the board back to the review.
    board.setShapes([]);
    if (state.review) renderPosition();
    else board.set({ fen: START_FEN, lastMove: undefined, movable: { color: undefined, dests: new Map() } });
  }
  if (tab === "stats") loadStats();
  if (tab === "puzzles" || tab === "openings" || tab === "play") {
    stopPlayback();
    stopLive();
    if (tab === "puzzles") enterPuzzles();
    else if (tab === "openings") enterOpenings();
    else enterPlay();
  }
}

for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => (t === currentTab ? tabHome(t) : showTab(t)));

/** Clicking the tab you're already in goes back to its start (menu). */
function tabHome(tab: Tab) {
  if (tab === "openings") openingsHome();
  else if (tab === "play") playHome();
  else if (tab === "stats") $("stats").scrollTo({ top: 0, behavior: "smooth" });
  else if (tab === "review") {
    if (training) exitTraining();
    else if (state.inVar) backToGame();
  }
}

/** Open a stored game (e.g. from the statistics) at a given ply. */
async function openGameAt(gameId: string, ply: number) {
  showTab("review");
  let game: GameInfo | undefined = state.games.find((g) => g.id === gameId);
  if (!game && accounts().length) {
    const all = await invoke<StoredGame[]>("list_games", { accounts: accounts(), limit: 100000 });
    game = all.find((g) => g.id === gameId);
  }
  if (game) {
    document.querySelector(`.game[data-id="${gameId}"]`)?.scrollIntoView({ block: "nearest" });
    selectGame(game, ply);
  }
}

initStats({
  accounts,
  depth: () => Number(($("depth") as HTMLSelectElement).value),
  openGame: openGameAt,
  onGamesAnalysed: () => showStoredGames(),
  practiceOpening: (color, family) => {
    showTab("openings");
    startFocus(color, family);
  },
  showTheoryExits: () => {
    showTab("openings");
    showTheoryExits();
  },
});

type Outcome = "win" | "draw" | "loss" | "neutral";

function outcome(g: GameInfo): Outcome {
  const me = userColor(g);
  if (!g.winner) return "draw";
  if (!me) return "neutral";
  return g.winner === me ? "win" : "loss";
}

function matchesFilter(g: GameInfo): boolean {
  if (filter.fav && !state.favorites.has(g.id)) return false;
  if (filter.result && outcome(g) !== filter.result) return false;
  if (filter.color && userColor(g) !== filter.color) return false;
  if (filter.speed && !(filter.speed === "correspondence" ? ["correspondence", "daily"].includes(g.speed) : g.speed === filter.speed)) return false;
  if (filter.analysis === "errors" && !((state.errors.get(g.id) ?? 0) > 0)) return false;
  if (filter.analysis === "pending" && state.cached.has(g.id)) return false;
  if (filter.q) {
    const hay = `${g.white.name} ${g.black.name} ${g.opening?.name ?? ""} ${openingName(g.opening?.name ?? "")}`.toLowerCase();
    if (!filter.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

/** With a filter: all stored games and the error counts (once per account set). */
async function loadFilterData() {
  const key = accountsKey();
  const accs = accounts();
  if (!accs.length) return;
  if (!state.allGames) {
    try {
      const all = await invoke<StoredGame[]>("list_games", { accounts: accs, limit: 1_000_000 });
      if (key !== accountsKey()) return;
      state.allGames = all;
      for (const g of all) {
        if (g.analysed) state.cached.add(g.id);
        if (g.accuracy) state.accuracy.set(g.id, g.accuracy);
      }
    } catch {
      state.allGames = state.games;
    }
  }
  if (filter.analysis === "errors") {
    state.errors = new Map(Object.entries(await invoke<Record<string, number>>("game_errors", { accounts: accs }).catch(() => ({}))));
  }
  if (key === accountsKey()) renderGames();
}

function onFilterChange() {
  $("gf-reset").hidden = !filterActive();
  ($("gf-more-btn") as HTMLElement).classList.toggle("on", !!(filter.result || filter.color || filter.speed || filter.analysis));
  $("gf-fav").classList.toggle("on", filter.fav);
  $("gf-fav-icon").textContent = filter.fav ? "★" : "☆";
  if (filterActive() && (!state.allGames || (filter.analysis === "errors" && !state.errors.size))) loadFilterData();
  renderGames();
}

function initGameFilter() {
  const search = $("gf-search") as HTMLInputElement;
  search.addEventListener("input", () => {
    filter.q = search.value.trim();
    onFilterChange();
  });
  $("gf-fav").addEventListener("click", () => {
    filter.fav = !filter.fav;
    onFilterChange();
  });
  $("gf-more-btn").addEventListener("click", () => {
    $("gf-more").hidden = !$("gf-more").hidden;
    $("gf-more-arrow").textContent = $("gf-more").hidden ? "▾" : "▴";
  });
  for (const key of ["result", "color", "speed", "analysis"] as const) {
    $(`gf-${key}`).addEventListener("change", (e) => {
      filter[key] = (e.target as HTMLSelectElement).value;
      onFilterChange();
    });
  }
  $("gf-reset").addEventListener("click", () => {
    Object.assign(filter, { q: "", fav: false, result: "", color: "", speed: "", analysis: "" });
    search.value = "";
    for (const key of ["result", "color", "speed", "analysis"]) ($(`gf-${key}`) as HTMLSelectElement).value = "";
    onFilterChange();
  });
  invoke<string[]>("favorites")
    .then((ids) => {
      state.favorites = new Set(ids);
      renderGames();
    })
    .catch(() => {});
}

async function toggleFavorite(id: string) {
  const on = !state.favorites.has(id);
  if (on) state.favorites.add(id);
  else state.favorites.delete(id);
  renderGames();
  await invoke("favorite_set", { gameId: id, on }).catch(() => {});
}

/**
 * Your accuracy in an analysed game as a thin bar under the entry: as long as
 * the accuracy, green from 85 %, yellow from 70 %, red below; the number on hover.
 */
function accuracyBar(g: GameInfo): string {
  const acc = state.accuracy.get(g.id);
  if (!acc || !state.cached.has(g.id)) return "";
  const me = userColor(g);
  const value = me ? acc[me] : (acc.white + acc.black) / 2;
  const level = value >= 85 ? "good" : value >= 70 ? "ok" : "weak";
  const title = me
    ? t("Deine Genauigkeit: {n} %", { n: Math.round(value) })
    : t("Genauigkeit Weiß {w} %, Schwarz {b} %", { w: Math.round(acc.white), b: Math.round(acc.black) });
  return `<span class="acc-bar ${level}" title="${title}"><i style="width:${Math.max(3, Math.min(100, value))}%"></i></span>`;
}

function renderGames() {
  const list = $("games-list");
  const source = filterActive() ? (state.allGames ?? state.games) : state.games;
  const shown = filterActive() ? source.filter(matchesFilter) : source;
  $("games-count").textContent = state.games.length ? String(filterActive() ? shown.length : state.games.length) : "";
  const tally = { win: 0, draw: 0, loss: 0, neutral: 0 };
  for (const g of shown) tally[outcome(g)]++;
  $("gf-summary").innerHTML = shown.length
    ? `${filterActive() ? `${tn(shown.length, "1 Partie", "{n} Partien")} · ` : ""}<span class="win">${tally.win} ${t("S")}</span> / <span class="draw">${tally.draw} ${t("R")}</span> / <span class="loss">${tally.loss} ${t("N")}</span>`
    : "";
  list.innerHTML = "";
  if (filterActive() && !shown.length) {
    list.innerHTML = `<p class="empty">${state.allGames ? t("Keine Partie passt zu diesem Filter.") : t("Lade Partien …")}</p>`;
    return;
  }
  for (const g of shown.slice(0, LIST_MAX)) {
    const me = userColor(g);
    const opp = me === "white" ? g.black : me === "black" ? g.white : null;
    let result: string;
    let resultClass: string;
    if (!g.winner) {
      result = "½";
      resultClass = "draw";
    } else if (me) {
      result = g.winner === me ? t("S") : t("N");
      resultClass = g.winner === me ? "win" : "loss";
    } else {
      result = g.winner === "white" ? "1–0" : "0–1";
      resultClass = "neutral";
    }
    const title = opp
      ? `${me === "white" ? "♙" : "♟"} ${t("vs {name}", { name: esc(playerName(opp.name)) })}${opp.rating ? ` <span class="muted">(${opp.rating})</span>` : ""}`
      : `${esc(playerName(g.white.name))} – ${esc(playerName(g.black.name))}`;
    const date = new Date(g.createdAt).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "2-digit" });
    const speed = [speedLabel(g.speed), g.timeControl].filter(Boolean).join(" ");

    const btn = document.createElement("button");
    btn.className = "game" + (state.game?.id === g.id ? " active" : "");
    btn.dataset.id = g.id;
    btn.innerHTML = `
      <span class="result ${resultClass}">${result}</span>
      ${state.view === "all" ? `<span class="platform ${g.source ?? "lichess"}" title="${platformLabel(g.source ?? "lichess")}">${g.source === "chesscom" ? "C" : g.source === "local" ? t("E") : "L"}</span>` : ""}
      <span class="game-main">
        <span class="game-title">${title}</span>
        <span class="game-sub">${esc(g.opening ? openingName(g.opening.name) : t("Unbekannte Eröffnung"))}</span>
        <span class="game-sub">${speed} · ${date} · ${tn(Math.ceil(g.moves.length / 2), "1 Zug", "{n} Züge")}</span>
        ${accuracyBar(g)}
      </span>
      <span class="game-side">
        <span class="fav ${state.favorites.has(g.id) ? "on" : ""}" role="button" tabindex="0" title="${state.favorites.has(g.id) ? t("Aus den Favoriten nehmen") : t("Als Favorit markieren")}">${state.favorites.has(g.id) ? "★" : "☆"}</span>
      </span>`;
    btn.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".fav")) {
        e.stopPropagation();
        toggleFavorite(g.id);
        return;
      }
      showTab("review");
      selectGame(g);
    });
    list.appendChild(btn);
  }
  if (shown.length > LIST_MAX) {
    list.insertAdjacentHTML("beforeend", `<p class="empty">${t("… und {n} weitere – stell den Filter genauer.", { n: shown.length - LIST_MAX })}</p>`);
  }
  if (!filterActive() && accounts().length && state.games.length && state.view !== "local") {
    const more = document.createElement("button");
    more.className = "load-older";
    more.textContent = state.view === "chesscom" ? t("Ältere Partien von chess.com laden") : t("Ältere Partien laden");
    more.addEventListener("click", () => syncGames(true));
    list.appendChild(more);
  }
}

// ---------------------------------------------------------------------------
// analysis

let analysisToken = 0;

async function selectGame(game: GameInfo, startPly = 0) {
  const token = ++analysisToken;
  stopPlayback();
  state.game = game;
  state.variation = null;
  state.inVar = false;
  stopLive();
  if (training) {
    clearTimeout(trainTimer);
    training = null;
    $("review-content").classList.remove("training");
    $("training-actions").hidden = true;
  }
  updateTrainButton();
  state.review = null;
  state.ply = 0;
  state.orientation = userColor(game) ?? "white";
  document.querySelectorAll<HTMLElement>(".game").forEach((el) => el.classList.toggle("active", el.dataset.id === game.id));

  setupSound();
  board.set({
    fen: START_FEN,
    lastMove: undefined,
    orientation: state.orientation,
    check: false,
    movable: { color: undefined, dests: new Map() },
  });
  board.setAutoShapes([]);
  renderPlayers();
  renderEvalBar();

  $("review-empty").hidden = true;
  $("review-content").hidden = true;
  $("review-progress").hidden = false;
  setProgress(0, game.moves.length + 1);

  $("refine").hidden = true;
  try {
    const depth = Number(($("depth") as HTMLSelectElement).value);
    // Already analysed at the chosen depth? Then it's there instantly. Otherwise
    // a quick preview first, refined in the background.
    const stored = await invoke<GameReview | null>("stored_review", { gameId: game.id, depth });
    if (token !== analysisToken) return;
    const first = stored ?? (await invoke<GameReview>("analyse_game", { game, depth: Math.min(PREVIEW_DEPTH, depth) }));
    if (token !== analysisToken) return;
    state.review = first;
    state.cached.add(game.id);
    state.accuracy.set(game.id, first.accuracy);
    renderGames();
    $("review-progress").hidden = true;
    $("review-content").hidden = false;
    renderSummary();
    renderMoveList();
    goto(startPly);
    renderGraph();
    updateTrainButton();
    if (first.depth < depth) {
      const pref = refinePref();
      if (pref === "always") refine(game, depth, token);
      else if (pref === "ask") askRefine(game, depth, token);
    } else if (outdatedComments(first)) {
      askRefine(game, first.depth, token, outdatedComments(first)!);
    }
  } catch (e) {
    if (token !== analysisToken) return;
    $("review-progress").hidden = true;
    const empty = $("review-empty");
    empty.hidden = false;
    empty.innerHTML = String(e) === "cancelled" ? t("Analyse abgebrochen.") : `<span class="error">${esc(String(e))}</span>`;
  }
}

/** Depth of the quick first review; the chosen depth follows in the background. */
const PREVIEW_DEPTH = 10;

/** After the quick preview: offer the full-depth analysis instead of starting it unasked. */
/** Offer the deep analysis – or, with `outdated`, a new analysis of an older
 *  review whose coach comments lack a language or your opponent's perspective. */
function askRefine(game: GameInfo, depth: number, token: number, outdated: "language" | "perspective" | null = null) {
  $("refine").hidden = false;
  $("refine-spin").hidden = true;
  $("refine-ask").hidden = false;
  $("refine-text").textContent =
    outdated === "language"
      ? t("Die Coach-Kommentare dieser älteren Analyse gibt es nur auf Deutsch.")
      : outdated === "perspective"
        ? t("Ältere Analyse: Die Züge deines Gegners kommentiert der Coach hier noch in der Du-Form.")
        : t("Schnellanalyse (Tiefe {d}). Tiefe Analyse (Tiefe {depth}) starten?", { d: state.review?.depth ?? "", depth });
  $("refine-yes").textContent = outdated ? t("Neu analysieren") : t("Tief analysieren");
  ($("refine-yes") as HTMLButtonElement).onclick = () => {
    if (token === analysisToken) refine(game, depth, token, !!outdated);
  };
  ($("refine-no") as HTMLButtonElement).onclick = () => {
    $("refine").hidden = true;
  };
}

/** Analyse at the full depth in the background and swap it in quietly. */
async function refine(game: GameInfo, depth: number, token: number, force = false) {
  $("refine").hidden = false;
  $("refine-spin").hidden = false;
  $("refine-ask").hidden = true;
  $("refine-text").textContent = t("Verfeinere Analyse …");
  let review: GameReview;
  try {
    review = await invoke<GameReview>("analyse_game", { game, depth, force });
  } catch {
    // cancelled (another game was opened) or failed: the preview stays
    if (token === analysisToken) $("refine").hidden = true;
    return;
  }
  if (token !== analysisToken || state.game?.id !== game.id) return;
  $("refine").hidden = true;
  // Exercises are built from the review; don't pull it away mid-exercise.
  if (training) return;
  state.review = review;
  state.accuracy.set(game.id, review.accuracy);
  renderGames();
  renderSummary();
  renderMoveList();
  renderGraph();
  updateTrainButton();
  if (!boardTaken()) renderPosition();
}

function setProgress(done: number, total: number) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  ($("review-progress").querySelector(".progress-fill") as HTMLElement).style.width = `${pct}%`;
  $("progress-text").textContent = `${pct} %`;
}

listen<Progress>("analysis-progress", (e) => {
  const p = e.payload;
  if (p.gameId !== state.game?.id) return;
  if (!state.review) setProgress(p.done, p.total);
  else if (p.depth >= state.review.depth && !$("refine").hidden && $("refine-ask").hidden) {
    $("refine-text").textContent = t("Verfeinere Analyse (Tiefe {d}) … {p} %", { d: p.depth, p: Math.round((p.done / p.total) * 100) });
  }
});

// ---------------------------------------------------------------------------
// rendering a position

// --- animated playback (used when jumping to the next mistake) -------------

/** Running animated playback: along the game (`main`) or through the variation (`var`). */
let playback: { timer: number; target: number; kind: "main" | "var" } | null = null;

function stopPlayback() {
  if (playback) clearTimeout(playback.timer);
  playback = null;
}

/** Step forward move by move until `target`, instead of jumping there. */
function playTo(target: number) {
  stopPlayback();
  const distance = target - state.ply;
  if (distance <= 1) {
    goto(target);
    return;
  }
  // Each step waits for the previous animation to finish; long jumps play a bit
  // faster (≈ 4 s max) but never faster than the animation itself.
  const stepMs = Math.min(500, Math.max(animMs + 60, 4000 / distance));
  const step = () => {
    show(state.ply + 1);
    if (state.ply >= target) {
      playback = null;
    } else {
      playback = { timer: window.setTimeout(step, stepMs), target, kind: "main" };
    }
  };
  playback = { timer: window.setTimeout(step, 0), target, kind: "main" };
}

/** User navigation on the main line: cancels playback and leaves any variation. */
function goto(ply: number) {
  stopPlayback();
  show(ply);
}

function show(ply: number) {
  const r = state.review;
  if (!r || training || boardTaken()) return;
  const before = state.inVar ? -1 : state.ply;
  state.inVar = false;
  state.ply = Math.max(0, Math.min(ply, r.moves.length));
  // A sound for every change of position – forward, back or jump (as on Lichess):
  // the move that leads to the position now shown.
  if (state.ply !== before) moveSound(r.moves[state.ply - 1]?.san ?? "");
  renderPosition();
}

/** Show the position after `index` moves of the variation (0 = branch point). */
function showVar(index: number) {
  stopPlayback();
  showVarStep(index);
}

/** Like showVar, but keeps a running playback going. */
function showVarStep(index: number) {
  const v = state.variation;
  if (!v || training || boardTaken()) return;
  const before = state.inVar ? state.varIndex : -1;
  state.inVar = true;
  state.varIndex = Math.max(0, Math.min(index, v.nodes.length));
  if (state.varIndex !== before) {
    // At the branch point that's the game move, otherwise the variation move.
    moveSound(v.nodes[state.varIndex - 1]?.san ?? state.review?.moves[v.basePly - 1]?.san ?? "");
  }
  renderPosition();
}

/** Step through the variation up to `target`, animated. */
function playVarTo(target: number) {
  stopPlayback();
  const step = () => {
    if (!state.variation || state.varIndex >= target) {
      playback = null;
      return;
    }
    showVarStep(state.varIndex + 1);
    playback = { timer: window.setTimeout(step, animMs + 450), target, kind: "var" };
  };
  playback = { timer: window.setTimeout(step, 400), target, kind: "var" };
}

/** Position before the n-th variation move (1-based). */
function varFenBefore(index: number): string {
  const v = state.variation!;
  return index <= 1 ? state.review!.fens[v.basePly] : v.nodes[index - 2].fen;
}

/**
 * "Zeig mir, was passiert": append the engine's best continuation after the
 * bad move on the board as a variation and play it.
 */
async function showConsequence() {
  const r = state.review;
  if (!r) return;
  stopPlayback();
  const node = currentVarNode();
  let fenBefore: string;
  let uci: string;
  if (node?.review) {
    fenBefore = varFenBefore(state.varIndex);
    uci = node.uci;
  } else if (!state.inVar && r.moves[state.ply - 1]) {
    fenBefore = r.fens[state.ply - 1];
    uci = r.moves[state.ply - 1].uci;
  } else {
    return;
  }
  const btn = document.getElementById("btn-why") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("Rechne …");
  }
  const where = { inVar: state.inVar, ply: state.ply, varIndex: state.varIndex, variation: state.variation };
  let refutation: Refutation;
  try {
    refutation = await invoke<Refutation>("refutation", { fen: fenBefore, uci });
  } catch (e) {
    if (btn) btn.textContent = String(e);
    return;
  }
  // The user moved on while the engine was thinking.
  if (where.inVar !== state.inVar || where.ply !== state.ply || where.varIndex !== state.varIndex || where.variation !== state.variation) return;
  const continuation = refutation.moves.slice(1);
  if (!continuation.length) {
    if (btn) btn.textContent = t("Danach ist die Partie vorbei.");
    return;
  }
  if (!state.inVar) {
    state.variation = { basePly: state.ply, nodes: [] };
    state.inVar = true;
    state.varIndex = 0;
  }
  const v = state.variation!;
  v.nodes.length = state.varIndex;
  for (const m of continuation) v.nodes.push({ fen: m.fen, san: m.san, uci: m.uci, check: m.check, engine: true });
  renderMoveList();
  showVarStep(state.varIndex);
  playVarTo(v.nodes.length);
}

function backToGame() {
  if (state.variation && state.inVar) goto(state.variation.basePly);
}

function deleteVariation() {
  const v = state.variation;
  if (!v) return;
  const base = v.basePly;
  state.variation = null;
  renderMoveList();
  goto(base);
}

/** The node currently shown, if the board is inside the variation past the branch point. */
function currentVarNode(): VarNode | undefined {
  return state.inVar && state.varIndex > 0 ? state.variation?.nodes[state.varIndex - 1] : undefined;
}

/**
 * The position for "In den Karteikasten" in the review: where *you* had to
 * move. On your turn that's the board; after your move, the position before
 * it – with the move you played. In a side line: the board as it is.
 */
function cardRequest(): CardRequest | null {
  const r = state.review;
  const g = state.game;
  if (!r || !g) return null;
  if (state.inVar) return { fen: currentFen(), source: "review", gameId: g.id };
  const me = userColor(g);
  const turn = (fen: string) => (fen.split(" ")[1] === "w" ? "white" : "black");
  let ply = state.ply;
  if (me && turn(r.fens[ply]) !== me && ply > 0) ply -= 1;
  return { fen: r.fens[ply], played: r.moves[ply]?.uci ?? null, source: "review", gameId: g.id, ply };
}

function currentFen(): string {
  const r = state.review!;
  if (state.inVar && state.variation) {
    return currentVarNode()?.fen ?? r.fens[state.variation.basePly];
  }
  return r.fens[state.ply];
}

/** Main-line ply the view is anchored to (the branch point while in a variation). */
function mainPly(): number {
  return state.inVar && state.variation ? state.variation.basePly : state.ply;
}

const NOT_BAD: Class[] = ["best", "brilliant", "great", "book", "forced"];

function moveShapes(m: { uci: string; classification: Class; bestUci: string | null }): DrawShape[] {
  const shapes: DrawShape[] = [{ orig: m.uci.slice(2, 4) as Key, customSvg: { html: badgeSvg(m.classification) } }];
  if (m.bestUci && m.bestUci !== m.uci && !NOT_BAD.includes(m.classification)) {
    shapes.push({ orig: m.bestUci.slice(0, 2) as Key, dest: m.bestUci.slice(2, 4) as Key, brush: "green" });
  }
  return shapes;
}

let baseShapes: DrawShape[] = [];
let liveShapes: DrawShape[] = [];
/** Review shapes – never while puzzles or openings own the board. */
const applyShapes = () => {
  if (boardTaken()) return;
  board.setAutoShapes([...baseShapes, ...liveShapes]);
};

let positionToken = 0;

/** Position the user's own arrows belong to; they are cleared when it changes. */
let drawnFen = "";

function renderPosition() {
  const r = state.review;
  if (!r) return;
  const fen = currentFen();
  const token = ++positionToken;

  let lastUci: string | undefined;
  let check = false;
  if (state.inVar) {
    const node = currentVarNode();
    const mainMove = r.moves[state.variation!.basePly - 1];
    lastUci = node?.uci ?? mainMove?.uci;
    check = node ? node.check : !!mainMove && /[+#]$/.test(mainMove.san);
    baseShapes = node?.review ? moveShapes(node.review) : !node && mainMove ? moveShapes(mainMove) : [];
  } else {
    const move = r.moves[state.ply - 1];
    lastUci = move?.uci;
    check = !!move && /[+#]$/.test(move.san);
    baseShapes = move ? moveShapes(move) : [];
  }
  liveShapes = [];
  if (fen !== drawnFen) board.setShapes([]);
  drawnFen = fen;
  const turn: Color = fen.split(" ")[1] === "w" ? "white" : "black";
  board.set({
    fen,
    turnColor: turn,
    lastMove: lastUci ? [lastUci.slice(0, 2) as Key, lastUci.slice(2, 4) as Key] : undefined,
    orientation: state.orientation,
    check,
    movable: { color: undefined, dests: new Map() },
  });
  applyShapes();

  // Legal moves come from the backend; ignore the answer if the user moved on meanwhile.
  invoke<PositionInfo>("position_info", { fen }).then((info) => {
    if (token !== positionToken) return;
    const dests = new Map(Object.entries(info.dests) as [Key, Key[]][]);
    board.set({ movable: { color: dests.size ? info.turn : undefined, dests } });
  });

  renderEvalBar();
  renderPlayers();
  renderCoach();
  updateGraphCursor();
  renderMoveHighlight();
  $("btn-back").hidden = !state.inVar;
  requestLive(fen);
}

// ---------------------------------------------------------------------------
// playing your own moves

async function onUserMove(orig: Key, dest: Key, promotion?: string) {
  if (isPuzzleMode()) return puzzleMove(orig, dest, promotion);
  if (isOpeningMode()) return openingMove(orig, dest, promotion);
  if (isPlayMode()) return playMove(orig, dest, promotion);
  if (training) return onTrainingMove(orig, dest, promotion);
  const r = state.review;
  if (!r) return;
  stopPlayback();
  const fen = currentFen();
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: orig, to: dest, promotion });
  } catch {
    renderPosition(); // snap the piece back
    return;
  }

  if (!state.inVar) {
    // Playing the game's own move just follows the main line.
    if (r.moves[state.ply]?.uci === played.uci) {
      show(state.ply + 1);
      return;
    }
    state.variation = { basePly: state.ply, nodes: [] };
    state.varIndex = 0;
  }
  const v = state.variation!;
  if (v.nodes[state.varIndex]?.uci === played.uci) {
    showVar(state.varIndex + 1);
    return;
  }
  v.nodes.length = state.varIndex; // playing a different move replaces the rest of the line
  const node: VarNode = { ...played };
  v.nodes.push(node);
  moveSound(node.san);
  state.inVar = true;
  state.varIndex = v.nodes.length;
  renderMoveList();
  renderPosition();

  try {
    node.review = await invoke<MoveReview>("evaluate_move", { fen, uci: played.uci });
  } catch (e) {
    node.error = String(e);
  }
  if (state.variation?.nodes.includes(node)) {
    renderMoveList();
    if (currentVarNode() === node) {
      baseShapes = node.review ? moveShapes(node.review) : [];
      applyShapes();
      renderCoach();
    }
  }
}

// ---------------------------------------------------------------------------
// live engine

let liveId = 0;
let liveTimer: number | undefined;
let live: LiveInfo | null = null;

function requestLive(fen: string) {
  clearTimeout(liveTimer);
  live = null;
  renderLive();
  if (!state.liveEnabled) return;
  const id = ++liveId;
  // Debounced so stepping quickly through moves doesn't restart the engine every time.
  liveTimer = window.setTimeout(() => {
    invoke("live_analyse", { id, fen }).catch((e) => {
      if (id === liveId) $("live-lines").innerHTML = `<p class="error">${esc(String(e))}</p>`;
    });
  }, 150);
}

function stopLive() {
  clearTimeout(liveTimer);
  liveId++;
  live = null;
  invoke("live_stop").catch(() => {});
}

listen<LiveInfo>("live-info", (e) => {
  if (e.payload.id !== liveId || training || boardTaken()) return;
  live = e.payload;
  renderLive();
  if (state.inVar) {
    renderEvalBar();
    const best = live.lines[0];
    liveShapes = best?.uci
      ? [{ orig: best.uci.slice(0, 2) as Key, dest: best.uci.slice(2, 4) as Key, brush: "blue" }]
      : [];
    applyShapes();
  }
});

function renderLive() {
  const depthEl = $("live-depth");
  const linesEl = $("live-lines");
  if (!state.liveEnabled) {
    depthEl.textContent = t("aus");
    linesEl.innerHTML = "";
    return;
  }
  if (!live) {
    depthEl.textContent = t("rechnet …");
    linesEl.innerHTML = "";
    return;
  }
  depthEl.textContent = live.depth ? t("Tiefe {d}", { d: live.depth }) + (live.done ? "" : " …") : "";
  linesEl.innerHTML = live.lines
    .map((l) => {
      const white = l.winWhite >= 50;
      const score = `<span class="live-score ${white ? "w" : "b"}">${formatScore(l.score)}</span>`;
      if (!l.uci) return `<div class="live-line">${score}<span class="live-pv muted">${t("Partie beendet")}</span></div>`;
      return `<button class="live-line" data-uci="${l.uci}">${score}<span class="live-pv">${esc(fig(l.line))}</span></button>`;
    })
    .join("");
  linesEl.querySelectorAll<HTMLElement>(".live-line[data-uci]").forEach((b) =>
    b.addEventListener("click", () => {
      const u = b.dataset.uci!;
      onUserMove(u.slice(0, 2) as Key, u.slice(2, 4) as Key, u[4]);
    }),
  );
}

$("live-toggle").addEventListener("change", (e) => {
  state.liveEnabled = (e.target as HTMLInputElement).checked;
  store.set("live", state.liveEnabled ? "1" : "0");
  if (state.liveEnabled && state.review) requestLive(currentFen());
  else {
    stopLive();
    liveShapes = [];
    applyShapes();
    renderLive();
    renderEvalBar();
  }
});

// --- clock times (when the platform recorded them) ---------------------------

/** "4:59", "1:02:03", or "9,5" under ten seconds – from centiseconds. */
function fmtClock(cs: number): string {
  if (cs < 1000) return (cs / 100).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const s = Math.floor(cs / 100);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Starting time and increment in centiseconds. */
function clockSetup(g: GameInfo): { initial: number; inc: number } | null {
  if (!g.clocks?.length) return null;
  const [base, inc] = (g.timeControl ?? "").split("+").map(Number);
  return {
    initial: Number.isFinite(base) && base > 0 ? Math.round(base * 6000) : g.clocks[0],
    inc: Number.isFinite(inc) ? inc * 100 : 0,
  };
}

/** Clock of `color` after main-line ply `ply` (i.e. after its last move up to there). */
function clockOf(g: GameInfo, color: Color, ply: number): number | null {
  const setup = clockSetup(g);
  if (!setup) return null;
  // own plies: white 1, 3, 5 … / black 2, 4, 6 …
  const last = color === "white" ? (ply % 2 === 1 ? ply : ply - 1) : ply % 2 === 0 ? ply : ply - 1;
  return last >= 1 ? (g.clocks![last - 1] ?? null) : setup.initial;
}

/** Time spent on the move at `ply` (1-based), in centiseconds. */
function thinkTime(g: GameInfo, ply: number): number | null {
  const setup = clockSetup(g);
  if (!setup || ply < 1 || ply > g.clocks!.length) return null;
  const before = ply > 2 ? g.clocks![ply - 3] : setup.initial;
  return Math.max(0, before - g.clocks![ply - 1] + (ply > 2 ? setup.inc : 0));
}

function renderPlayers() {
  const g = state.game;
  if (!g) return;
  const r = state.review;
  const ply = mainPly();
  const turn: Color = ply % 2 === 0 ? "white" : "black";
  const html = (c: Color) => {
    const p = g[c];
    const acc = r ? `<span class="acc">${r.accuracy[c].toFixed(1)}</span>` : "";
    const clock = r ? clockOf(g, c, ply) : null;
    const clockHtml =
      clock === null ? "" : `<span class="pclock${turn === c ? " running" : ""}" title="${t("Restzeit")}">${fmtClock(clock)}</span>`;
    return `<span class="pdot ${c}"></span><span class="pname">${esc(playerName(p.name))}</span>${p.rating ? `<span class="muted">${p.rating}</span>` : ""}${acc}${clockHtml}`;
  };
  const bottom = state.orientation;
  const top: Color = bottom === "white" ? "black" : "white";
  $("player-top").innerHTML = html(top);
  $("player-bottom").innerHTML = html(bottom);
}

function renderEvalBar() {
  const bar = $("evalbar");
  const fill = bar.querySelector(".evalbar-fill") as HTMLElement;
  const label = bar.querySelector(".evalbar-label") as HTMLElement;
  const r = state.review;
  let win = 50;
  let text = "";
  if (r && state.inVar) {
    const top = live?.lines[0];
    if (top) {
      win = top.winWhite;
      text = formatScore(top.score);
    } else {
      // Keep the bar where it was until the engine reports.
      win = parseFloat(fill.style.height) || 50;
      text = label.textContent ?? "";
    }
  } else if (r) {
    win = r.winWhite[state.ply];
    text = formatScore(r.evals[state.ply]);
  }
  bar.classList.toggle("flipped", state.orientation === "black");
  fill.style.height = `${win}%`;
  label.textContent = text;
  label.classList.toggle("on-white", win >= 50);
}

function renderCoach() {
  const head = $("coach-head");
  const text = $("coach-text");
  const best = $("coach-best");
  const r = state.review!;
  const node = currentVarNode();
  const tag = state.inVar ? `<span class="var-tag">${t("Variante")}</span>` : "";
  if (node?.engine) {
    head.innerHTML = `<span class="coach-title"><b>${esc(fig(node.san))}</b></span><span class="var-tag engine">${t("Engine-Fortsetzung")}</span>`;
    head.style.setProperty("--c", "#5b8dd6");
    text.innerHTML = t("So würde es nach dem Fehler weitergehen – die besten Züge laut Stockfish.");
    best.innerHTML = `<span class="muted">${t("Mit Esc oder „↩ Zur Partie“ geht es zurück. Du kannst von hier aus auch selbst weiterziehen.")}</span>`;
    return;
  }
  if (node && !node.review) {
    head.innerHTML = `<span class="coach-title"><b>${esc(fig(node.san))}</b></span>${tag}`;
    head.style.setProperty("--c", "var(--border)");
    text.innerHTML = node.error ? `<span class="error">${esc(node.error)}</span>` : `<span class="muted">${t("Bewerte deinen Zug …")}</span>`;
    best.innerHTML = "";
    return;
  }
  const move = node ? node.review : r.moves[mainPly() - 1];
  if (!move) {
    head.style.setProperty("--c", "var(--border)");
    const g = state.game!;
    head.innerHTML = `<span class="coach-title">${t("Partie-Review")}</span>`;
    const howTo = t("Mit → gehst du Zug für Zug durch die Partie, mit N springst du zu deinem nächsten Fehler.");
    text.textContent = g.opening ? `${openingName(g.opening.name)} (${g.opening.eco}). ${howTo}` : howTo;
    best.innerHTML = `<span class="muted">${t("Analysiert mit Stockfish, Tiefe {d}", { d: r.depth })}</span>`;
    return;
  }
  const info = CLASSES[move.classification];
  const num = Math.ceil(move.ply / 2) + (move.color === "white" ? "." : "...");
  const think = node ? null : thinkTime(state.game!, move.ply);
  const thinkHtml = think === null ? "" : `<span class="think" title="${t("Bedenkzeit für diesen Zug")}">⏱ ${fmtClock(think)}</span>`;
  head.innerHTML = `${badgeHtml(move.classification)}<span class="coach-title">${t("{move} ist {phrase}", { move: `<b>${num} ${esc(fig(move.san))}</b>`, phrase: info.phrase })}</span>${tag}${thinkHtml}`;
  head.style.setProperty("--c", info.color);
  // Your own moves and your tries on the board: "du". Your opponent's moves
  // (and every move of a game you didn't play): about the mover.
  const mine = !!node || userColor(state.game!) === move.color;
  text.innerHTML = esc(fig(commentOf(move, mine)));
  const showBest = move.bestSan && move.bestUci !== move.uci && !NOT_BAD.includes(move.classification);
  best.innerHTML = showBest
    ? `<span class="best-label">${t("Bester Zug")}</span> <b>${esc(fig(move.bestSan!))}</b>${move.bestLine ? `<div class="best-line">${esc(fig(move.bestLine))}</div>` : ""}`
    : "";
  if (BAD.includes(move.classification)) {
    best.innerHTML += `<button id="btn-why" class="why-btn">${t("Zeig mir, was passiert")}</button>`;
    $("btn-why").addEventListener("click", showConsequence);
  }
}

function renderSummary() {
  const r = state.review!;
  const g = state.game!;
  renderPlayers();
  const counts = { white: {} as Record<string, number>, black: {} as Record<string, number> };
  for (const m of r.moves) counts[m.color][m.classification] = (counts[m.color][m.classification] ?? 0) + 1;
  const rows = SUMMARY_ORDER.map((c) => {
    const w = counts.white[c] ?? 0;
    const b = counts.black[c] ?? 0;
    return `<tr class="${w + b === 0 ? "zero" : ""}">
      <td class="num" style="color:${CLASSES[c].color}">${w}</td>
      <td class="cls">${badgeHtml(c)}<span>${CLASSES[c].label}</span></td>
      <td class="num" style="color:${CLASSES[c].color}">${b}</td>
    </tr>`;
  }).join("");
  $("summary-table").innerHTML = `
    <tr class="names"><th>${esc(playerName(g.white.name))}</th><th></th><th>${esc(playerName(g.black.name))}</th></tr>
    <tr class="accuracy"><td>${r.accuracy.white.toFixed(1)}</td><td class="cls">${t("Genauigkeit")}</td><td>${r.accuracy.black.toFixed(1)}</td></tr>
    ${rows}`;
}

function badgeIfNotable(c: Class): string {
  return BAD.includes(c) || c === "brilliant" || c === "great" ? badgeHtml(c) : "";
}

function renderVariation(): string {
  const v = state.variation;
  if (!v || v.nodes.length === 0) return "";
  const parts = v.nodes.map((n, i) => {
    const ply = v.basePly + i + 1;
    const white = ply % 2 === 1;
    const num = white ? `${(ply + 1) / 2}. ` : i === 0 ? `${ply / 2}... ` : "";
    const mark = n.review ? badgeIfNotable(n.review.classification) : n.error || n.engine ? "" : `<span class="pending"></span>`;
    return `<button class="vmv${n.engine ? " engine" : ""}" data-var="${i + 1}">${num}${mark}<span>${esc(fig(n.san))}</span></button>`;
  });
  return `<div class="variation">${parts.join("")}<button class="var-close" title="${t("Variante löschen")}">✕</button></div>`;
}

function renderMoveList() {
  const r = state.review!;
  const el = $("moves");
  const v = state.variation;
  // The variation is shown under the row that contains its branch point.
  const varRow = v && v.nodes.length ? Math.max(0, Math.ceil(v.basePly / 2) - 1) : -1;
  let html = v && v.basePly === 0 ? renderVariation() : "";
  for (let i = 0; i < r.moves.length; i += 2) {
    const cell = (m?: MoveReview) =>
      m
        ? `<button class="mv" data-ply="${m.ply}">${badgeIfNotable(m.classification)}<span>${esc(fig(m.san))}</span></button>`
        : `<span></span>`;
    html += `<span class="mvnum">${i / 2 + 1}.</span>${cell(r.moves[i])}${cell(r.moves[i + 1])}`;
    if (v && v.basePly > 0 && i / 2 === varRow) html += renderVariation();
  }
  el.innerHTML = html;
  el.querySelectorAll<HTMLElement>(".mv").forEach((b) => b.addEventListener("click", () => goto(Number(b.dataset.ply))));
  el.querySelectorAll<HTMLElement>(".vmv").forEach((b) => b.addEventListener("click", () => showVar(Number(b.dataset.var))));
  el.querySelector(".var-close")?.addEventListener("click", deleteVariation);
  renderMoveHighlight();
}

function renderMoveHighlight() {
  document.querySelectorAll<HTMLElement>(".mv").forEach((el) => {
    const active = !state.inVar && Number(el.dataset.ply) === state.ply;
    el.classList.toggle("active", active);
    if (active) revealMove(el);
  });
  document.querySelectorAll<HTMLElement>(".vmv").forEach((el) => {
    const active = state.inVar && Number(el.dataset.var) === state.varIndex;
    el.classList.toggle("active", active);
    if (active) revealMove(el);
  });
}

/** Scroll the move list (and only the move list) so `el` is visible. scrollIntoView
 *  would also scroll the page and the right column, making the board jump. */
function revealMove(el: HTMLElement) {
  const box = el.closest<HTMLElement>(".moves-panel");
  if (!box) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollBy({ top: r.top - b.top - 4, behavior: "smooth" });
  else if (r.bottom > b.bottom) box.scrollBy({ top: r.bottom - b.bottom + 4, behavior: "smooth" });
}

// Scrolling inside the move list stays there, also at its top and bottom
// (some WebKitGTK versions ignore `overscroll-behavior`, so it's done by hand).
document.querySelector<HTMLElement>(".moves-panel")!.addEventListener(
  "wheel",
  (e) => {
    const box = e.currentTarget as HTMLElement;
    const atTop = box.scrollTop <= 0;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
    if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
  },
  { passive: false },
);

let graphWidth = 0;

/** Slide the cursor to the current ply (the graph itself is only redrawn when it changes). */
function updateGraphCursor() {
  const r = state.review;
  const cursor = document.getElementById("graph-cursor");
  if (!r || !cursor) return;
  const n = r.winWhite.length - 1;
  cursor.style.transform = `translateX(${n ? (mainPly() / n) * graphWidth : 0}px)`;
}

function renderGraph() {
  const r = state.review;
  const svg = $("graph") as unknown as SVGSVGElement;
  if (!r) return;
  const w = svg.clientWidth || 300;
  const h = svg.clientHeight || 90;
  const n = r.winWhite.length - 1;
  const x = (i: number) => (n ? (i / n) * w : 0);
  // White's chances are drawn from the bottom when White is at the bottom.
  const y = (win: number) => (state.orientation === "white" ? h - (win / 100) * h : (win / 100) * h);
  const pts = r.winWhite.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const base = state.orientation === "white" ? h : 0;
  const dots = r.moves
    .filter((m) => ["mistake", "miss", "blunder", "brilliant", "great"].includes(m.classification))
    .map((m) => `<circle cx="${x(m.ply)}" cy="${y(r.winWhite[m.ply])}" r="3.5" fill="${CLASSES[m.classification].color}" />`)
    .join("");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  graphWidth = w;
  svg.innerHTML = `
    <rect width="${w}" height="${h}" class="graph-bg"/>
    <polygon points="0,${base} ${pts} ${w},${base}" class="graph-area"/>
    <line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" class="graph-mid"/>
    <line id="graph-cursor" x1="0" x2="0" y1="0" y2="${h}" class="graph-cursor"/>
    ${dots}`;
  updateGraphCursor();
}

$("graph").addEventListener("click", (e) => {
  const r = state.review;
  if (!r) return;
  const rect = (e.currentTarget as Element).getBoundingClientRect();
  goto(Math.round(((e.clientX - rect.left) / rect.width) * (r.winWhite.length - 1)));
});
window.addEventListener("resize", renderGraph);

// ---------------------------------------------------------------------------
// "Aus Fehlern lernen": replay your own mistakes as exercises

type TrainResult = "solved" | "hint" | "shown" | "skipped";

interface Training {
  items: MoveReview[];
  index: number;
  phase: "solve" | "checking" | "wrong" | "showing" | "solved" | "done";
  results: (TrainResult | null)[];
  hint: boolean;
  /** The user's last try (wrong or right) and the engine's verdict on it. */
  attempt: { played: PlayedMove; review?: MoveReview } | null;
  /** While true the board still shows the wrong try before snapping back. */
  showAttempt: boolean;
  /** Engine continuation after the wrong try, while it's played on the board. */
  refute?: Refutation & { uci: string; shown: number };
}

let training: Training | null = null;
let trainTimer: number | undefined;

const TRAIN_CLASSES: Class[] = ["mistake", "miss", "blunder"];
const ACCEPTED: Class[] = ["brilliant", "great", "best", "excellent"];

function trainingItems(): MoveReview[] {
  const r = state.review;
  if (!r || !state.game) return [];
  const me = userColor(state.game) ?? state.orientation;
  return r.moves.filter((m) => m.color === me && TRAIN_CLASSES.includes(m.classification) && m.bestUci);
}

function updateTrainButton() {
  const n = trainingItems().length;
  const btn = $("btn-train") as HTMLButtonElement;
  $("btn-card").hidden = !state.review || !!training;
  btn.hidden = !state.review || !!training;
  btn.disabled = n === 0;
  btn.title = n ? t("{n} eigene Fehler als Übung durchgehen (T)", { n }) : t("Keine eigenen Fehler in dieser Partie");
}

function startTraining() {
  const items = trainingItems();
  if (!items.length || !state.review) return;
  stopPlayback();
  stopLive();
  // Start at the mistake currently on the board, if there is one.
  const here = items.findIndex((m) => m.ply === state.ply && !state.inVar);
  training = {
    items,
    index: Math.max(0, here),
    phase: "solve",
    results: items.map(() => null),
    hint: false,
    attempt: null,
    showAttempt: false,
  };
  state.inVar = false;
  $("review-content").classList.add("training");
  updateTrainButton();
  renderTraining();
}

function exitTraining() {
  if (!training) return;
  const ply = training.items[training.index]?.ply ?? state.ply;
  clearTimeout(trainTimer);
  training = null;
  $("review-content").classList.remove("training");
  $("training-actions").hidden = true;
  updateTrainButton();
  goto(ply);
}

function trainingGoto(index: number) {
  const tr = training!;
  clearTimeout(trainTimer);
  tr.index = index;
  tr.hint = false;
  tr.attempt = null;
  tr.showAttempt = false;
  tr.phase = index >= tr.items.length ? "done" : "solve";
  renderTraining();
}

function finishItem(result: TrainResult) {
  const tr = training!;
  tr.results[tr.index] = tr.results[tr.index] ?? result;
}

async function onTrainingMove(orig: Key, dest: Key, promotion?: string) {
  const tr = training!;
  const r = state.review!;
  if (tr.phase !== "solve" && tr.phase !== "wrong") return;
  const item = tr.items[tr.index];
  const fen = r.fens[item.ply - 1];
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: orig, to: dest, promotion });
  } catch {
    renderTraining();
    return;
  }
  const step = tr.index;
  clearTimeout(trainTimer);
  tr.attempt = { played };
  tr.showAttempt = true;

  moveSound(played.san);
  if (played.uci === item.bestUci) {
    tr.phase = "solved";
    finishItem(tr.hint ? "hint" : "solved");
    successSound();
    renderTraining();
    return;
  }
  tr.phase = "checking";
  renderTraining();
  let review: MoveReview | undefined;
  try {
    review = await invoke<MoveReview>("evaluate_move", { fen, uci: played.uci });
  } catch (e) {
    console.error(e);
  }
  if (training !== tr || tr.index !== step || tr.attempt?.played !== played) return;
  tr.attempt.review = review;
  if (review && ACCEPTED.includes(review.classification)) {
    tr.phase = "solved";
    finishItem(tr.hint ? "hint" : "solved");
    successSound();
    renderTraining();
    return;
  }
  tr.phase = "wrong";
  errorSound();
  renderTraining();
  // Let the user see the refuted try for a moment, then reset the position.
  trainTimer = window.setTimeout(() => {
    if (training === tr && tr.index === step && tr.phase === "wrong") {
      tr.showAttempt = false;
      renderTraining();
    }
  }, 1400);
}

async function showSolution() {
  const tr = training!;
  const r = state.review!;
  const item = tr.items[tr.index];
  if (!item.bestUci) return;
  clearTimeout(trainTimer);
  const played = await invoke<PlayedMove>("play_move", {
    fen: r.fens[item.ply - 1],
    from: item.bestUci.slice(0, 2),
    to: item.bestUci.slice(2, 4),
    promotion: item.bestUci[4],
  });
  if (training !== tr) return;
  finishItem("shown");
  tr.attempt = { played };
  tr.showAttempt = true;
  tr.phase = "solved";
  renderTraining();
}

function trainingDots(): string {
  const tr = training!;
  return `<span class="train-dots">${tr.items
    .map((_, i) => `<span class="train-dot ${tr.results[i] ?? ""} ${i === tr.index && tr.phase !== "done" ? "current" : ""}"></span>`)
    .join("")}</span>`;
}

function renderTraining() {
  const tr = training;
  const r = state.review;
  if (!tr || !r) return;
  const head = $("coach-head");
  const text = $("coach-text");
  const best = $("coach-best");
  const actions = $("training-actions");
  actions.hidden = false;
  best.innerHTML = "";

  if (tr.phase === "done") {
    const count = (k: TrainResult) => tr.results.filter((x) => x === k).length;
    head.innerHTML = `<span class="coach-title">${t("Geschafft!")}</span>${trainingDots()}`;
    head.style.setProperty("--c", "var(--accent)");
    const open = count("shown") + count("skipped");
    text.innerHTML =
      t("Du hast <b>{s}</b> von {n} Fehlern selbst gelöst", { s: count("solved"), n: tr.items.length }) +
      (count("hint") ? t(", <b>{h}</b> mit Tipp", { h: count("hint") }) : "") +
      "." +
      (open ? " " + t("{o} offen – die lohnt es sich nochmal anzuschauen.", { o: open }) : "");
    actions.innerHTML = `<button data-act="restart">${t("Nochmal von vorn")}</button><button data-act="exit" class="primary">${t("Zurück zur Review")}</button>`;
    bindTrainingActions();
    board.set({ movable: { color: undefined, dests: new Map() } });
    board.setAutoShapes([]);
    return;
  }

  if (tr.phase === "showing") {
    renderTrainingShowing(tr);
    return;
  }

  const item = tr.items[tr.index];
  const fen = r.fens[item.ply - 1];
  const prevMove = r.moves[item.ply - 2];
  const side = item.color === "white" ? t("Weiß") : t("Schwarz");
  const attempt = tr.showAttempt ? tr.attempt : null;
  state.ply = item.ply - 1;
  state.orientation = item.color;
  renderPlayers();

  // Board: either the puzzle position or the user's try on top of it.
  const shapes: DrawShape[] = [];
  if (attempt) {
    const cls: Class | undefined = tr.phase === "solved" ? (attempt.review?.classification ?? "best") : attempt.review?.classification;
    if (cls) shapes.push({ orig: attempt.played.uci.slice(2, 4) as Key, customSvg: { html: badgeSvg(cls) } });
  } else if (tr.hint && item.bestUci) {
    shapes.push({ orig: item.bestUci.slice(0, 2) as Key, brush: "green" });
  }
  const lastUci = attempt ? attempt.played.uci : prevMove?.uci;
  board.set({
    fen: attempt ? attempt.played.fen : fen,
    turnColor: attempt ? (item.color === "white" ? "black" : "white") : item.color,
    lastMove: lastUci ? [lastUci.slice(0, 2) as Key, lastUci.slice(2, 4) as Key] : undefined,
    orientation: item.color,
    check: attempt ? attempt.played.check : !!prevMove && /[+#]$/.test(prevMove.san),
    movable: { color: undefined, dests: new Map() },
  });
  board.setAutoShapes(shapes);
  const shown = attempt ? attempt.played.fen : fen;
  if (shown !== drawnFen) board.setShapes([]);
  drawnFen = shown;
  renderEvalBar();
  updateGraphCursor();

  const canMove = !attempt && (tr.phase === "solve" || tr.phase === "wrong");
  if (canMove) {
    const token = ++positionToken;
    invoke<PositionInfo>("position_info", { fen }).then((info) => {
      if (token !== positionToken || training !== tr) return;
      board.set({ movable: { color: item.color, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
    });
  }

  head.innerHTML = `<span class="coach-title">${t("Aufgabe {i} von {n}", { i: tr.index + 1, n: tr.items.length })}</span>${trainingDots()}`;
  const info = CLASSES[item.classification];
  const num = Math.ceil(item.ply / 2) + (item.color === "white" ? "." : "...");
  const task = t("In der Partie hast du hier {move} gespielt – {phrase}. Finde einen besseren Zug für {side}.", {
    move: `<b>${num} ${esc(fig(item.san))}</b>`,
    phrase: info.phrase,
    side,
  });

  switch (tr.phase) {
    case "solve":
      head.style.setProperty("--c", info.color);
      text.innerHTML = task + (tr.hint && item.bestUci ? ` <span class="muted">${t("Tipp: Zieh mit der markierten Figur.")}</span>` : "");
      break;
    case "checking":
      head.style.setProperty("--c", "var(--border)");
      text.innerHTML = `<span class="muted">${t("Prüfe {move} …", { move: esc(fig(tr.attempt!.played.san)) })}</span>`;
      break;
    case "wrong": {
      const rv = tr.attempt?.review;
      head.style.setProperty("--c", rv ? CLASSES[rv.classification].color : "var(--danger)");
      text.innerHTML = rv
        ? `${badgeHtml(rv.classification)} ${t("{move} ist {phrase}", { move: `<b>${esc(fig(rv.san))}</b>`, phrase: CLASSES[rv.classification].phrase })}. ${esc(fig(commentOf(rv)))}<br><span class="muted">${t("Versuch es nochmal.")}</span>`
        : `${t("{move} ist nicht besser.", { move: `<b>${esc(fig(tr.attempt!.played.san))}</b>` })} <span class="muted">${t("Versuch es nochmal.")}</span>`;
      if (tr.hint && item.bestUci) text.innerHTML += `<br><span class="hint-text">${t("Tipp: Zieh mit der markierten Figur.")}</span>`;
      break;
    }
    case "solved": {
      const shown = tr.results[tr.index] === "shown";
      const rv = tr.attempt?.review;
      head.style.setProperty("--c", shown ? "var(--muted)" : "var(--accent)");
      const san = esc(fig(tr.attempt!.played.san));
      text.innerHTML = shown
        ? t("Die Lösung war {move}.", { move: `<b>${san}</b>` })
        : rv && rv.bestUci !== rv.uci
          ? t("<b>Gut!</b> {move} funktioniert auch – {phrase}.", { move: san, phrase: CLASSES[rv.classification].phrase })
          : t("<b>Richtig!</b> {move} ist der beste Zug.", { move: san });
      if (item.bestLine) best.innerHTML = `<span class="best-label">${t("Engine-Variante")}</span><div class="best-line">${esc(fig(item.bestLine))}</div>`;
      break;
    }
  }

  const last = tr.index === tr.items.length - 1;
  actions.innerHTML =
    tr.phase === "solved"
      ? `<button data-act="exit">${t("Beenden")}</button><button data-act="next" class="primary">${last ? t("Ergebnis") : t("Weiter")} →</button>`
      : `${tr.phase === "wrong" && tr.attempt ? `<button data-act="why" class="primary">${t("Zeig mir, was passiert")}</button>` : ""}
         <button data-act="hint" ${tr.hint || tr.phase === "checking" ? "disabled" : ""}>${t("Tipp")}</button>
         <button data-act="solution" ${tr.phase === "checking" ? "disabled" : ""}>${t("Lösung zeigen")}</button>
         <button data-act="skip">${t("Überspringen")}</button>
         <button data-act="exit" class="end">${t("Beenden")}</button>`;
  bindTrainingActions();
}

/** Play the wrong try and the engine's answer on the board. */
async function showTrainingWhy() {
  const tr = training;
  const r = state.review;
  if (!tr || !r || !tr.attempt) return;
  clearTimeout(trainTimer);
  const item = tr.items[tr.index];
  const fenBefore = r.fens[item.ply - 1];
  const uci = tr.attempt.played.uci;
  tr.phase = "showing";
  if (!tr.refute || tr.refute.uci !== uci) {
    tr.refute = undefined;
    renderTraining();
    try {
      const ref = await invoke<Refutation>("refutation", { fen: fenBefore, uci });
      tr.refute = { ...ref, uci, shown: 0 };
    } catch (e) {
      if (training !== tr) return;
      tr.phase = "wrong";
      renderTraining();
      $("coach-text").innerHTML += `<br><span class="error">${esc(String(e))}</span>`;
      return;
    }
    if (training !== tr || tr.phase !== "showing") return;
  }
  const ref = tr.refute!;
  ref.shown = 0;
  const prev = r.moves[item.ply - 2];
  board.set({
    fen: fenBefore,
    lastMove: prev ? [prev.uci.slice(0, 2) as Key, prev.uci.slice(2, 4) as Key] : undefined,
    check: false,
    movable: { color: undefined, dests: new Map() },
  });
  board.setAutoShapes([]);
  renderTraining();
  const stepOnce = () => {
    if (training !== tr || tr.phase !== "showing") return;
    const m = ref.moves[ref.shown];
    if (!m) return renderTraining();
    board.set({ fen: m.fen, lastMove: [m.uci.slice(0, 2) as Key, m.uci.slice(2, 4) as Key], check: m.check });
    board.setAutoShapes(ref.shown === 0 ? [{ orig: m.uci.slice(2, 4) as Key, customSvg: { html: badgeSvg("blunder") } }] : []);
    ref.shown++;
    renderTraining();
    trainTimer = window.setTimeout(stepOnce, animMs + 550);
  };
  trainTimer = window.setTimeout(stepOnce, 350);
}

function renderTrainingShowing(tr: Training) {
  const head = $("coach-head");
  const text = $("coach-text");
  const actions = $("training-actions");
  head.innerHTML = `<span class="coach-title">${t("Aufgabe {i} von {n}", { i: tr.index + 1, n: tr.items.length })}</span>${trainingDots()}`;
  head.style.setProperty("--c", "var(--danger)");
  const ref = tr.refute;
  if (!ref) {
    text.innerHTML = `<span class="muted">${t("Berechne, wie der Gegner antwortet …")}</span>`;
    actions.innerHTML = `<button data-act="back">${t("Zurück zur Aufgabe")}</button>`;
  } else {
    let i = 0;
    const line = ref.text
      .split(" ")
      .map((tok) => {
        if (/^\d+\.+$/.test(tok)) return `<span class="muted">${tok}</span>`;
        const cls = i === 0 ? "ref-mine" : i < ref.shown ? "ref-shown" : "ref-next";
        i++;
        return `<span class="${cls}">${esc(fig(tok))}</span>`;
      })
      .join(" ");
    text.innerHTML = `<b>${t("So geht es nach deinem Zug weiter:")}</b><br><span class="ref-line">${line}</span>`;
    const done = ref.shown >= ref.moves.length;
    actions.innerHTML = `<button data-act="why" ${done ? "" : "disabled"}>${t("Nochmal abspielen")}</button>
      <button data-act="back" class="primary">${t("Zurück zur Aufgabe")}</button>`;
  }
  bindTrainingActions();
}

function bindTrainingActions() {
  $("training-actions")
    .querySelectorAll<HTMLButtonElement>("button[data-act]")
    .forEach((b) =>
      b.addEventListener("click", () => {
        const tr = training;
        if (!tr) return;
        switch (b.dataset.act) {
          case "hint":
            tr.hint = true;
            renderTraining();
            break;
          case "why":
            showTrainingWhy();
            break;
          case "back":
            clearTimeout(trainTimer);
            tr.phase = "wrong";
            tr.showAttempt = false;
            renderTraining();
            break;
          case "solution":
            showSolution();
            break;
          case "skip":
            finishItem("skipped");
            trainingGoto(tr.index + 1);
            break;
          case "next":
            trainingGoto(tr.index + 1);
            break;
          case "restart":
            tr.results = tr.items.map(() => null);
            trainingGoto(0);
            break;
          case "exit":
            exitTraining();
            break;
        }
      }),
    );
}

$("btn-train").addEventListener("click", startTraining);
bindCardButton($("btn-card") as HTMLButtonElement, cardRequest);

// ---------------------------------------------------------------------------
// navigation

function nextMistake() {
  const r = state.review;
  if (!r) return;
  // Pressing again while it is still playing skips straight to the mistake.
  if (playback?.kind === "main") {
    goto(playback.target);
    return;
  }
  stopPlayback();
  if (state.inVar) state.ply = mainPly();
  const me = (state.game && userColor(state.game)) ?? state.orientation;
  const next = r.moves.find((m) => m.ply > state.ply && m.color === me && ["mistake", "miss", "blunder"].includes(m.classification));
  if (next) playTo(next.ply);
}

function flip() {
  state.orientation = state.orientation === "white" ? "black" : "white";
  board.set({ orientation: state.orientation });
  applyShapes();
  renderPlayers();
  renderEvalBar();
  renderGraph();
}

function prev() {
  if (!state.inVar) return goto(state.ply - 1);
  if (state.varIndex > 0) showVar(state.varIndex - 1);
  else goto(mainPly() - 1);
}

function next() {
  if (!state.inVar) return goto(state.ply + 1);
  showVar(state.varIndex + 1);
}

// Puzzles step through a solved puzzle; elsewhere off the review they do nothing
// (instead of moving the hidden game).
const boardNav = (dir: "first" | "prev" | "next" | "last") => puzzleNav(dir) || openingNav(dir) || isPlayMode();
$("btn-first").addEventListener("click", () => boardNav("first") || goto(0));
$("btn-prev").addEventListener("click", () => boardNav("prev") || prev());
$("btn-next").addEventListener("click", () => boardNav("next") || next());
$("btn-last").addEventListener("click", () => boardNav("last") || goto(Infinity));
$("btn-back").addEventListener("click", backToGame);
$("btn-flip").addEventListener("click", flip);
$("btn-mistake").addEventListener("click", nextMistake);
$("btn-cancel").addEventListener("click", () => invoke("cancel_analysis"));

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (isPuzzleMode()) {
    if (puzzleKey(e)) e.preventDefault();
    return;
  }
  if (isOpeningMode()) {
    if (openingKey(e)) e.preventDefault();
    return;
  }
  if (isPlayMode()) return;
  if (training) {
    if (e.key === "Escape") exitTraining();
    if (e.key === "Enter" && (training.phase === "solved")) trainingGoto(training.index + 1);
    return;
  }
  const actions: Record<string, () => void> = {
    ArrowLeft: prev,
    ArrowRight: next,
    Escape: backToGame,
    Home: () => goto(0),
    End: () => goto(Infinity),
    f: flip,
    n: nextMistake,
    t: startTraining,
  };
  const action = actions[e.key];
  if (action) {
    e.preventDefault();
    action();
  }
});

$("load-form").addEventListener("submit", (e) => {
  e.preventDefault();
  load(($("load-input") as HTMLInputElement).value);
});

initPuzzles({
  board,
  accounts,
  animMs: () => animMs,
  openSettings: () => $("btn-settings").click(),
  openGame: (gameId, ply) => openGameAt(gameId, ply),
});

initPlay({
  board,
  animMs: () => animMs,
  openGame: (game) => {
    showTab("review");
    selectGame(game, 0);
  },
  onGameSaved: () => {
    if (state.view === "local" || state.view === "all") showStoredGames();
  },
});

initOpenings({
  board,
  accounts,
  animMs: () => animMs,
  openGame: (gameId, ply) => openGameAt(gameId, ply),
  openPuzzles: () => showTab("puzzles"),
});

initSettings({
  applyDisplay: (prefs) => {
    animMs = prefs.animMs;
    board.set({ animation: { enabled: animMs > 0, duration: animMs }, coordinates: prefs.coordinates });
    board.redrawAll();
    applyShapes();
  },
  onEngineChanged: () => {
    checkEngine();
    if (state.review && state.liveEnabled && !training) requestLive(currentFen());
  },
  onLiveDefault: (on) => {
    const toggle = $("live-toggle") as HTMLInputElement;
    if (toggle.checked !== on) {
      toggle.checked = on;
      toggle.dispatchEvent(new Event("change"));
    }
  },
});

state.liveEnabled = store.get("live") !== "0";
($("live-toggle") as HTMLInputElement).checked = state.liveEnabled;

// Names per platform ("username" is the key used before chess.com support).
state.names.lichess = store.get("name-lichess") ?? store.get("username") ?? "";
state.names.chesscom = store.get("name-chesscom") ?? "";
const savedView = store.get("view");
initGameFilter();
setView(savedView === "chesscom" || savedView === "all" || savedView === "local" ? savedView : "lichess");
checkEngine();
preloadSounds();

// Own version under "Über" in the settings; the link opens the release page.
$("app-releases").addEventListener("click", (e) => {
  e.preventDefault();
  invoke("open_releases_page").catch((err) => alert(String(err)));
});

// A newer release on GitHub? Show a small pill in the top bar (once per start, silent when offline).
invoke<{ current: string; latest: string | null; available: boolean }>("app_update")
  .then((u) => {
    $("app-version").textContent = `postmortem ${u.current}`;
    $("app-version-state").innerHTML = u.available && u.latest
      ? `– <b class="update">${t("Update {v} verfügbar", { v: esc(u.latest) })}</b>`
      : u.latest
        ? `– ${t("aktuell")}`
        : "";
    if (!u.available || !u.latest) return;
    const btn = $("app-update");
    btn.textContent = t("Update {v} verfügbar", { v: u.latest });
    btn.hidden = false;
    btn.addEventListener("click", () => invoke("open_releases_page").catch((e) => alert(String(e))));
  })
  .catch(() => {});

// Fold the game list away (more room for the board on small screens).
function setGamesCollapsed(on: boolean) {
  document.querySelector(".layout")!.classList.toggle("games-collapsed", on);
  const btn = $("games-toggle");
  btn.textContent = on ? "›" : "‹";
  btn.title = on ? t("Partieliste ausklappen") : t("Partieliste einklappen");
  store.set("games-collapsed", on ? "1" : "0");
  // the board changed size
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
$("games-toggle").addEventListener("click", () =>
  setGamesCollapsed(!document.querySelector(".layout")!.classList.contains("games-collapsed")),
);
setGamesCollapsed(store.get("games-collapsed") === "1");

// ---------------------------------------------------------------------------
// PGN import / export

interface ImportResult {
  games: GameInfo[];
  known: number;
  errors: string[];
}

const importDialog = $("import") as HTMLDialogElement;
$("btn-import").addEventListener("click", () => {
  $("import-msg").textContent = "";
  $("import-msg").className = "msg";
  const side = store.get("import-side");
  ($("import-side") as HTMLSelectElement).value = side === null ? "white" : side;
  importDialog.showModal();
  ($("import-text") as HTMLTextAreaElement).focus();
});
importDialog.addEventListener("click", (e) => {
  if (e.target === importDialog) importDialog.close();
});

$("import-file").addEventListener("change", async () => {
  const file = ($("import-file") as HTMLInputElement).files?.[0];
  if (!file) return;
  ($("import-text") as HTMLTextAreaElement).value = await file.text();
  ($("import-file") as HTMLInputElement).value = "";
});

$("import-go").addEventListener("click", async () => {
  const text = ($("import-text") as HTMLTextAreaElement).value;
  const you = ($("import-side") as HTMLSelectElement).value || null;
  store.set("import-side", you ?? "");
  const msg = $("import-msg");
  msg.className = "msg";
  msg.textContent = t("Lese Partien …");
  let r: ImportResult;
  try {
    r = await invoke<ImportResult>("import_pgn", { pgn: text, you });
  } catch (e) {
    msg.className = "msg error";
    msg.textContent = String(e);
    return;
  }
  if (!r.games.length) {
    msg.className = "msg error";
    msg.textContent = r.errors.join("\n");
    return;
  }
  const parts = [tn(r.games.length, "1 Partie eingespielt", "{n} Partien eingespielt")];
  if (r.known) parts.push(t("davon {n} schon vorhanden", { n: r.known }));
  if (r.errors.length) {
    // keep the dialog open so the problems can be read
    msg.className = "msg error";
    msg.textContent = `${parts.join(", ")}.\n${t("Nicht lesbar:")}\n${r.errors.join("\n")}`;
  } else {
    importDialog.close();
    ($("import-text") as HTMLTextAreaElement).value = "";
  }
  const first = r.games[0];
  showTab("review");
  if (you) {
    if (state.view !== "local" && state.view !== "all") setView("local");
    else await showStoredGames();
  } else {
    // not "yours": not in any list, just open it
    state.games = [first, ...state.games.filter((g) => g.id !== first.id)];
    renderGames();
  }
  selectGame(first);
});

/** Clipboard with a fallback for webviews that refuse navigator.clipboard. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

let copyTimer = 0;
function copied(ok: boolean, what: string) {
  const el = $("copy-msg");
  el.textContent = ok ? t("{what} kopiert ✓", { what }) : t("Kopieren nicht möglich");
  clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => (el.textContent = ""), 2000);
}

$("copy-pgn").addEventListener("click", async () => {
  if (!state.game) return;
  const pgn = await invoke<string>("export_pgn", { game: state.game });
  copied(await copyText(pgn), "PGN");
});
$("copy-fen").addEventListener("click", async () => {
  if (!state.review) return;
  copied(await copyText(currentFen()), "FEN");
});
