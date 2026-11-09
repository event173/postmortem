// "Statistik" view: weakness themes, error rate by phase, accuracy trend,
// rating history and activity, where you leave opening theory, and the
// background "analyse all games" batch.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { locale, playerName, t, tn } from "./i18n";
import type { Account, BatchProgress, ClockBucket, Phase, PhaseStat, Platform, Theme, ThemeStat, TrendPoint, WeaknessStats } from "./types";
import { $, badgeHtml, esc, fig, miniPieces, platformLabel, speedLabel, store } from "./util";

/** Shared with the puzzle trainer: how many recent games to base things on. */
export type GameWindow = "10" | "20" | "50" | "all";

export function gameWindow(): GameWindow {
  const w = store.get("window");
  return w === "10" || w === "20" || w === "50" ? w : "all";
}

export function windowLast(w: GameWindow = gameWindow()): number | null {
  return w === "all" ? null : Number(w);
}

export function setGameWindow(w: GameWindow) {
  store.set("window", w);
}

export interface StatsDeps {
  /** The accounts the statistics are about (depends on the platform switch). */
  accounts: () => Account[];
  depth: () => number;
  /** Open a game in the review view at the given ply. */
  openGame: (gameId: string, ply: number) => void;
  /** Called after the batch analysed a game (to refresh "analysed" markers). */
  onGamesAnalysed: () => void;
  /** "Üben" on an opening: add it to the repertoire and open the trainer. */
  practiceOpening: (color: "white" | "black", family: string) => void;
}

interface OpeningStat {
  color: "white" | "black";
  family: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  accuracyAvg: number;
  openingErrors: number;
  gamesWithError: number;
}

interface GameSummary {
  id: string;
  source: Platform;
  createdAt: number;
  speed: string;
  rated: boolean;
  rating: number | null;
  opponent: string;
  opponentRating: number | null;
  result: "win" | "loss" | "draw";
}

interface TheoryExit {
  color: "white" | "black";
  fen: string;
  ply: number;
  opening: string | null;
  family: string | null;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  played: { san: string; count: number }[];
  book: string[];
  best: string | null;
  analysed: number;
  avgLoss: number | null;
  errorsAfter: number;
  gameId: string;
}

interface TheoryReport {
  games: number;
  youFirst: number;
  opponentFirst: number;
  avgExitMove: number | null;
  positions: TheoryExit[];
}

export const THEMES: Record<Theme, { label: string; tip: string }> = {
  hangingPiece: {
    label: t("Figur hängen lassen"),
    tip: t("Vor jedem Zug kurz prüfen: Welche meiner Figuren sind angegriffen oder ungedeckt?"),
  },
  allowedFork: {
    label: t("Gabel zugelassen"),
    tip: t("Achte auf Felder, von denen ein Springer oder die Dame zwei deiner Figuren zugleich angreift."),
  },
  allowedMate: {
    label: t("Matt zugelassen"),
    tip: t("Prüfe nach jedem Zug die Schachgebote des Gegners – besonders gegen die Grundreihe."),
  },
  missedMate: {
    label: t("Matt übersehen"),
    tip: t("Hat der gegnerische König wenig Felder, rechne zuerst alle Schachgebote durch."),
  },
  lostMaterial: {
    label: t("Material durch Taktik verloren"),
    tip: t("Vor dem Zug die erzwingenden Antworten des Gegners prüfen: Schach, Schlagen, Drohungen."),
  },
  missedTactic: {
    label: t("Materialgewinn übersehen"),
    tip: t("Such in jeder Stellung zuerst nach Schach, Schlagzügen und Drohungen – für dich."),
  },
  missedChance: {
    label: t("Gegnerfehler nicht genutzt"),
    tip: t("Nach einem überraschenden Zug des Gegners: Was hat er gerade ungedeckt gelassen?"),
  },
  positional: {
    label: t("Stellung verschlechtert"),
    tip: t("Keine direkte Taktik – oft passive Figuren, schwache Felder oder ein fehlender Plan."),
  },
};

const PHASES: { key: Phase; label: string }[] = [
  { key: "opening", label: t("Eröffnung") },
  { key: "middlegame", label: t("Mittelspiel") },
  { key: "endgame", label: t("Endspiel") },
];

const RESULT = { win: t("Sieg"), loss: t("Niederlage"), draw: t("Remis") };

const BATCH_SIZE = 50;

let deps: StatsDeps;
let stats: WeaknessStats | null = null;
let summaries: GameSummary[] = [];
let batch: BatchProgress | null = null;
let expanded: Theme | null = null;
let loadToken = 0;

const fmt = (n: number, digits = 1) => n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const date = (ms: number) => new Date(ms).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "2-digit" });

export function initStats(d: StatsDeps) {
  deps = d;
  document.querySelectorAll<HTMLElement>("#stats-window button").forEach((b) =>
    b.addEventListener("click", () => {
      setGameWindow(b.dataset.w as GameWindow);
      loadStats();
    }),
  );
  window.addEventListener("resize", () => {
    if ($("stats").hidden) return;
    if (stats) renderTrend(stats.trend);
    renderRatingCharts();
  });

  listen<BatchProgress>("batch-progress", (e) => {
    const prevDone = batch?.done ?? 0;
    batch = e.payload.finished ? null : e.payload;
    renderBatch();
    if (e.payload.done !== prevDone || e.payload.finished) {
      deps.onGamesAnalysed();
      loadStats();
    }
  });
}

