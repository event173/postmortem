// "Statistik" view: weakness themes, error rate by phase, accuracy trend,
// and the background "analyse all games" batch.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { BatchProgress, Phase, Theme, ThemeStat, TrendPoint, WeaknessStats } from "./types";
import { $, badgeHtml, esc, fig } from "./util";

export interface StatsDeps {
  username: () => string;
  depth: () => number;
  /** Open a game in the review view at the given ply. */
  openGame: (gameId: string, ply: number) => void;
  /** Called after the batch analysed a game (to refresh "analysed" markers). */
  onGamesAnalysed: () => void;
}

const THEMES: Record<Theme, { label: string; tip: string }> = {
  hangingPiece: {
    label: "Figur hängen lassen",
    tip: "Vor jedem Zug kurz prüfen: Welche meiner Figuren sind angegriffen oder ungedeckt?",
  },
  allowedFork: {
    label: "Gabel zugelassen",
    tip: "Achte auf Felder, von denen ein Springer oder die Dame zwei deiner Figuren zugleich angreift.",
  },
  allowedMate: {
    label: "Matt zugelassen",
    tip: "Prüfe nach jedem Zug die Schachgebote des Gegners – besonders gegen die Grundreihe.",
  },
  missedMate: {
    label: "Matt übersehen",
    tip: "Hat der gegnerische König wenig Felder, rechne zuerst alle Schachgebote durch.",
  },
  lostMaterial: {
    label: "Material durch Taktik verloren",
    tip: "Vor dem Zug die erzwingenden Antworten des Gegners prüfen: Schach, Schlagen, Drohungen.",
  },
  missedTactic: {
    label: "Materialgewinn übersehen",
    tip: "Such in jeder Stellung zuerst nach Schach, Schlagzügen und Drohungen – für dich.",
  },
  missedChance: {
    label: "Gegnerfehler nicht genutzt",
    tip: "Nach einem überraschenden Zug des Gegners: Was hat er gerade ungedeckt gelassen?",
  },
  positional: {
    label: "Stellung verschlechtert",
    tip: "Keine direkte Taktik – oft passive Figuren, schwache Felder oder ein fehlender Plan.",
  },
};

const PHASES: { key: Phase; label: string }[] = [
  { key: "opening", label: "Eröffnung" },
  { key: "middlegame", label: "Mittelspiel" },
  { key: "endgame", label: "Endspiel" },
];

const BATCH_SIZE = 50;

let deps: StatsDeps;
let stats: WeaknessStats | null = null;
let batch: BatchProgress | null = null;
let expanded: Theme | null = null;
let loadToken = 0;

const fmt = (n: number, digits = 1) => n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const date = (ms: number) => new Date(ms).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });

