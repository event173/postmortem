// Settings dialog (gear icon): analysis depth, engine, display, puzzle database.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { $, esc, miniPieces, store } from "./util";
import { moveSound, soundOn, volume } from "./sound";

interface SettingsInfo {
  stockfishPath: string | null;
  detectedPath: string | null;
  threads: number | null;
  cpuCount: number;
  dataDir: string;
  games: number;
  reviews: number;
}

interface PuzzleStatus {
  installed: boolean;
  count: number;
  version: string | null;
  sizeBytes: number;
}

interface UpdateCheck {
  offline: boolean;
  remoteVersion: string | null;
  remoteSize: number | null;
  available: boolean;
}

interface PuzzleProgress {
  phase: "download" | "import" | "index" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  message: string | null;
}

export interface DisplayPrefs {
  animMs: number;
  coordinates: boolean;
}

export interface SettingsDeps {
  /** Apply animation / coordinate preferences to the board. */
  applyDisplay: (prefs: DisplayPrefs) => void;
  /** Engine path or threads changed (refresh status, restart live engine). */
  onEngineChanged: () => void;
  /** The "live engine on" preference changed. */
  onLiveDefault: (on: boolean) => void;
}

let deps: SettingsDeps;
let puzzle: PuzzleStatus | null = null;
let update: UpdateCheck | null = null;
let installing = false;

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000).toLocaleString("de-DE")} MB`;
const versionDate = (v: string | null) => {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" }) : "unbekannt";
};

/** Board colours and piece set: applied via <body data-board / data-pieces>. */
export function applyTheme() {
  document.body.dataset.board = store.get("board") ?? "brown";
  document.body.dataset.pieces = store.get("pieces") ?? "cburnett";
}

const PREVIEW_FEN = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 1";

export function displayPrefs(): DisplayPrefs {
  const anim = Number(store.get("anim") ?? "230");
  return { animMs: Number.isFinite(anim) ? anim : 230, coordinates: store.get("coords") !== "0" };
}

export function initSettings(d: SettingsDeps) {
  deps = d;
  const dialog = $("settings") as HTMLDialogElement;
  $("btn-settings").addEventListener("click", () => {
    dialog.showModal();
    refresh();
  });
  // Click on the backdrop closes the dialog.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  const depth = $("depth") as HTMLSelectElement;
  depth.value = store.get("depth") ?? "16";
  depth.addEventListener("change", () => store.set("depth", depth.value));

  const live = $("pref-live") as HTMLInputElement;
  live.checked = store.get("live") !== "0";
  live.addEventListener("change", () => {
    store.set("live", live.checked ? "1" : "0");
    deps.onLiveDefault(live.checked);
  });

  const anim = $("pref-anim") as HTMLSelectElement;
  const coords = $("pref-coords") as HTMLInputElement;
  const prefs = displayPrefs();
  anim.value = String(prefs.animMs);
  coords.checked = prefs.coordinates;
  const applyDisplay = () => {
    store.set("anim", anim.value);
    store.set("coords", coords.checked ? "1" : "0");
    deps.applyDisplay(displayPrefs());
  };
  anim.addEventListener("change", applyDisplay);
  coords.addEventListener("change", applyDisplay);

  // Board colours and pieces: CSS only, takes effect immediately everywhere.
  const boardSel = $("pref-board") as HTMLSelectElement;
  const piecesSel = $("pref-pieces") as HTMLSelectElement;
  boardSel.value = store.get("board") ?? "brown";
  piecesSel.value = store.get("pieces") ?? "cburnett";
  $("theme-preview").innerHTML = miniPieces(PREVIEW_FEN);
  const applyThemeChoice = () => {
    store.set("board", boardSel.value);
    store.set("pieces", piecesSel.value);
    applyTheme();
  };
  boardSel.addEventListener("change", applyThemeChoice);
  piecesSel.addEventListener("change", applyThemeChoice);
  applyTheme();

  // Sounds: a short sample on every change.
  const soundBox = $("pref-sound") as HTMLInputElement;
  const vol = $("pref-volume") as HTMLInputElement;
  soundBox.checked = soundOn();
  vol.value = String(volume());
  vol.disabled = !soundBox.checked;
  soundBox.addEventListener("change", () => {
    store.set("sound", soundBox.checked ? "wood" : "off");
    vol.disabled = !soundBox.checked;
    moveSound("Nf3");
  });
  vol.addEventListener("change", () => {
    store.set("volume", vol.value);
    moveSound("Nxf3");
  });

  $("engine-apply").addEventListener("click", applyEngine);
  $("puzzle-action").addEventListener("click", installPuzzles);
  $("puzzle-cancel").addEventListener("click", () => invoke("puzzle_cancel"));
  $("puzzle-delete").addEventListener("click", deletePuzzles);

  listen<PuzzleProgress>("puzzle-progress", (e) => renderProgress(e.payload));

  // Quietly check for a newer puzzle database on start (only if one is installed).
  invoke<PuzzleStatus>("puzzle_status").then(async (st) => {
    puzzle = st;
    if (!st.installed) return;
    update = await invoke<UpdateCheck>("puzzle_check_update");
    $("settings-dot").hidden = !update.available;
  });
}

async function refresh() {
  const [info, st] = await Promise.all([invoke<SettingsInfo>("get_settings"), invoke<PuzzleStatus>("puzzle_status")]);
  renderEngine(info);
  puzzle = st;
  renderPuzzle();
  $("data-info").innerHTML =
    `${info.games.toLocaleString("de-DE")} Partien gespeichert, davon ${info.reviews.toLocaleString("de-DE")} analysiert.<br>` +
    `<span class="muted">Speicherort: ${esc(info.dataDir)}</span>`;
  if (!installing) {
    update = await invoke<UpdateCheck>("puzzle_check_update");
    $("settings-dot").hidden = !(puzzle.installed && update.available);
    renderPuzzle();
  }
}

function renderEngine(info: SettingsInfo) {
  $("engine-detected").textContent = info.detectedPath ? `Automatisch gefunden: ${info.detectedPath}` : "Nicht automatisch gefunden";
  ($("engine-path") as HTMLInputElement).value = info.stockfishPath ?? "";
  const threads = $("engine-threads") as HTMLSelectElement;
  const auto = Math.max(1, info.cpuCount - 1);
  threads.innerHTML =
    `<option value="">Automatisch (${auto})</option>` +
    Array.from({ length: info.cpuCount }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
  threads.value = info.threads ? String(info.threads) : "";
  $("threads-hint").textContent = `Dein Rechner hat ${info.cpuCount}. Hintergrund-Analysen nutzen die Hälfte.`;
  $("engine-msg").textContent = "";
}

async function applyEngine() {
  const msg = $("engine-msg");
  const path = ($("engine-path") as HTMLInputElement).value.trim();
  const threadsValue = ($("engine-threads") as HTMLSelectElement).value;
  msg.className = "msg muted";
  msg.textContent = "Prüfe …";
  try {
    const info = await invoke<SettingsInfo>("set_engine_settings", {
      path: path || null,
      threads: threadsValue ? Number(threadsValue) : null,
    });
    renderEngine(info);
    msg.className = "msg ok";
    msg.textContent = "Gespeichert ✓";
    deps.onEngineChanged();
  } catch (e) {
    msg.className = "msg error";
    msg.textContent = String(e);
  }
}

let confirmDelete = false;

/** First click asks, second click deletes. */
async function deletePuzzles() {
  const btn = $("puzzle-delete") as HTMLButtonElement;
  if (!confirmDelete) {
    confirmDelete = true;
    btn.textContent = `Wirklich löschen? (${puzzle ? mb(puzzle.sizeBytes) : ""} frei)`;
    window.setTimeout(() => {
      confirmDelete = false;
      renderPuzzle();
    }, 4000);
    return;
  }
  confirmDelete = false;
  btn.disabled = true;
  try {
    puzzle = await invoke<PuzzleStatus>("puzzle_delete");
    $("settings-dot").hidden = true;
    update = null;
    renderPuzzle();
    update = await invoke<UpdateCheck>("puzzle_check_update");
  } catch (e) {
    $("puzzle-status").innerHTML += `<br><span class="error">${esc(String(e))}</span>`;
  } finally {
    btn.disabled = false;
    renderPuzzle();
  }
}

function renderPuzzle() {
  const status = $("puzzle-status");
  const action = $("puzzle-action") as HTMLButtonElement;
  const del = $("puzzle-delete") as HTMLButtonElement;
  del.hidden = installing || !puzzle?.installed;
  if (!confirmDelete) del.textContent = "Löschen";
  if (installing) {
    action.hidden = true;
    return;
  }
  const p = puzzle;
  const u = update;
  if (!p || !p.installed) {
    status.innerHTML = `Nicht installiert${u?.offline ? ` <span class="muted">· offline</span>` : ""}`;
    action.hidden = !!u?.offline;
    action.textContent = u?.remoteSize ? `Herunterladen (${mb(u.remoteSize)})` : "Herunterladen";
    return;
  }
  const base = `${p.count.toLocaleString("de-DE")} Puzzles · Stand ${versionDate(p.version)} · ${mb(p.sizeBytes)}`;
  if (u?.available) {
    status.innerHTML = `${base}<br><span class="update">Neue Version vom ${versionDate(u.remoteVersion)} verfügbar</span>`;
    action.hidden = false;
    action.textContent = "Aktualisieren";
  } else {
    status.innerHTML = `${base}<br><span class="muted">${u?.offline ? "Offline – Update-Prüfung nicht möglich" : u ? "Aktuell ✓" : "Prüfe auf Updates …"}</span>`;
    action.hidden = true;
  }
}

async function installPuzzles() {
  installing = true;
  renderPuzzle();
  $("puzzle-progress").hidden = false;
  renderProgress({ phase: "download", done: 0, total: update?.remoteSize ?? 0, message: null });
  try {
    puzzle = await invoke<PuzzleStatus>("puzzle_install");
    update = { offline: false, remoteVersion: puzzle.version, remoteSize: null, available: false };
    $("settings-dot").hidden = true;
  } catch {
    /* shown via the progress event */
  } finally {
    installing = false;
    renderPuzzle();
  }
}

function renderProgress(p: PuzzleProgress) {
  const box = $("puzzle-progress");
  const fill = box.querySelector(".progress-fill") as HTMLElement;
  const text = $("puzzle-progress-text");
  const cancel = $("puzzle-cancel") as HTMLButtonElement;
  box.hidden = false;
  cancel.hidden = !["download", "import"].includes(p.phase);
  const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
  switch (p.phase) {
    case "download":
      fill.style.width = `${pct * 0.5}%`;
      text.textContent = `Lade herunter … ${mb(p.done)}${p.total ? ` von ${mb(p.total)}` : ""}`;
      break;
    case "import":
      fill.style.width = `${50 + pct * 0.45}%`;
      text.textContent = `Importiere Puzzles … ${Math.round(pct)} %`;
      break;
    case "index":
      fill.style.width = "96%";
      text.textContent = "Lege Suchindex an …";
      break;
    case "done":
      fill.style.width = "100%";
      text.textContent = `Fertig – ${p.done.toLocaleString("de-DE")} Puzzles installiert.`;
      break;
    case "cancelled":
      box.hidden = true;
      break;
    case "error":
      fill.style.width = "0";
      text.innerHTML = `<span class="error">${esc(p.message ?? "Fehler")}</span>`;
      break;
  }
}