export async function loadStats() {
  const accounts = deps.accounts();
  const body = $("stats-body");
  if (!accounts.length) {
    stats = null;
    $("stats-basis").textContent = "";
    body.innerHTML = `<p class="empty">${t("Lade zuerst deine Partien über deinen Namen.")}</p>`;
    renderBatch();
    return;
  }
  const token = ++loadToken;
  try {
    const last = windowLast();
    const [s, openings, theory, games] = await Promise.all([
      invoke<WeaknessStats>("weakness_stats", { accounts, last }),
      invoke<OpeningStat[]>("opening_report", { accounts, last }),
      invoke<TheoryReport>("theory_report", { accounts, last }),
      invoke<GameSummary[]>("game_summaries", { accounts }),
    ]);
    if (token !== loadToken) return;
    stats = s;
    summaries = games;
    render();
    renderOpenings(openings);
    renderTheory(theory);
  } catch (e) {
    body.innerHTML = `<p class="empty error">${esc(String(e))}</p>`;
  }
}

function render() {
  const s = stats!;
  document.querySelectorAll<HTMLElement>("#stats-window button").forEach((b) => b.classList.toggle("active", b.dataset.w === gameWindow()));
  $("stats-basis").textContent = s.gamesAnalysed
    ? gameWindow() === "all"
      ? t("Basierend auf allen {n} analysierten Partien ({total} gespeichert)", { n: s.gamesAnalysed, total: s.gamesTotal })
      : t("Basierend auf den letzten {n} analysierten Partien ({total} gespeichert)", { n: s.gamesAnalysed, total: s.gamesTotal })
    : t("{total} Partien gespeichert, noch keine analysiert", { total: s.gamesTotal });
  renderBatch();

  const body = $("stats-body");
  const rating = `<div class="panel rating-panel" id="rating-panel"></div>`;
  const theory = `<div class="panel theory-panel" id="theory-panel"></div>`;
  if (!s.gamesAnalysed) {
    body.innerHTML = `<p class="empty">${t("Analysiere ein paar Partien, dann siehst du hier, woran es am häufigsten hapert.")}</p>${rating}${theory}`;
    renderRating();
    return;
  }

  const games = s.gamesAnalysed;
  const c = (k: keyof typeof s.classes) => s.classes[k] ?? 0;
  const good = c("brilliant") + c("great") + c("best") + c("excellent") + c("good") + c("book") + c("forced");
  const tiles = [
    { label: t("Genauigkeit Ø"), value: s.accuracyAvg !== null ? fmt(s.accuracyAvg) : "–" },
    { label: t("Patzer pro Partie"), value: fmt(c("blunder") / games) },
    { label: t("Fehler pro Partie"), value: fmt((c("mistake") + c("miss")) / games) },
    { label: t("Gute Züge"), value: s.moves ? `${Math.round((good / s.moves) * 100)} %` : "–" },
  ];

  body.innerHTML = `
    <div class="tiles">
      ${tiles.map((x) => `<div class="tile"><div class="tile-value">${x.value}</div><div class="tile-label">${x.label}</div></div>`).join("")}
    </div>
    <div class="stats-grid">
      <div class="panel themes-panel">
        <h3>${t("Woran es hapert")}</h3>
        <p class="panel-sub">${t("Deine Fehler, Patzer und verpassten Chancen nach Ursache")}</p>
        <div id="theme-rows">${renderThemes(s.themes, games)}</div>
      </div>
      <div class="stats-side">
        <div class="panel">
          <h3>${t("Fehler nach Spielphase")}</h3>
          <p class="panel-sub">${t("Fehler und Patzer pro 100 eigene Züge")}</p>
          ${renderPhases(s)}
        </div>
        ${renderClock(s)}
        <div class="panel">
          <h3>${t("Genauigkeit")}</h3>
          <p class="panel-sub">${t("Deine letzten {n} analysierten Partien", { n: s.trend.length })}</p>
          <div class="trend-wrap"><svg id="trend" class="trend"></svg></div>
        </div>
      </div>
    </div>
    ${rating}
    ${theory}
    <div class="panel openings-panel">
      <h3>${t("Deine Eröffnungen")}</h3>
      <p class="panel-sub">${t("Ergebnis, Genauigkeit und Fehler in den ersten 12 Zügen – mit „Üben“ kommt die Eröffnung in dein Repertoire.")}</p>
      <div id="openings-report" class="openings-report"></div>
    </div>`;

  bindThemeRows();
  renderTrend(s.trend);
  renderRating();
}

