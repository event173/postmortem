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
import { $, badgeHtml, esc, fig, store } from "./util";
import { initStats, loadStats, showStatsView } from "./stats";

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
  type Score,
  type StoredGame,
  type SyncResult,
  type VarNode,
} from "./types";

type Color = "white" | "black";


const state = {
  username: "" as string,
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
};

/** Piece animation length; playback steps are a bit longer so moves never overlap. */
const ANIM_MS = 230;

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const board: Api = Chessground($("board"), {
  fen: START_FEN,
  // Not viewOnly: chessground binds its drag listeners only once, at creation.
  // Moves are blocked via `movable.color` until a review is loaded instead.
  coordinates: true,
  animation: { enabled: true, duration: ANIM_MS },
  draggable: { enabled: true, showGhost: true },
  drawable: { enabled: false, visible: true },
  premovable: { enabled: false },
  movable: { free: false, color: undefined, showDests: true, events: { after: (orig, dest) => onUserMove(orig, dest) } },
});

// ---------------------------------------------------------------------------
// small helpers





function userColor(game: GameInfo): Color | null {
  const u = state.username.toLowerCase();
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

function badgeSvg(cls: Class): string {
  const c = CLASSES[cls];
  const size = c.symbol.length > 1 ? 44 : 56;
  return `<g transform="translate(66 -10)">
    <circle cx="22" cy="22" r="22" fill="${c.color}" stroke="#fff" stroke-width="3"/>
    <text x="22" y="23" text-anchor="middle" dominant-baseline="central" fill="#fff"
      font-family="system-ui, sans-serif" font-weight="800" font-size="${size * 0.5}">${esc(c.symbol)}</text>
  </g>`;
}


const SPEEDS: Record<string, string> = {
  ultraBullet: "UltraBullet",
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Schnellschach",
  classical: "Klassisch",
  correspondence: "Fernschach",
};

// ---------------------------------------------------------------------------
// engine status

async function checkEngine() {
  const el = $("engine-status");
  try {
    const s = await invoke<{ found: boolean; path: string | null }>("engine_status");
    if (s.found) {
      el.className = "engine-status ok";
      el.textContent = "Stockfish bereit";
      el.title = s.path ?? "";
    } else {
      el.className = "engine-status warn";
      el.textContent = "Stockfish fehlt: sudo apt install stockfish";
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
  if (!input) return;
  const list = $("games-list");
  if (input.includes("/") || input.includes("lichess.org")) {
    list.innerHTML = `<p class="empty">Lade Partie …</p>`;
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
  state.username = input;
  store.set("username", input);
  await showStoredGames();
  if (!$("stats").hidden) loadStats();
  syncGames();
}

/** Show the games already stored locally (instant, works offline). */
async function showStoredGames() {
  const username = state.username;
  try {
    const stored = await invoke<StoredGame[]>("list_games", { username });
    if (username !== state.username) return;
    state.games = stored;
    state.cached = new Set(stored.filter((g) => g.analysed).map((g) => g.id));
    renderGames();
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

/** Pull new games (or, with `older`, the next older batch) from Lichess. */
async function syncGames(older = false) {
  const username = state.username;
  if (!username || syncing) return;
  syncing = true;
  setSyncStatus("busy", older ? "Lade ältere …" : "Synchronisiere …");
  if (!state.games.length) $("games-list").innerHTML = `<p class="empty">Lade Partien von Lichess …</p>`;
  try {
    const res = await invoke<SyncResult>("sync_games", { username, older });
    if (username !== state.username) return;
    if (res.offline) {
      setSyncStatus("offline", "Offline");
    } else {
      if (res.added) await showStoredGames();
      setSyncStatus("ok", res.added ? `${res.added} neu` : older ? "Keine älteren" : "Aktuell");
    }
    if (!state.games.length) {
      $("games-list").innerHTML = res.offline
        ? `<p class="empty">Offline – und für diesen Namen sind noch keine Partien gespeichert.</p>`
        : `<p class="empty">Keine Standard-Partien gefunden.</p>`;
    }
  } catch (e) {
    if (username !== state.username) return;
    setSyncStatus("error", "Fehler");
    $("sync-status").title = String(e);
    if (!state.games.length) $("games-list").innerHTML = `<p class="empty error">${esc(String(e))}</p>`;
  } finally {
    syncing = false;
  }
}

$("btn-sync").addEventListener("click", () => syncGames());

/** Open a stored game (e.g. from the statistics) at a given ply. */
async function openGameAt(gameId: string, ply: number) {
  let game: GameInfo | undefined = state.games.find((g) => g.id === gameId);
  if (!game && state.username) {
    const all = await invoke<StoredGame[]>("list_games", { username: state.username, limit: 100000 });
    game = all.find((g) => g.id === gameId);
  }
  if (game) {
    document.querySelector(`.game[data-id="${gameId}"]`)?.scrollIntoView({ block: "nearest" });
    selectGame(game, ply);
  }
}

initStats({
  username: () => state.username,
  depth: () => Number(($("depth") as HTMLSelectElement).value),
  openGame: openGameAt,
  onGamesAnalysed: () => showStoredGames(),
});

function renderGames() {
  const list = $("games-list");
  $("games-count").textContent = state.games.length ? String(state.games.length) : "";
  list.innerHTML = "";
  for (const g of state.games) {
    const me = userColor(g);
    const opp = me === "white" ? g.black : me === "black" ? g.white : null;
    let result: string;
    let resultClass: string;
    if (!g.winner) {
      result = "½";
      resultClass = "draw";
    } else if (me) {
      result = g.winner === me ? "S" : "N";
      resultClass = g.winner === me ? "win" : "loss";
    } else {
      result = g.winner === "white" ? "1–0" : "0–1";
      resultClass = "neutral";
    }
    const title = opp
      ? `${me === "white" ? "♙" : "♟"} vs ${esc(opp.name)}${opp.rating ? ` <span class="muted">(${opp.rating})</span>` : ""}`
      : `${esc(g.white.name)} – ${esc(g.black.name)}`;
    const date = new Date(g.createdAt).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
    const speed = [SPEEDS[g.speed] ?? g.speed, g.timeControl].filter(Boolean).join(" ");

    const btn = document.createElement("button");
    btn.className = "game" + (state.game?.id === g.id ? " active" : "");
    btn.dataset.id = g.id;
    btn.innerHTML = `
      <span class="result ${resultClass}">${result}</span>
      <span class="game-main">
        <span class="game-title">${title}</span>
        <span class="game-sub">${esc(g.opening?.name ?? "Unbekannte Eröffnung")}</span>
        <span class="game-sub">${speed} · ${date} · ${Math.ceil(g.moves.length / 2)} Züge</span>
      </span>
      ${state.cached.has(g.id) ? `<span class="analysed" title="Bereits analysiert">●</span>` : ""}`;
    btn.addEventListener("click", () => {
      showStatsView(false);
      selectGame(g);
    });
    list.appendChild(btn);
  }
  if (state.username && state.games.length) {
    const more = document.createElement("button");
    more.className = "load-older";
    more.textContent = "Ältere Partien von Lichess laden";
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

  try {
    const depth = Number(($("depth") as HTMLSelectElement).value);
    const review = await invoke<GameReview>("analyse_game", { game, depth });
    if (token !== analysisToken) return;
    state.review = review;
    state.cached.add(game.id);
    renderGames();
    $("review-progress").hidden = true;
    $("review-content").hidden = false;
    renderSummary();
    renderMoveList();
    goto(startPly);
    renderGraph();
    updateTrainButton();
  } catch (e) {
    if (token !== analysisToken) return;
    $("review-progress").hidden = true;
    const empty = $("review-empty");
    empty.hidden = false;
    empty.innerHTML = String(e) === "cancelled" ? "Analyse abgebrochen." : `<span class="error">${esc(String(e))}</span>`;
  }
}

function setProgress(done: number, total: number) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  ($("review-progress").querySelector(".progress-fill") as HTMLElement).style.width = `${pct}%`;
  $("progress-text").textContent = `${pct} %`;
}

listen<Progress>("analysis-progress", (e) => {
  if (e.payload.gameId === state.game?.id && !state.review) setProgress(e.payload.done, e.payload.total);
});

// ---------------------------------------------------------------------------
// rendering a position

// --- animated playback (used when jumping to the next mistake) -------------

let playback: { timer: number; target: number } | null = null;

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
  const stepMs = Math.min(500, Math.max(ANIM_MS + 60, 4000 / distance));
  const step = () => {
    show(state.ply + 1);
    if (state.ply >= target) {
      playback = null;
    } else {
      playback = { timer: window.setTimeout(step, stepMs), target };
    }
  };
  playback = { timer: window.setTimeout(step, 0), target };
}

/** User navigation on the main line: cancels playback and leaves any variation. */
function goto(ply: number) {
  stopPlayback();
  show(ply);
}

function show(ply: number) {
  const r = state.review;
  if (!r || training) return;
  state.inVar = false;
  state.ply = Math.max(0, Math.min(ply, r.moves.length));
  renderPosition();
}

/** Show the position after `index` moves of the variation (0 = branch point). */
function showVar(index: number) {
  const v = state.variation;
  if (!v || training) return;
  stopPlayback();
  state.inVar = true;
  state.varIndex = Math.max(0, Math.min(index, v.nodes.length));
  renderPosition();
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
const applyShapes = () => board.setAutoShapes([...baseShapes, ...liveShapes]);

let positionToken = 0;

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
  renderCoach();
  updateGraphCursor();
  renderMoveHighlight();
  $("btn-back").hidden = !state.inVar;
  requestLive(fen);
}

// ---------------------------------------------------------------------------
// playing your own moves

async function onUserMove(orig: Key, dest: Key, promotion?: string) {
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
  if (e.payload.id !== liveId || training) return;
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
    depthEl.textContent = "aus";
    linesEl.innerHTML = "";
    return;
  }
  if (!live) {
    depthEl.textContent = "rechnet …";
    linesEl.innerHTML = "";
    return;
  }
  depthEl.textContent = live.depth ? `Tiefe ${live.depth}${live.done ? "" : " …"}` : "";
  linesEl.innerHTML = live.lines
    .map((l) => {
      const white = l.winWhite >= 50;
      const score = `<span class="live-score ${white ? "w" : "b"}">${formatScore(l.score)}</span>`;
      if (!l.uci) return `<div class="live-line">${score}<span class="live-pv muted">Partie beendet</span></div>`;
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

function renderPlayers() {
  const g = state.game;
  if (!g) return;
  const r = state.review;
  const html = (c: Color) => {
    const p = g[c];
    const acc = r ? `<span class="acc">${r.accuracy[c].toFixed(1)}</span>` : "";
    return `<span class="pdot ${c}"></span><span class="pname">${esc(p.name)}</span>${p.rating ? `<span class="muted">${p.rating}</span>` : ""}${acc}`;
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
  const tag = state.inVar ? `<span class="var-tag">Variante</span>` : "";
  if (node && !node.review) {
    head.innerHTML = `<span class="coach-title"><b>${esc(fig(node.san))}</b></span>${tag}`;
    head.style.setProperty("--c", "var(--border)");
    text.innerHTML = node.error ? `<span class="error">${esc(node.error)}</span>` : `<span class="muted">Bewerte deinen Zug …</span>`;
    best.innerHTML = "";
    return;
  }
  const move = node ? node.review : r.moves[mainPly() - 1];
  if (!move) {
    head.style.setProperty("--c", "var(--border)");
    const g = state.game!;
    head.innerHTML = `<span class="coach-title">Partie-Review</span>`;
    text.textContent = g.opening
      ? `${g.opening.name} (${g.opening.eco}). Mit → gehst du Zug für Zug durch die Partie, mit N springst du zu deinem nächsten Fehler.`
      : "Mit → gehst du Zug für Zug durch die Partie, mit N springst du zu deinem nächsten Fehler.";
    best.innerHTML = `<span class="muted">Analysiert mit Stockfish, Tiefe ${r.depth}</span>`;
    return;
  }
  const info = CLASSES[move.classification];
  const num = Math.ceil(move.ply / 2) + (move.color === "white" ? "." : "...");
  head.innerHTML = `${badgeHtml(move.classification)}<span class="coach-title"><b>${num} ${esc(fig(move.san))}</b> ist ${info.phrase}</span>${tag}`;
  head.style.setProperty("--c", info.color);
  text.innerHTML = esc(fig(move.comment));
  const showBest = move.bestSan && move.bestUci !== move.uci && !NOT_BAD.includes(move.classification);
  best.innerHTML = showBest
    ? `<span class="best-label">Bester Zug</span> <b>${esc(fig(move.bestSan!))}</b>${move.bestLine ? `<div class="best-line">${esc(fig(move.bestLine))}</div>` : ""}`
    : "";
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
    <tr class="names"><th>${esc(g.white.name)}</th><th></th><th>${esc(g.black.name)}</th></tr>
    <tr class="accuracy"><td>${r.accuracy.white.toFixed(1)}</td><td class="cls">Genauigkeit</td><td>${r.accuracy.black.toFixed(1)}</td></tr>
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
    const mark = n.review ? badgeIfNotable(n.review.classification) : n.error ? "" : `<span class="pending"></span>`;
    return `<button class="vmv" data-var="${i + 1}">${num}${mark}<span>${esc(fig(n.san))}</span></button>`;
  });
  return `<div class="variation">${parts.join("")}<button class="var-close" title="Variante löschen">✕</button></div>`;
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
    if (active) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  document.querySelectorAll<HTMLElement>(".vmv").forEach((el) => {
    const active = state.inVar && Number(el.dataset.var) === state.varIndex;
    el.classList.toggle("active", active);
    if (active) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

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
  phase: "solve" | "checking" | "wrong" | "solved" | "done";
  results: (TrainResult | null)[];
  hint: boolean;
  /** The user's last try (wrong or right) and the engine's verdict on it. */
  attempt: { played: PlayedMove; review?: MoveReview } | null;
  /** While true the board still shows the wrong try before snapping back. */
  showAttempt: boolean;
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
  btn.hidden = !state.review || !!training;
  btn.disabled = n === 0;
  btn.title = n ? `${n} eigene Fehler als Übung durchgehen (T)` : "Keine eigenen Fehler in dieser Partie";
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
  const t = training!;
  clearTimeout(trainTimer);
  t.index = index;
  t.hint = false;
  t.attempt = null;
  t.showAttempt = false;
  t.phase = index >= t.items.length ? "done" : "solve";
  renderTraining();
}

function finishItem(result: TrainResult) {
  const t = training!;
  t.results[t.index] = t.results[t.index] ?? result;
}

async function onTrainingMove(orig: Key, dest: Key, promotion?: string) {
  const t = training!;
  const r = state.review!;
  if (t.phase !== "solve" && t.phase !== "wrong") return;
  const item = t.items[t.index];
  const fen = r.fens[item.ply - 1];
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen, from: orig, to: dest, promotion });
  } catch {
    renderTraining();
    return;
  }
  const step = t.index;
  clearTimeout(trainTimer);
  t.attempt = { played };
  t.showAttempt = true;

  if (played.uci === item.bestUci) {
    t.phase = "solved";
    finishItem(t.hint ? "hint" : "solved");
    renderTraining();
    return;
  }
  t.phase = "checking";
  renderTraining();
  let review: MoveReview | undefined;
  try {
    review = await invoke<MoveReview>("evaluate_move", { fen, uci: played.uci });
  } catch (e) {
    console.error(e);
  }
  if (training !== t || t.index !== step || t.attempt?.played !== played) return;
  t.attempt.review = review;
  if (review && ACCEPTED.includes(review.classification)) {
    t.phase = "solved";
    finishItem(t.hint ? "hint" : "solved");
    renderTraining();
    return;
  }
  t.phase = "wrong";
  renderTraining();
  // Let the user see the refuted try for a moment, then reset the position.
  trainTimer = window.setTimeout(() => {
    if (training === t && t.index === step && t.phase === "wrong") {
      t.showAttempt = false;
      renderTraining();
    }
  }, 1400);
}

async function showSolution() {
  const t = training!;
  const r = state.review!;
  const item = t.items[t.index];
  if (!item.bestUci) return;
  clearTimeout(trainTimer);
  const played = await invoke<PlayedMove>("play_move", {
    fen: r.fens[item.ply - 1],
    from: item.bestUci.slice(0, 2),
    to: item.bestUci.slice(2, 4),
    promotion: item.bestUci[4],
  });
  if (training !== t) return;
  finishItem("shown");
  t.attempt = { played };
  t.showAttempt = true;
  t.phase = "solved";
  renderTraining();
}

function trainingDots(): string {
  const t = training!;
  return `<span class="train-dots">${t.items
    .map((_, i) => `<span class="train-dot ${t.results[i] ?? ""} ${i === t.index && t.phase !== "done" ? "current" : ""}"></span>`)
    .join("")}</span>`;
}

function renderTraining() {
  const t = training;
  const r = state.review;
  if (!t || !r) return;
  const head = $("coach-head");
  const text = $("coach-text");
  const best = $("coach-best");
  const actions = $("training-actions");
  actions.hidden = false;
  best.innerHTML = "";

  if (t.phase === "done") {
    const count = (k: TrainResult) => t.results.filter((x) => x === k).length;
    head.innerHTML = `<span class="coach-title">Geschafft!</span>${trainingDots()}`;
    head.style.setProperty("--c", "var(--accent)");
    text.innerHTML = `Du hast <b>${count("solved")}</b> von ${t.items.length} Fehlern selbst gelöst${
      count("hint") ? `, <b>${count("hint")}</b> mit Tipp` : ""
    }.${count("shown") + count("skipped") ? ` ${count("shown") + count("skipped")} offen – die lohnt es sich nochmal anzuschauen.` : ""}`;
    actions.innerHTML = `<button data-act="restart">Nochmal von vorn</button><button data-act="exit" class="primary">Zurück zur Review</button>`;
    bindTrainingActions();
    board.set({ movable: { color: undefined, dests: new Map() } });
    board.setAutoShapes([]);
    return;
  }

  const item = t.items[t.index];
  const fen = r.fens[item.ply - 1];
  const prevMove = r.moves[item.ply - 2];
  const side = item.color === "white" ? "Weiß" : "Schwarz";
  const attempt = t.showAttempt ? t.attempt : null;
  state.ply = item.ply - 1;
  state.orientation = item.color;
  renderPlayers();

  // Board: either the puzzle position or the user's try on top of it.
  const shapes: DrawShape[] = [];
  if (attempt) {
    const cls: Class | undefined = t.phase === "solved" ? (attempt.review?.classification ?? "best") : attempt.review?.classification;
    if (cls) shapes.push({ orig: attempt.played.uci.slice(2, 4) as Key, customSvg: { html: badgeSvg(cls) } });
  } else if (t.hint && item.bestUci) {
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
  renderEvalBar();
  updateGraphCursor();

  const canMove = !attempt && (t.phase === "solve" || t.phase === "wrong");
  if (canMove) {
    const token = ++positionToken;
    invoke<PositionInfo>("position_info", { fen }).then((info) => {
      if (token !== positionToken || training !== t) return;
      board.set({ movable: { color: item.color, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
    });
  }

  head.innerHTML = `<span class="coach-title">Aufgabe ${t.index + 1} von ${t.items.length}</span>${trainingDots()}`;
  const info = CLASSES[item.classification];
  const num = Math.ceil(item.ply / 2) + (item.color === "white" ? "." : "...");
  const task = `In der Partie hast du hier <b>${num} ${esc(fig(item.san))}</b> gespielt – ${info.phrase}. Finde einen besseren Zug für ${side}.`;

  switch (t.phase) {
    case "solve":
      head.style.setProperty("--c", info.color);
      text.innerHTML = task + (t.hint && item.bestUci ? ` <span class="muted">Tipp: Zieh mit der markierten Figur.</span>` : "");
      break;
    case "checking":
      head.style.setProperty("--c", "var(--border)");
      text.innerHTML = `<span class="muted">Prüfe ${esc(fig(t.attempt!.played.san))} …</span>`;
      break;
    case "wrong": {
      const rv = t.attempt?.review;
      head.style.setProperty("--c", rv ? CLASSES[rv.classification].color : "var(--danger)");
      text.innerHTML = rv
        ? `${badgeHtml(rv.classification)} <b>${esc(fig(rv.san))}</b> ist ${CLASSES[rv.classification].phrase}. ${esc(fig(rv.comment))}<br><span class="muted">Versuch es nochmal.</span>`
        : `<b>${esc(fig(t.attempt!.played.san))}</b> ist nicht besser. <span class="muted">Versuch es nochmal.</span>`;
      break;
    }
    case "solved": {
      const shown = t.results[t.index] === "shown";
      const rv = t.attempt?.review;
      head.style.setProperty("--c", shown ? "var(--muted)" : "var(--accent)");
      const san = esc(fig(t.attempt!.played.san));
      text.innerHTML = shown
        ? `Die Lösung war <b>${san}</b>.`
        : rv && rv.bestUci !== rv.uci
          ? `<b>Gut!</b> ${san} funktioniert auch – ${CLASSES[rv.classification].phrase}.`
          : `<b>Richtig!</b> ${san} ist der beste Zug.`;
      if (item.bestLine) best.innerHTML = `<span class="best-label">Engine-Variante</span><div class="best-line">${esc(fig(item.bestLine))}</div>`;
      break;
    }
  }

  const last = t.index === t.items.length - 1;
  actions.innerHTML =
    t.phase === "solved"
      ? `<button data-act="exit">Beenden</button><button data-act="next" class="primary">${last ? "Ergebnis" : "Weiter"} →</button>`
      : `<button data-act="hint" ${t.hint || t.phase === "checking" ? "disabled" : ""}>Tipp</button>
         <button data-act="solution" ${t.phase === "checking" ? "disabled" : ""}>Lösung zeigen</button>
         <button data-act="skip">Überspringen</button>
         <button data-act="exit" class="end">Beenden</button>`;
  bindTrainingActions();
}

function bindTrainingActions() {
  $("training-actions")
    .querySelectorAll<HTMLButtonElement>("button[data-act]")
    .forEach((b) =>
      b.addEventListener("click", () => {
        const t = training;
        if (!t) return;
        switch (b.dataset.act) {
          case "hint":
            t.hint = true;
            renderTraining();
            break;
          case "solution":
            showSolution();
            break;
          case "skip":
            finishItem("skipped");
            trainingGoto(t.index + 1);
            break;
          case "next":
            trainingGoto(t.index + 1);
            break;
          case "restart":
            t.results = t.items.map(() => null);
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

// ---------------------------------------------------------------------------
// navigation

function nextMistake() {
  const r = state.review;
  if (!r) return;
  // Pressing again while it is still playing skips straight to the mistake.
  if (playback) {
    goto(playback.target);
    return;
  }
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

$("btn-first").addEventListener("click", () => goto(0));
$("btn-prev").addEventListener("click", prev);
$("btn-next").addEventListener("click", next);
$("btn-last").addEventListener("click", () => goto(Infinity));
$("btn-back").addEventListener("click", backToGame);
$("btn-flip").addEventListener("click", flip);
$("btn-mistake").addEventListener("click", nextMistake);
$("btn-cancel").addEventListener("click", () => invoke("cancel_analysis"));

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
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

const depthSelect = $("depth") as HTMLSelectElement;
depthSelect.value = store.get("depth") ?? "16";
depthSelect.addEventListener("change", () => store.set("depth", depthSelect.value));

state.liveEnabled = store.get("live") !== "0";
($("live-toggle") as HTMLInputElement).checked = state.liveEnabled;

const savedUser = store.get("username");
if (savedUser) {
  ($("load-input") as HTMLInputElement).value = savedUser;
  load(savedUser);
}
checkEngine();
