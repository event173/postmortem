// "Spielen" tab: a game against Stockfish at one of 8 levels (see bot.rs).
// Finished games are stored as source "local" and can be reviewed like any other.

import { invoke } from "@tauri-apps/api/core";
import type { Api } from "chessground/api";
import type { Key } from "chessground/types";

import { moveSound, setupSound } from "./sound";
import type { GameInfo, PlayedMove, PositionInfo } from "./types";
import { $, esc, fig, store } from "./util";

type Color = "white" | "black";

interface Level {
  level: number;
  elo: number;
  label: string;
}

interface GameStatus {
  over: boolean;
  winner: Color | null;
  reason: string | null;
}

interface Game {
  you: Color;
  level: number;
  /** Base time and increment in ms; null = no clock. */
  tc: { base: number; inc: number; label: string } | null;
  fens: string[];
  sans: string[];
  ucis: string[];
  clocks: Record<Color, number>;
  /** When the side to move started thinking (ms). */
  turnStart: number;
  thinking: boolean;
  result: GameStatus | null;
  saved: GameInfo | null;
}

export interface PlayDeps {
  board: Api;
  animMs: () => number;
  /** Open a finished game in the review. */
  openGame: (game: GameInfo) => void;
  /** A bot game was stored (refresh the game list). */
  onGameSaved: () => void;
}

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const SIDE: Record<Color, string> = { white: "Weiß", black: "Schwarz" };
const TIME_CONTROLS: { label: string; base: number; inc: number }[] = [
  { label: "3+2", base: 3, inc: 2 },
  { label: "5+3", base: 5, inc: 3 },
  { label: "10+5", base: 10, inc: 5 },
  { label: "15+10", base: 15, inc: 10 },
];

let deps: PlayDeps;
let active = false;
let levels: Level[] = [];
let game: Game | null = null;
let token = 0;
let tick: number | undefined;

// setup choices (remembered)
let level = Number(store.get("bot-level") ?? "3");
let colorChoice: Color | "random" = (store.get("bot-color") as Color | "random") || "white";
let tcChoice = store.get("bot-tc") ?? "none";

const sideOf = (f: string): Color => (f.split(" ")[1] === "w" ? "white" : "black");
const other = (c: Color): Color => (c === "white" ? "black" : "white");
const fen = () => game!.fens[game!.fens.length - 1];
const sq = (uci: string, from: boolean) => (from ? uci.slice(0, 2) : uci.slice(2, 4)) as Key;

export function initPlay(d: PlayDeps) {
  deps = d;
  invoke<Level[]>("bot_levels").then((l) => {
    levels = l;
    if (active) render();
  });
}

export function isPlayMode(): boolean {
  return active;
}

export function enterPlay() {
  active = true;
  deps.board.setShapes([]);
  deps.board.setAutoShapes([]);
  render();
  if (game && !game.result) startClock();
}

export function leavePlay() {
  active = false;
  clearInterval(tick);
}

// ---------------------------------------------------------------------------
// game flow

function newGame() {
  const you: Color = colorChoice === "random" ? (Math.random() < 0.5 ? "white" : "black") : colorChoice;
  const tc = TIME_CONTROLS.find((t) => t.label === tcChoice);
  token++;
  game = {
    you,
    level,
    tc: tc ? { base: tc.base * 60_000, inc: tc.inc * 1000, label: tc.label } : null,
    fens: [START],
    sans: [],
    ucis: [],
    clocks: { white: (tc?.base ?? 0) * 60_000, black: (tc?.base ?? 0) * 60_000 },
    turnStart: Date.now(),
    thinking: false,
    result: null,
    saved: null,
  };
  deps.board.setShapes([]);
  setupSound();
  startClock();
  render();
  if (you === "black") botTurn();
}

function startClock() {
  clearInterval(tick);
  if (!game?.tc) return;
  tick = window.setInterval(() => {
    const g = game;
    if (!g || g.result || !g.tc) return clearInterval(tick);
    const mover = sideOf(fen());
    if (g.clocks[mover] - (Date.now() - g.turnStart) <= 0) {
      g.clocks[mover] = 0;
      finish({ over: true, winner: other(mover), reason: "Zeit abgelaufen" });
    } else {
      renderClocks();
    }
  }, 100);
}

/** Book the time the mover used (and the increment). */
function chargeClock(mover: Color) {
  const g = game!;
  if (!g.tc) return;
  g.clocks[mover] = Math.max(0, g.clocks[mover] - (Date.now() - g.turnStart)) + g.tc.inc;
  g.turnStart = Date.now();
}

async function applyMove(played: PlayedMove) {
  const g = game!;
  const mover = sideOf(fen());
  chargeClock(mover);
  g.fens.push(played.fen);
  g.sans.push(played.san);
  g.ucis.push(played.uci);
  moveSound(played.san);
  render();
  const status = await invoke<GameStatus>("game_status", { fens: g.fens });
  if (status.over) finish(status);
  return status.over;
}