function renderThemes(themes: ThemeStat[], games: number): string {
  if (!themes.length) return `<p class="muted">${t("Keine Fehler gefunden – stark!")}</p>`;
  const max = Math.max(...themes.map((x) => x.count));
  return themes
    .map((x) => {
      const meta = THEMES[x.theme];
      const open = expanded === x.theme;
      const examples = open
        ? `<div class="examples">${x.examples
            .map((e) => {
              const num = Math.ceil(e.ply / 2) + (e.ply % 2 ? "." : "...");
              return `<button class="example" data-game="${e.gameId}" data-ply="${e.ply}">
                ${badgeHtml(e.classification)}
                <span class="ex-move">${num} ${esc(fig(e.san))}</span>
                <span class="muted">${t("vs {name}", { name: esc(playerName(e.opponent)) })} · ${date(e.createdAt)}</span>
              </button>`;
            })
            .join("")}${x.count > x.examples.length ? `<p class="muted ex-more">${t("und {n} weitere", { n: x.count - x.examples.length })}</p>` : ""}</div>`
        : "";
      return `<div class="theme ${open ? "open" : ""}">
        <button class="theme-row" data-theme="${x.theme}" title="${esc(meta.tip)}">
          <span class="theme-label">${meta.label}</span>
          <span class="bar-track"><span class="bar" style="width:${(x.count / max) * 100}%"></span></span>
          <span class="theme-count">${trendArrow(x, games)}<b>${x.count}</b> <span class="muted">· ${t("{n}/Partie", { n: fmt(x.count / games) })}</span></span>
        </button>
        ${open ? `<p class="theme-tip">${esc(meta.tip)}</p>${examples}` : ""}
      </div>`;
    })
    .join("");
}

function renderOpenings(list: OpeningStat[]) {
  const el = document.getElementById("openings-report");
  if (!el) return;
  const side = (color: "white" | "black", label: string) => {
    const rows = list.filter((o) => o.color === color).slice(0, 8);
    if (!rows.length) return `<div class="op-col"><h4>${label}</h4><p class="muted">${t("Keine analysierten Partien.")}</p></div>`;
    return `<div class="op-col"><h4>${label}</h4><table class="op-table">
      <tr><th>${t("Eröffnung")}</th><th>${t("Partien")}</th><th>${t("Ergebnis")}</th><th title="${t("Partien mit Fehler oder Patzer in den ersten 12 Zügen")}">${t("Eröffnungsfehler")}</th><th></th></tr>
      ${rows
        .map((o) => {
          const score = Math.round(((o.wins + o.draws / 2) / o.games) * 100);
          const errPct = Math.round((o.gamesWithError / o.games) * 100);
          return `<tr>
            <td class="op-fam" title="${esc(o.family)}">${esc(o.family)}</td>
            <td class="num">${o.games}</td>
            <td class="num" title="${t("{w} Siege, {d} Remis, {l} Niederlagen", { w: o.wins, d: o.draws, l: o.losses })}">${score} %<span class="muted"> · ${o.wins}/${o.draws}/${o.losses}</span></td>
            <td class="num ${errPct >= 50 ? "bad" : ""}" title="${t("{e} Fehler in {g} von {n} Partien", { e: o.openingErrors, g: o.gamesWithError, n: o.games })}">${errPct} %</td>
            <td><button class="op-practice" data-color="${o.color}" data-family="${esc(o.family)}">${t("Üben")}</button></td>
          </tr>`;
        })
        .join("")}
    </table></div>`;
  };
  el.innerHTML = side("white", t("Als Weiß")) + side("black", t("Als Schwarz"));
  el.querySelectorAll<HTMLElement>(".op-practice").forEach((b) =>
    b.addEventListener("click", () => deps.practiceOpening(b.dataset.color as "white" | "black", b.dataset.family!)),
  );
}

/** ↓ improving / ↑ getting worse, compared with the average over all games. */
function trendArrow(x: ThemeStat, games: number): string {
  if (x.baselinePerGame == null) return "";
  const recent = x.count / games;
  const base = x.baselinePerGame;
  const vs = t("{recent} statt {base} pro Partie im Gesamtschnitt", { recent: fmt(recent), base: fmt(base) });
  if (recent < base * 0.8) return `<span class="trend-arrow better" title="${t("Seltener: {vs}", { vs })}">↓</span>`;
  if (recent > base * 1.25) return `<span class="trend-arrow worse" title="${t("Häufiger: {vs}", { vs })}">↑</span>`;
  return `<span class="trend-arrow same" title="${t("Etwa wie immer: {vs}", { vs })}">→</span>`;
}

function bindThemeRows() {
  const s = stats!;
  document.querySelectorAll<HTMLElement>(".theme-row").forEach((row) => {
    row.onclick = () => {
      const th = row.dataset.theme as Theme;
      expanded = expanded === th ? null : th;
      $("theme-rows").innerHTML = renderThemes(s.themes, s.gamesAnalysed);
      bindThemeRows();
    };
  });
  document.querySelectorAll<HTMLElement>(".example").forEach((b) => {
    b.onclick = () => {
      deps.openGame(b.dataset.game!, Number(b.dataset.ply));
    };
  });
}

function renderPhases(s: WeaknessStats): string {
  return errorRateRows(PHASES.map(({ key, label }) => ({ label, p: s.phases[key] })));
}