export function initStats(d: StatsDeps) {
  deps = d;
  $("tab-review").addEventListener("click", () => showStatsView(false));
  $("tab-stats").addEventListener("click", () => showStatsView(true));
  window.addEventListener("resize", () => {
    if (stats && !$("stats").hidden) renderTrend(stats.trend);
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

export function showStatsView(show: boolean) {
  $("stats").hidden = !show;
  document.querySelector(".layout")!.classList.toggle("stats-mode", show);
  $("tab-stats").classList.toggle("active", show);
  $("tab-review").classList.toggle("active", !show);
  if (show) loadStats();
}

export async function loadStats() {
  const username = deps.username();
  const body = $("stats-body");
  if (!username) {
    stats = null;
    $("stats-basis").textContent = "";
    body.innerHTML = `<p class="empty">Lade zuerst deine Partien über deinen Lichess-Namen.</p>`;
    renderBatch();
    return;
  }
  const token = ++loadToken;
  try {
    const s = await invoke<WeaknessStats>("weakness_stats", { username });
    if (token !== loadToken) return;
    stats = s;
    render();
  } catch (e) {
    body.innerHTML = `<p class="empty error">${esc(String(e))}</p>`;
  }
}

function render() {
  const s = stats!;
  $("stats-basis").textContent = s.gamesAnalysed
    ? `Basierend auf ${s.gamesAnalysed} von ${s.gamesTotal} gespeicherten Partien`
    : `${s.gamesTotal} Partien gespeichert, noch keine analysiert`;
  renderBatch();

  const body = $("stats-body");
  if (!s.gamesAnalysed) {
    body.innerHTML = `<p class="empty">Analysiere ein paar Partien, dann siehst du hier, woran es am häufigsten hapert.</p>`;
    return;
  }

  const games = s.gamesAnalysed;
  const c = (k: keyof typeof s.classes) => s.classes[k] ?? 0;
  const good = c("brilliant") + c("great") + c("best") + c("excellent") + c("good") + c("book") + c("forced");
  const tiles = [
    { label: "Genauigkeit Ø", value: s.accuracyAvg !== null ? fmt(s.accuracyAvg) : "–" },
    { label: "Patzer pro Partie", value: fmt(c("blunder") / games) },
    { label: "Fehler pro Partie", value: fmt((c("mistake") + c("miss")) / games) },
    { label: "Gute Züge", value: s.moves ? `${Math.round((good / s.moves) * 100)} %` : "–" },
  ];

  body.innerHTML = `
    <div class="tiles">
      ${tiles.map((t) => `<div class="tile"><div class="tile-value">${t.value}</div><div class="tile-label">${t.label}</div></div>`).join("")}
    </div>
    <div class="stats-grid">
      <div class="panel themes-panel">
        <h3>Woran es hapert</h3>
        <p class="panel-sub">Deine Fehler, Patzer und verpassten Chancen nach Ursache</p>
        <div id="theme-rows">${renderThemes(s.themes, games)}</div>
      </div>
      <div class="stats-side">
        <div class="panel">
          <h3>Fehler nach Spielphase</h3>
          <p class="panel-sub">Fehler und Patzer pro 100 eigene Züge</p>
          ${renderPhases(s)}
        </div>
        <div class="panel">
          <h3>Genauigkeit</h3>
          <p class="panel-sub">Deine letzten ${s.trend.length} analysierten Partien</p>
          <div class="trend-wrap"><svg id="trend" class="trend"></svg></div>
        </div>
      </div>
    </div>`;

  bindThemeRows();
  renderTrend(s.trend);
}

function renderThemes(themes: ThemeStat[], games: number): string {
  if (!themes.length) return `<p class="muted">Keine Fehler gefunden – stark!</p>`;
  const max = Math.max(...themes.map((t) => t.count));
  return themes
    .map((t) => {
      const meta = THEMES[t.theme];
      const open = expanded === t.theme;
      const examples = open
        ? `<div class="examples">${t.examples
            .map((e) => {
              const num = Math.ceil(e.ply / 2) + (e.ply % 2 ? "." : "...");
              return `<button class="example" data-game="${e.gameId}" data-ply="${e.ply}">
                ${badgeHtml(e.classification)}
                <span class="ex-move">${num} ${esc(fig(e.san))}</span>
                <span class="muted">vs ${esc(e.opponent)} · ${date(e.createdAt)}</span>
              </button>`;
            })
            .join("")}${t.count > t.examples.length ? `<p class="muted ex-more">und ${t.count - t.examples.length} weitere</p>` : ""}</div>`
        : "";
      return `<div class="theme ${open ? "open" : ""}">
        <button class="theme-row" data-theme="${t.theme}" title="${esc(meta.tip)}">
          <span class="theme-label">${meta.label}</span>
          <span class="bar-track"><span class="bar" style="width:${(t.count / max) * 100}%"></span></span>
          <span class="theme-count"><b>${t.count}</b> <span class="muted">· ${fmt(t.count / games)}/Partie</span></span>
        </button>
        ${open ? `<p class="theme-tip">${esc(meta.tip)}</p>${examples}` : ""}
      </div>`;
    })
    .join("");
}

function bindThemeRows() {
  const s = stats!;
  document.querySelectorAll<HTMLElement>(".theme-row").forEach((row) => {
    row.onclick = () => {
      const t = row.dataset.theme as Theme;
      expanded = expanded === t ? null : t;
      $("theme-rows").innerHTML = renderThemes(s.themes, s.gamesAnalysed);
      bindThemeRows();
    };
  });
  document.querySelectorAll<HTMLElement>(".example").forEach((b) => {
    b.onclick = () => {
      showStatsView(false);
      deps.openGame(b.dataset.game!, Number(b.dataset.ply));
    };
  });
}

function renderPhases(s: WeaknessStats): string {
  const rows = PHASES.map(({ key, label }) => {
    const p = s.phases[key];
    const rate = p && p.moves ? (p.mistakes / p.moves) * 100 : 0;
    return { label, rate, p };
  });
  const max = Math.max(1, ...rows.map((r) => r.rate));
  return rows
    .map(
      ({ label, rate, p }) => `<div class="phase-row" title="${p ? `${p.mistakes} Fehler (davon ${p.blunders} Patzer) in ${p.moves} Zügen` : "Keine Züge"}">
        <span class="theme-label">${label}</span>
        <span class="bar-track"><span class="bar" style="width:${(rate / max) * 100}%"></span></span>
        <span class="theme-count"><b>${p?.moves ? fmt(rate) : "–"}</b></span>
      </div>`,
    )
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
    svg.innerHTML = `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="axis-label">Mindestens zwei Partien nötig</text>`;
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

  const tip = tooltip();
  const hit = svg.querySelector("#trend-hit") as SVGRectElement;
  const cross = svg.querySelector("#trend-cross") as SVGLineElement;
  const dot = svg.querySelector("#trend-dot") as SVGCircleElement;
  const nearest = (ev: MouseEvent) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * w;
    const i = Math.round(((px - pad.l) / (w - pad.l - pad.r)) * (points.length - 1));
    return Math.max(0, Math.min(points.length - 1, i));
  };
  const RESULT = { win: "Sieg", loss: "Niederlage", draw: "Remis" };
  hit.onmousemove = (ev) => {
    const i = nearest(ev);
    const p = points[i];
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", String(x(i)));
    dot.setAttribute("cy", String(y(p.accuracy)));
    dot.setAttribute("visibility", "visible");
    tip.innerHTML = `<b>${fmt(p.accuracy)}</b> Genauigkeit<br><span class="muted">${date(p.createdAt)} · ${RESULT[p.result]}</span><br><span class="muted">Klicken zum Öffnen</span>`;
    tip.style.display = "block";
    tip.style.left = `${ev.clientX + 12}px`;
    tip.style.top = `${ev.clientY + 12}px`;
  };
  hit.onmouseleave = () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.style.display = "none";
  };
  hit.onclick = (ev) => {
    tip.style.display = "none";
    showStatsView(false);
    deps.openGame(points[nearest(ev)].gameId, 0);
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

// --- batch analysis ------------------------------------------------------------

function renderBatch() {
  const el = $("batch");
  if (batch) {
    const pct = batch.total ? (batch.done / batch.total) * 100 : 0;
    el.innerHTML = `<div class="batch-run">
      <span class="muted">Analysiere Partie ${Math.min(batch.done + 1, batch.total)} von ${batch.total} …</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <button id="batch-cancel">Abbrechen</button>
    </div>`;
    $("batch-cancel").onclick = () => invoke("cancel_batch");
    return;
  }
  const missing = stats ? stats.gamesTotal - stats.gamesAnalysed : 0;
  if (!stats || missing <= 0) {
    el.innerHTML = stats?.gamesTotal ? `<span class="muted">Alle Partien analysiert ✓</span>` : "";
    return;
  }
  const n = Math.min(missing, BATCH_SIZE);
  el.innerHTML = `<button id="batch-start" class="primary" title="Läuft im Hintergrund – du kannst währenddessen weiter Partien ansehen">
      ${n === missing ? `Restliche ${n} Partien analysieren` : `${n} weitere Partien analysieren`}
    </button>`;
  $("batch-start").onclick = startBatch;
}

async function startBatch() {
  const username = deps.username();
  if (!username || !stats) return;
  const missing = stats.gamesTotal - stats.gamesAnalysed;
  batch = { done: 0, total: Math.min(missing, BATCH_SIZE), current: null, finished: false };
  renderBatch();
  try {
    await invoke<number>("analyse_all", { username, depth: deps.depth(), limit: BATCH_SIZE });
  } catch (e) {
    $("batch").innerHTML = `<span class="error">${esc(String(e))}</span>`;
  } finally {
    batch = null;
    loadStats();
  }
}