/** Called by main when you move on the board in play mode. */
export async function playMove(orig: Key, dest: Key, promotion?: string) {
  const g = game;
  if (!g || g.result || g.thinking || sideOf(fen()) !== g.you) return render();
  const t = token;
  let played: PlayedMove;
  try {
    played = await invoke<PlayedMove>("play_move", { fen: fen(), from: orig, to: dest, promotion });
  } catch {
    return render();
  }
  if (t !== token) return;
  const over = await applyMove(played);
  if (!over && t === token) botTurn();
}

async function botTurn() {
  const g = game!;
  const t = token;
  g.thinking = true;
  render();
  const started = Date.now();
  let uci: string | null = null;
  try {
    uci = await invoke<string | null>("bot_move", { fen: fen(), level: g.level });
  } catch (e) {
    if (t !== token) return;
    g.thinking = false;
    renderPanel(String(e));
    return;
  }
  // Weak levels answer instantly; a short pause feels more natural.
  const wait = Math.max(0, 350 - (Date.now() - started));
  await new Promise((r) => setTimeout(r, wait));
  if (t !== token || game !== g || g.result) return;
  g.thinking = false;
  if (!uci) return render();
  const played = await invoke<PlayedMove>("play_move", {
    fen: fen(),
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci[4],
  });
  if (t !== token) return;
  await applyMove(played);
}

/** Take back your last move (and the bot's answer). */
function takeback() {
  const g = game;
  if (!g || g.result || g.thinking || !g.sans.length) return;
  token++; // drop a bot reply that might still be on its way
  const plies = sideOf(fen()) === g.you ? 2 : 1;
  for (let i = 0; i < plies && g.sans.length; i++) {
    g.fens.pop();
    g.sans.pop();
    g.ucis.pop();
  }
  // If only the bot's first move (you're Black) was left, it must move again.
  g.turnStart = Date.now();
  render();
  if (sideOf(fen()) !== g.you) botTurn();
}

function resign() {
  const g = game;
  if (!g || g.result) return;
  token++;
  finish({ over: true, winner: other(g.you), reason: "Aufgabe" });
}

async function finish(status: GameStatus) {
  const g = game!;
  if (g.result) return;
  g.result = status;
  g.thinking = false;
  clearInterval(tick);
  render();
  if (!g.sans.length) return; // nothing to keep
  try {
    g.saved = await invoke<GameInfo>("save_bot_game", {
      moves: g.sans,
      you: g.you,
      level: g.level,
      winner: status.winner,
      status: status.reason ?? "",
      timeControl: g.tc?.label ?? null,
    });
    deps.onGameSaved();
  } catch (e) {
    console.error(e);
  }
  renderPanel();
}

// ---------------------------------------------------------------------------
// rendering