const CLOCK_BUCKETS: { key: ClockBucket; label: string; hint: string }[] = [
  { key: "plenty", label: t("Viel Zeit"), hint: t("mehr als die Hälfte der Bedenkzeit übrig") },
  { key: "low", label: t("Wenig Zeit"), hint: t("10–50 % der Bedenkzeit übrig") },
  { key: "scramble", label: t("Zeitnot"), hint: t("unter 10 % der Bedenkzeit oder unter 30 Sekunden") },
];

/** Errors by time left on the clock – only when some games carry clock times. */
function renderClock(s: WeaknessStats): string {
  const total = CLOCK_BUCKETS.reduce((n, b) => n + (s.clock?.[b.key]?.moves ?? 0), 0);
  if (!total) return "";
  return `<div class="panel">
    <h3>${t("Fehler nach Bedenkzeit")}</h3>
    <p class="panel-sub">${t("Fehler und Patzer pro 100 eigene Züge, nach Restzeit auf deiner Uhr vor dem Zug")}</p>
    ${errorRateRows(CLOCK_BUCKETS.map((b) => ({ label: b.label, p: s.clock[b.key], hint: b.hint })))}
  </div>`;
}

function errorRateRows(items: { label: string; p?: PhaseStat; hint?: string }[]): string {
  const rows = items.map(({ label, p, hint }) => {
    const rate = p && p.moves ? (p.mistakes / p.moves) * 100 : 0;
    return { label, rate, p, hint };
  });
  const max = Math.max(1, ...rows.map((r) => r.rate));
  return rows
    .map(({ label, rate, p, hint }) => {
      const detail = p
        ? t("{m} Fehler (davon {b} Patzer) in {n} Zügen", { m: p.mistakes, b: p.blunders, n: p.moves })
        : t("Keine Züge");
      return `<div class="phase-row" title="${hint ? `${hint}: ` : ""}${detail}">
        <span class="theme-label">${label}</span>
        <span class="bar-track"><span class="bar" style="width:${(rate / max) * 100}%"></span></span>
        <span class="theme-count"><b>${p?.moves ? fmt(rate) : "–"}</b></span>
      </div>`;
    })
    .join("");
}

// --- accuracy trend (line chart with crosshair tooltip) ----------------------