function render(error?: string) {
  if (!active) return;
  const g = game;
  const board = deps.board;
  if (!g) {
    board.set({ fen: START, orientation: colorChoice === "black" ? "black" : "white", lastMove: undefined, check: false, movable: { color: undefined, dests: new Map() } });
  } else {
    const f = fen();
    const last = g.ucis[g.ucis.length - 1];
    const san = g.sans[g.sans.length - 1] ?? "";
    board.set({
      fen: f,
      orientation: g.you,
      turnColor: sideOf(f),
      lastMove: last ? [sq(last, true), sq(last, false)] : undefined,
      check: /[+#]$/.test(san),
      movable: { color: undefined, dests: new Map() },
    });
    if (!g.result && !g.thinking && sideOf(f) === g.you) {
      const t = token;
      invoke<PositionInfo>("position_info", { fen: f }).then((info) => {
        if (t !== token || !active || game !== g || g.result || fen() !== f) return;
        board.set({ movable: { color: g.you, dests: new Map(Object.entries(info.dests) as [Key, Key[]][]) } });
      });
    }
  }
  renderPanel(error);
}

function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function renderClocks() {
  const g = game;
  if (!g?.tc) return;
  const mover = sideOf(fen());
  for (const c of ["white", "black"] as Color[]) {
    const el = document.getElementById(`clock-${c}`);
    if (!el) continue;
    const left = c === mover && !g.result ? g.clocks[c] - (Date.now() - g.turnStart) : g.clocks[c];
    el.textContent = clockText(left);
    el.classList.toggle("running", c === mover && !g.result);
    el.classList.toggle("low", left < 20_000);
  }
}

function levelInfo(lv: number): Level {
  return levels.find((l) => l.level === lv) ?? { level: lv, elo: 0, label: "" };
}

function renderPanel(error?: string) {
  if (!active) return;
  const el = $("play-body");
  const g = game;

  if (!g) {
    el.innerHTML = setupHtml();
    bindSetup();
    return;
  }

  const bot = levelInfo(g.level);
  const row = (c: Color) => {
    const isBot = c !== g.you;
    const name = isBot ? `Stockfish · Stufe ${bot.level} <span class="muted">(~${bot.elo})</span>` : "Du";
    const thinking = isBot && g.thinking ? `<span class="pending"></span>` : "";
    const clock = g.tc ? `<span id="clock-${c}" class="clock"></span>` : "";
    return `<div class="play-player"><span class="pdot ${c}"></span><span class="pp-name">${name}</span>${thinking}${clock}</div>`;
  };
  const top = row(other(g.you));
  const bottom = row(g.you);

  let moves = "";
  for (let i = 0; i < g.sans.length; i += 2) {
    moves += `<span class="mvnum">${i / 2 + 1}.</span><span class="pm">${esc(fig(g.sans[i]))}</span><span class="pm">${g.sans[i + 1] ? esc(fig(g.sans[i + 1])) : ""}</span>`;
  }

  let status: string;
  if (g.result) {
    const r = g.result;
    const outcome = r.winner === null ? "Remis" : r.winner === g.you ? "Gewonnen!" : "Verloren";
    status = `<div class="play-result ${r.winner === null ? "draw" : r.winner === g.you ? "win" : "loss"}"><b>${outcome}</b> <span class="muted">· ${esc(r.reason ?? "")}</span></div>`;
  } else if (g.thinking) {
    status = `<span class="muted">Stockfish denkt …</span>`;
  } else {
    status = sideOf(fen()) === g.you ? `<b>Du bist am Zug</b> <span class="muted">(${SIDE[g.you]})</span>` : "";
  }

  const actions = g.result
    ? `<button data-act="review" class="primary" ${g.saved ? "" : "disabled"}>Partie analysieren</button>
       <button data-act="rematch">Revanche</button>
       <button data-act="setup" class="end">Neue Partie</button>`
    : `<button data-act="takeback" ${g.thinking || !g.sans.length ? "disabled" : ""}>Zug zurück</button>
       <button data-act="resign">Aufgeben</button>`;

  el.innerHTML = `
    <div class="panel play-game">
      ${top}
      <div class="play-moves">${moves || `<span class="muted">Noch keine Züge.</span>`}</div>
      ${bottom}
      <div class="play-status">${status}${error ? `<br><span class="error">${esc(error)}</span>` : ""}</div>
      <div class="training-actions">${actions}</div>
    </div>`;
  const list = el.querySelector(".play-moves");
  if (list) list.scrollTop = list.scrollHeight;
  renderClocks();
  el.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      switch (b.dataset.act) {
        case "takeback":
          takeback();
          break;
        case "resign":
          resign();
          break;
        case "review":
          if (g.saved) deps.openGame(g.saved);
          break;
        case "rematch":
          colorChoice = g.you;
          newGame();
          break;
        case "setup":
          game = null;
          render();
          break;
      }
    }),
  );
}

function setupHtml(): string {
  const lvButtons = (levels.length ? levels : [{ level: 3, elo: 1200, label: "" } as Level])
    .map(
      (l) => `<button class="lv ${l.level === level ? "active" : ""}" data-level="${l.level}">
        <b>${l.level}</b><span>~${l.elo}</span><small>${esc(l.label)}</small></button>`,
    )
    .join("");
  const seg = (name: string, options: [string, string][], current: string) =>
    `<div class="segmented" data-group="${name}">${options
      .map(([v, label]) => `<button data-v="${v}" class="${v === current ? "active" : ""}">${label}</button>`)
      .join("")}</div>`;
  return `
    <div class="panel play-setup">
      <h3>Gegen den Computer spielen</h3>
      <p class="panel-sub">Wähle die Spielstärke – nach der Partie kannst du sie direkt analysieren.</p>
      <div class="levels">${lvButtons}</div>
      <div class="setup-row"><span>Farbe</span>${seg("color", [["white", "Weiß"], ["random", "Zufall"], ["black", "Schwarz"]], colorChoice)}</div>
      <div class="setup-row"><span>Bedenkzeit</span>${seg("tc", [["none", "Ohne"], ...TIME_CONTROLS.map((t) => [t.label, t.label] as [string, string])], tcChoice)}</div>
      <button id="play-start" class="primary play-start">Partie starten</button>
    </div>`;
}

function bindSetup() {
  const el = $("play-body");
  el.querySelectorAll<HTMLElement>(".lv").forEach((b) =>
    b.addEventListener("click", () => {
      level = Number(b.dataset.level);
      store.set("bot-level", String(level));
      renderPanel();
    }),
  );
  el.querySelectorAll<HTMLElement>(".segmented[data-group] button").forEach((b) =>
    b.addEventListener("click", () => {
      const group = (b.parentElement as HTMLElement).dataset.group;
      if (group === "color") {
        colorChoice = b.dataset.v as Color | "random";
        store.set("bot-color", colorChoice);
        render();
      } else {
        tcChoice = b.dataset.v!;
        store.set("bot-tc", tcChoice);
        renderPanel();
      }
    }),
  );
  $("play-start").addEventListener("click", newGame);
}