function renderTrend(points: TrendPoint[]) {
  const svg = document.getElementById("trend") as SVGSVGElement | null;
  if (!svg) return;
  const w = svg.clientWidth || 320;
  const h = 150;
  const pad = { l: 28, r: 8, t: 8, b: 8 };
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("height", String(h));
  if (points.length < 2) {
    svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="axis-label">${t("Mindestens zwei Partien nötig")}</text>`;
    return;
  }
  const lo = Math.max(0, Math.floor((Math.min(...points.map((p) => p.accuracy)) - 5) / 10) * 10);
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (100 - lo)) * (h - pad.t - pad.b);
  const grid = [lo, (lo + 100) / 2, 100]
    .map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v)}" class="axis-label" text-anchor="end" dominant-baseline="middle">${Math.round(v)}</text>`)
    .join("");
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.accuracy).toFixed(1)}`).join("");
  svg.innerHTML = `${grid}
    <path d="${path}" class="trend-line"/>
    <line id="trend-cross" class="crosshair" y1="${pad.t}" y2="${h - pad.b}" visibility="hidden"/>
    <circle id="trend-dot" r="4" class="trend-dot" visibility="hidden"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="transparent" id="trend-hit"/>`;

  hoverChart(svg, {
    count: points.length,
    indexAt: (px) => Math.round(((px - pad.l) / (w - pad.l - pad.r)) * (points.length - 1)),
    pos: (i) => [x(i), y(points[i].accuracy)],
    tip: (i) => {
      const p = points[i];
      return `<b>${fmt(p.accuracy)}</b> ${t("Genauigkeit")}<br><span class="muted">${date(p.createdAt)} · ${RESULT[p.result]}</span><br><span class="muted">${t("Klicken zum Öffnen")}</span>`;
    },
    open: (i) => deps.openGame(points[i].gameId, 0),
    width: w,
  });
}

/** Crosshair, dot and tooltip for a chart with a #…-cross line, #…-dot circle and #…-hit rect. */
function hoverChart(
  svg: SVGSVGElement,
  o: {
    count: number;
    width: number;
    indexAt: (px: number) => number;
    pos: (i: number) => [number, number];
    tip: (i: number) => string;
    open: (i: number) => void;
  },
) {
  const tip = tooltip();
  const hit = svg.querySelector("[id$='-hit']") as SVGRectElement;
  const cross = svg.querySelector("[id$='-cross']") as SVGLineElement;
  const dot = svg.querySelector("[id$='-dot']") as SVGCircleElement;
  const nearest = (ev: MouseEvent) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * o.width;
    return Math.max(0, Math.min(o.count - 1, o.indexAt(px)));
  };
  hit.onmousemove = (ev) => {
    const i = nearest(ev);
    const [cx, cy] = o.pos(i);
    cross.setAttribute("x1", String(cx));
    cross.setAttribute("x2", String(cx));
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("visibility", "visible");
    tip.innerHTML = o.tip(i);
    tip.style.display = "block";
    // keep the tooltip on screen near the right edge
    const right = ev.clientX + 12 + tip.offsetWidth > window.innerWidth;
    tip.style.left = `${right ? ev.clientX - 12 - tip.offsetWidth : ev.clientX + 12}px`;
    tip.style.top = `${ev.clientY + 12}px`;
  };
  hit.onmouseleave = () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.style.display = "none";
  };
  hit.onclick = (ev) => {
    tip.style.display = "none";
    o.open(nearest(ev));
  };
}

function tooltip(): HTMLElement {
  let el = document.getElementById("chart-tip");
  if (!el) {
    el = document.createElement("div");
    el.id = "chart-tip";
    el.className = "chart-tip";
    document.body.appendChild(el);
  }
  return el;
}

// --- rating history and activity ---------------------------------------------

type RatingRange = "3m" | "1y" | "all";
const DAY = 24 * 3600 * 1000;
const RANGE_MS: Record<RatingRange, number> = { "3m": 92 * DAY, "1y": 366 * DAY, all: Infinity };

interface Category {
  key: string;
  label: string;
  games: GameSummary[];
  rated: number;
}

/** Your games per platform and speed, those with ratings first. */
function categories(): Category[] {
  const map = new Map<string, Category>();
  for (const g of summaries) {
    const key = `${g.source}:${g.speed}`;
    let c = map.get(key);
    if (!c) {
      const label = `${platformLabel(g.source)} · ${speedLabel(g.speed)}`;
      c = { key, label, games: [], rated: 0 };
      map.set(key, c);
    }
    c.games.push(g);
    if (g.rated && g.rating) c.rated++;
  }
  return [...map.values()].sort((a, b) => b.rated - a.rated || b.games.length - a.games.length);
}

function ratingRange(): RatingRange {
  const r = store.get("rating-range");
  return r === "3m" || r === "1y" ? r : "all";
}

let ratingView: { cat: Category; range: RatingRange } | null = null;

function renderRating() {
  const el = document.getElementById("rating-panel");
  if (!el) return;
  const cats = categories();
  if (!cats.length) {
    el.innerHTML = `<h3>${t("Wertungsverlauf")}</h3><p class="muted">${t("Noch keine eigenen Partien gespeichert.")}</p>`;
    ratingView = null;
    return;
  }
  const saved = store.get("rating-cat");
  const cat = cats.find((c) => c.key === saved) ?? cats[0];
  const range = ratingRange();
  ratingView = { cat, range };

  const since = Date.now() - RANGE_MS[range];
  const games = cat.games.filter((g) => g.createdAt >= since).sort((a, b) => a.createdAt - b.createdAt);
  const rated = games.filter((g) => g.rated && g.rating);
  const w = games.filter((g) => g.result === "win").length;
  const d = games.filter((g) => g.result === "draw").length;
  const l = games.length - w - d;

  let tiles = "";
  if (rated.length) {
    const first = rated[0].rating!;
    const last = rated[rated.length - 1].rating!;
    const peak = Math.max(...rated.map((g) => g.rating!));
    const diff = last - first;
    tiles = `
      <div class="mini-tile"><b>${last}</b><span>${t("Aktuelle Wertung")}</span></div>
      <div class="mini-tile"><b class="${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${diff > 0 ? "+" : ""}${diff}</b><span>${range === "all" ? t("Seit Beginn") : t("Im Zeitraum")}</span></div>
      <div class="mini-tile"><b>${peak}</b><span>${t("Höchste")}</span></div>`;
  }
  const score = games.length ? Math.round(((w + d / 2) / games.length) * 100) : 0;
  tiles += `<div class="mini-tile"><b>${games.length}</b><span>${t("Partien")} · ${score} %</span></div>`;

  el.innerHTML = `
    <div class="panel-head">
      <div>
        <h3>${t("Wertung und Aktivität")}</h3>
        <p class="panel-sub">${t("Wirst du besser? Deine Wertung nach jeder gewerteten Partie – unabhängig von der Auswahl oben.")}</p>
      </div>
      <div class="rating-controls">
        <select id="rating-cat" title="${t("Plattform und Bedenkzeit")}">
          ${cats.map((c) => `<option value="${c.key}"${c === cat ? " selected" : ""}>${esc(c.label)} (${c.games.length})</option>`).join("")}
        </select>
        <div id="rating-range" class="segmented">
          ${(["3m", "1y", "all"] as RatingRange[])
            .map((r) => `<button data-r="${r}" class="${r === range ? "active" : ""}">${{ "3m": t("3 Monate"), "1y": t("1 Jahr"), all: t("Alles") }[r]}</button>`)
            .join("")}
        </div>
      </div>
    </div>
    <div class="mini-tiles">${tiles}<div class="mini-tile wdl"><span class="wdl-bar">${wdlBar(w, d, l)}</span><span>${t("{w} S · {d} R · {l} N", { w, d, l })}</span></div></div>
    <div class="trend-wrap"><svg id="rating-chart" class="trend"></svg></div>
    <h4 class="sub-head">${t("Aktivität")}</h4>
    <div class="trend-wrap"><svg id="activity-chart" class="trend activity"></svg></div>`;

  ($("rating-cat") as HTMLSelectElement).onchange = (e) => {
    store.set("rating-cat", (e.target as HTMLSelectElement).value);
    renderRating();
  };
  el.querySelectorAll<HTMLElement>("#rating-range button").forEach((b) => {
    b.onclick = () => {
      store.set("rating-range", b.dataset.r!);
      renderRating();
    };
  });
  renderRatingCharts();
}

function wdlBar(w: number, d: number, l: number): string {
  const n = w + d + l || 1;
  return `<span class="wdl-w" style="width:${(w / n) * 100}%"></span><span class="wdl-d" style="width:${(d / n) * 100}%"></span><span class="wdl-l" style="width:${(l / n) * 100}%"></span>`;
}

function renderRatingCharts() {
  if (!ratingView || !document.getElementById("rating-chart")) return;
  const { cat, range } = ratingView;
  const since = Date.now() - RANGE_MS[range];
  const games = cat.games.filter((g) => g.createdAt >= since).sort((a, b) => a.createdAt - b.createdAt);
  renderRatingLine(games.filter((g) => g.rated && g.rating));
  renderActivity(games, range);
}

function renderRatingLine(points: GameSummary[]) {
  const svg = $("rating-chart") as unknown as SVGSVGElement;
  const w = svg.clientWidth || 600;
  const h = 170;
  const pad = { l: 40, r: 8, t: 10, b: 20 };
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("height", String(h));
  if (points.length < 2) {
    svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="axis-label">${
      points.length ? t("Mindestens zwei gewertete Partien nötig") : t("Keine gewerteten Partien in diesem Zeitraum")
    }</text>`;
    return;
  }
  const ratings = points.map((p) => p.rating!);
  let lo = Math.min(...ratings);
  let hi = Math.max(...ratings);
  const step = hi - lo > 400 ? 100 : 50;
  lo = Math.floor((lo - 10) / step) * step;
  hi = Math.ceil((hi + 10) / step) * step;
  const t0 = points[0].createdAt;
  const t1 = points[points.length - 1].createdAt;
  const x = (ms: number) => pad.l + ((ms - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const lines: number[] = [];
  const every = (hi - lo) / step > 6 ? step * 2 : step;
  for (let v = Math.ceil(lo / every) * every; v <= hi; v += every) lines.push(v);
  const grid = lines
    .map((v) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 6}" y="${y(v)}" class="axis-label" text-anchor="end" dominant-baseline="middle">${v}</text>`)
    .join("");
  const span = t1 - t0;
  const labelFmt: Intl.DateTimeFormatOptions = span > 300 * DAY ? { month: "short", year: "2-digit" } : { day: "2-digit", month: "short" };
  const xLabels = [0, 0.5, 1]
    .map((f) => {
      const ms = t0 + f * span;
      const anchor = f === 0 ? "start" : f === 1 ? "end" : "middle";
      return `<text x="${x(ms)}" y="${h - 4}" class="axis-label" text-anchor="${anchor}">${new Date(ms).toLocaleDateString(locale, labelFmt)}</text>`;
    })
    .join("");
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.createdAt).toFixed(1)},${y(p.rating!).toFixed(1)}`).join("");
  svg.innerHTML = `${grid}${xLabels}
    <path d="${path}" class="trend-line"/>
    <line id="rating-cross" class="crosshair" y1="${pad.t}" y2="${h - pad.b}" visibility="hidden"/>
    <circle id="rating-dot" r="4" class="trend-dot" visibility="hidden"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="transparent" id="rating-hit"/>`;

  const xs = points.map((p) => x(p.createdAt));
  hoverChart(svg, {
    count: points.length,
    width: w,
    indexAt: (px) => {
      // nearest point in time (points are sorted)
      let best = 0;
      for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - px) < Math.abs(xs[best] - px)) best = i;
      return best;
    },
    pos: (i) => [xs[i], y(points[i].rating!)],
    tip: (i) => {
      const p = points[i];
      const prev = points[i - 1]?.rating;
      const diff = prev ? p.rating! - prev : 0;
      const opp = `${esc(playerName(p.opponent))}${p.opponentRating ? ` (${p.opponentRating})` : ""}`;
      return `<b>${p.rating}</b>${diff ? ` <span class="${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : ""}${diff}</span>` : ""}<br>
        <span class="muted">${date(p.createdAt)} · ${RESULT[p.result]} ${t("vs {name}", { name: opp })}</span><br>
        <span class="muted">${t("Klicken zum Öffnen")}</span>`;
    },
    open: (i) => deps.openGame(points[i].id, 0),
  });
}

/** Games per week (3 months) or month, stacked by result. */
function renderActivity(games: GameSummary[], range: RatingRange) {
  const svg = $("activity-chart") as unknown as SVGSVGElement;
  const w = svg.clientWidth || 600;
  const h = 110;
  const pad = { l: 40, r: 8, t: 8, b: 20 };
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("height", String(h));
  if (!games.length) {
    svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="axis-label">${t("Keine Partien in diesem Zeitraum")}</text>`;
    return;
  }
  const weekly = range === "3m";
  const bucketStart = (ms: number) => {
    const d = new Date(ms);
    if (weekly) {
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    } else {
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
    }
    return d.getTime();
  };
  const next = (ms: number) => {
    const d = new Date(ms);
    if (weekly) d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
    return d.getTime();
  };
  const first = bucketStart(range === "all" ? games[0].createdAt : Math.max(games[0].createdAt, Date.now() - RANGE_MS[range]));
  const buckets: { start: number; w: number; d: number; l: number }[] = [];
  for (let b = first; b <= Date.now(); b = next(b)) buckets.push({ start: b, w: 0, d: 0, l: 0 });
  for (const g of games) {
    const b = buckets.find((x, i) => g.createdAt >= x.start && (i === buckets.length - 1 || g.createdAt < buckets[i + 1].start));
    if (b) b[g.result === "win" ? "w" : g.result === "draw" ? "d" : "l"]++;
  }
  const max = Math.max(1, ...buckets.map((b) => b.w + b.d + b.l));
  const slot = (w - pad.l - pad.r) / buckets.length;
  const bw = Math.max(2, Math.min(28, slot * 0.7));
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const labelEvery = Math.ceil(buckets.length / 8);
  const fmtLabel = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, weekly ? { day: "2-digit", month: "2-digit" } : buckets.length > 14 ? { month: "short", year: "2-digit" } : { month: "short" });
  const bars = buckets
    .map((b, i) => {
      const cx = pad.l + slot * (i + 0.5);
      const x0 = cx - bw / 2;
      let top = h - pad.b;
      const seg = (n: number, cls: string) => {
        if (!n) return "";
        const hgt = y(0) - y(n);
        top -= hgt;
        return `<rect x="${x0.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" class="${cls}"/>`;
      };
      const label = i % labelEvery === 0 ? `<text x="${cx}" y="${h - 4}" class="axis-label" text-anchor="middle">${fmtLabel(b.start)}</text>` : "";
      return seg(b.w, "act-w") + seg(b.d, "act-d") + seg(b.l, "act-l") + label;
    })
    .join("");
  svg.innerHTML = `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(max)}" y2="${y(max)}" class="grid"/>
    <text x="${pad.l - 6}" y="${y(max)}" class="axis-label" text-anchor="end" dominant-baseline="middle">${max}</text>
    <text x="${pad.l - 6}" y="${y(0)}" class="axis-label" text-anchor="end" dominant-baseline="middle">0</text>
    ${bars}
    <line id="act-cross" class="crosshair" y1="${pad.t}" y2="${h - pad.b}" visibility="hidden"/>
    <circle id="act-dot" r="0" visibility="hidden"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="transparent" id="act-hit" style="cursor:default"/>`;

  hoverChart(svg, {
    count: buckets.length,
    width: w,
    indexAt: (px) => Math.floor((px - pad.l) / slot),
    pos: (i) => [pad.l + slot * (i + 0.5), y(0)],
    tip: (i) => {
      const b = buckets[i];
      const n = b.w + b.d + b.l;
      const when = weekly
        ? t("Woche ab {date}", { date: new Date(b.start).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "2-digit" }) })
        : new Date(b.start).toLocaleDateString(locale, { month: "long", year: "numeric" });
      return `<b>${tn(n, "1 Partie", "{n} Partien")}</b><br><span class="muted">${when}</span>${
        n ? `<br>${t("{w} S · {d} R · {l} N", { w: b.w, d: b.d, l: b.l })}` : ""
      }`;
    },
    open: () => {},
  });
}

// --- where you leave opening theory --------------------------------------------

function renderTheory(r: TheoryReport) {
  const el = document.getElementById("theory-panel");
  if (!el) return;
  const head = `<h3>${t("Hier verlässt du die Theorie")}</h3>
    <p class="panel-sub">${t("Stellungen, in denen du immer wieder als Erster die bekannten Eröffnungslinien verlässt. Abweichen ist nicht automatisch schlecht – entscheidend ist, ob es dich etwas kostet (dafür müssen die Partien analysiert sein).")}</p>`;
  if (!r.games) {
    el.innerHTML = `${head}<p class="muted">${t("Noch keine eigenen Partien gespeichert.")}</p>`;
    return;
  }
  const share = r.youFirst + r.opponentFirst;
  const summary = share
    ? `<p class="theory-summary">${t("In {you} von {n} Partien weichst du zuerst ab, in {opp} dein Gegner.", { you: r.youFirst, n: share, opp: r.opponentFirst })}${
        r.avgExitMove ? ` ${t("Im Schnitt in Zug {m}.", { m: fmt(r.avgExitMove) })}` : ""
      }</p>`
    : "";
  if (!r.positions.length) {
    el.innerHTML = `${head}${summary}<p class="muted">${t("Noch keine Stellung, in der du mehrmals abweichst – mit mehr Partien wird das hier aussagekräftiger.")}</p>`;
    return;
  }
  el.innerHTML = `${head}${summary}<div class="theory-list">${r.positions.map(theoryRow).join("")}</div>`;
  el.querySelectorAll<HTMLElement>("[data-open]").forEach((b) => (b.onclick = () => deps.openGame(b.dataset.open!, Number(b.dataset.ply) - 1)));
  el.querySelectorAll<HTMLElement>("[data-practice]").forEach(
    (b) => (b.onclick = () => deps.practiceOpening(b.dataset.color as "white" | "black", b.dataset.practice!)),
  );
}

function theoryRow(p: TheoryExit): string {
  const num = Math.ceil(p.ply / 2) + (p.ply % 2 ? "." : "...");
  const played = p.played
    .map((m) => `<b>${num} ${esc(fig(m.san))}</b>${p.played.length > 1 || m.count > 1 ? ` <span class="muted">${m.count}×</span>` : ""}`)
    .join(", ");
  const book = p.book.length ? p.book.map((s) => esc(fig(s))).join(", ") : "–";
  // Did leaving theory cost you something? Only with analysed games.
  let verdict = `<span class="verdict muted">${t("Noch nicht analysiert")}</span>`;
  if (p.analysed) {
    const bad = (p.avgLoss ?? 0) >= 8 || p.errorsAfter * 2 >= p.analysed;
    const ok = (p.avgLoss ?? 0) < 3 && p.errorsAfter === 0;
    const parts = [t("Ø −{n} % Gewinnchance durch deinen Zug", { n: fmt(p.avgLoss ?? 0) })];
    if (p.errorsAfter) parts.push(t("in {e} von {n} Partien folgt bald ein Fehler", { e: p.errorsAfter, n: p.analysed }));
    verdict = `<span class="verdict ${bad ? "bad" : ok ? "ok" : ""}">${bad ? t("Kostet dich") : ok ? t("Hält") : t("Etwas ungenau")}</span>
      <span class="muted">${parts.join(" · ")}${p.analysed < p.games ? ` · ${t("{a} von {n} analysiert", { a: p.analysed, n: p.games })}` : ""}</span>`;
  }
  const best = p.best && !p.book.includes(p.best) ? ` · ${t("Engine: {m}", { m: `<b>${esc(fig(p.best))}</b>` })}` : "";
  return `<div class="theory-row">
    <div class="mini-board cg-wrap" title="${esc(p.opening ?? "")}">${miniPieces(p.fen, p.color === "black")}</div>
    <div class="theory-info">
      <div class="theory-title">${esc(p.opening ?? t("Unbekannte Eröffnung"))}</div>
      <div>${t("Du spielst {moves}", { moves: played })} <span class="muted">· ${p.color === "white" ? t("als Weiß") : t("als Schwarz")} · ${tn(p.games, "1 Partie", "{n} Partien")} · ${p.wins}/${p.draws}/${p.losses}</span></div>
      <div class="muted">${t("Bekannte Linien: {moves}", { moves: `<span class="theory-book">${book}</span>` })}${best}</div>
      <div class="theory-verdict">${verdict}</div>
    </div>
    <div class="theory-actions">
      <button data-open="${p.gameId}" data-ply="${p.ply}" title="${t("Letzte Partie mit dieser Stellung öffnen")}">${t("Ansehen")}</button>
      ${p.family ? `<button data-practice="${esc(p.family)}" data-color="${p.color}" title="${t("Die Eröffnung im Trainer üben")}">${t("Üben")}</button>` : ""}
    </div>
  </div>`;
}

// --- batch analysis ------------------------------------------------------------

function renderBatch() {
  const el = $("batch");
  if (batch) {
    const pct = batch.total ? (batch.done / batch.total) * 100 : 0;
    el.innerHTML = `<div class="batch-run">
      <span class="muted">${t("Analysiere Partie {n} von {total} …", { n: Math.min(batch.done + 1, batch.total), total: batch.total })}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <button id="batch-cancel">${t("Abbrechen")}</button>
    </div>`;
    $("batch-cancel").onclick = () => invoke("cancel_batch");
    return;
  }
  const missing = stats ? stats.gamesTotal - stats.gamesAnalysed : 0;
  if (!stats || missing <= 0) {
    el.innerHTML = stats?.gamesTotal ? `<span class="muted">${t("Alle Partien analysiert ✓")}</span>` : "";
    return;
  }
  const n = Math.min(missing, BATCH_SIZE);
  el.innerHTML = `<button id="batch-start" class="primary" title="${t("Läuft im Hintergrund – du kannst währenddessen weiter Partien ansehen")}">
      ${n === missing ? t("Restliche {n} Partien analysieren", { n }) : t("{n} weitere Partien analysieren", { n })}
    </button>`;
  $("batch-start").onclick = startBatch;
}

async function startBatch() {
  const accounts = deps.accounts();
  if (!accounts.length || !stats) return;
  const missing = stats.gamesTotal - stats.gamesAnalysed;
  batch = { done: 0, total: Math.min(missing, BATCH_SIZE), current: null, finished: false };
  renderBatch();
  try {
    await invoke<number>("analyse_all", { accounts, depth: deps.depth(), limit: BATCH_SIZE });
  } catch (e) {
    $("batch").innerHTML = `<span class="error">${esc(String(e))}</span>`;
  } finally {
    batch = null;
    loadStats();
  }
}
