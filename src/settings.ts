// Settings dialog (gear icon): analysis depth, engine, display, puzzle database.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

import { lang, locale, setLang, t, type Lang } from "./i18n";
import { $, esc, miniPieces, store } from "./util";
import { diagnoseSounds, moveSound, soundOn, testSound, volume } from "./sound";

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

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000).toLocaleString(locale)} MB`;
const versionDate = (v: string | null) => {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" }) : t("unbekannt");
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

/** What happens after the quick preview analysis. */
export type RefinePref = "ask" | "always" | "never";

/** Analyse new games in the background after a sync (default on). */
export function autoAnalysePref(): boolean {
  return store.get("auto-analyse") !== "0";
}

export function refinePref(): RefinePref {
  const v = store.get("refine");
  return v === "always" || v === "never" ? v : "ask";
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

  const language = $("pref-lang") as HTMLSelectElement;
  language.value = lang;
  language.addEventListener("change", () => setLang(language.value as Lang));

  const depth = $("depth") as HTMLSelectElement;
  depth.value = store.get("depth") ?? "16";
  depth.addEventListener("change", () => store.set("depth", depth.value));

  const refine = $("pref-refine") as HTMLSelectElement;
  refine.value = refinePref();
  refine.addEventListener("change", () => store.set("refine", refine.value));

  const auto = $("pref-auto") as HTMLInputElement;
  auto.checked = autoAnalysePref();
  auto.addEventListener("change", () => store.set("auto-analyse", auto.checked ? "1" : "0"));

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
  $("sound-diag-btn").addEventListener("click", runSoundDiagnosis);
  $("lichess-token-steps").innerHTML = [
    t("Auf <b>„Schlüssel bei Lichess erstellen“</b> klicken (dafür bei Lichess angemeldet sein)."),
    t("<b>Keine Häkchen setzen!</b> Die Eröffnungsdatenbank braucht keine Rechte – ohne Häkchen kann der Schlüssel nichts an deinem Konto ändern."),
    t("Unten auf <b>„Erstellen“</b> klicken und den Schlüssel (beginnt mit <code>lip_</code>) sofort kopieren – Lichess zeigt ihn nur einmal."),
    t("Hier einfügen und <b>„Speichern“</b> klicken."),
  ]
    .map((s) => `<li>${s}</li>`)
    .join("");
  $("backup-create").addEventListener("click", createBackup);
  $("backup-restore").addEventListener("click", restoreBackup);
  $("lichess-token-create").addEventListener("click", () => invoke("open_lichess_token_page").catch((e) => alert(String(e))));
  $("lichess-token-save").addEventListener("click", () => saveToken(($("lichess-token") as HTMLInputElement).value));
  $("lichess-token-remove").addEventListener("click", () => saveToken(null));

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

const SOUND_LABEL = (): Record<string, string> => ({
  Move: t("Zug"),
  Capture: t("Schlagen"),
  Check: t("Schach"),
  Checkmate: t("Matt"),
  Setup: t("Aufstellen"),
  Error: t("Falsch"),
  Confirmation: t("Richtig"),
  Victory: t("Gewonnen"),
});

async function runSoundDiagnosis() {
  const out = $("sound-diag");
  out.innerHTML = `<span class="muted">${t("Prüfe …")}</span>`;
  const d = await diagnoseSounds();
  out.innerHTML =
    `<div class="muted">${t("Ausgabe:")} <b>${esc(d.output)}</b></div>` +
    d.files
      .map(
        (f) => `<div class="diag-row">
          <button data-sound="${f.name}" class="diag-play" title="${t("Abspielen")}">▶</button>
          <span class="diag-name">${SOUND_LABEL()[f.name] ?? f.name}</span>
          <span class="muted">${f.source === "file" ? t("eigene Datei") : t("eingebaut")}</span>
          ${f.ok ? `<span class="ok">✓ ${f.seconds} s${f.native ? "" : ` · ${t("nur Web Audio")}`}</span>` : ""}
          ${f.error ? `<span class="error">${esc(f.error)}</span>` : ""}
        </div>`,
      )
      .join("");
  out.querySelectorAll<HTMLElement>(".diag-play").forEach((b) => b.addEventListener("click", () => testSound(b.dataset.sound!)));
}

const BACKUP_FILTER = [{ name: "postmortem-Sicherung", extensions: ["sqlite", "db"] }];

async function createBackup() {
  const msg = $("backup-msg");
  const day = new Date().toISOString().slice(0, 10);
  const path = await saveDialog({ defaultPath: `postmortem-sicherung-${day}.sqlite`, filters: BACKUP_FILTER }).catch(() => null);
  if (!path) return;
  msg.textContent = t("Sichere …");
  try {
    const bytes = await invoke<number>("backup_create", { path });
    msg.textContent = t("Gesichert: {path} ({size})", { path, size: `${(bytes / 1e6).toFixed(1)} MB` });
  } catch (e) {
    msg.textContent = String(e);
  }
}

async function restoreBackup() {
  const msg = $("backup-msg");
  const path = await openDialog({ multiple: false, directory: false, filters: BACKUP_FILTER }).catch(() => null);
  if (!path || Array.isArray(path)) return;
  try {
    const games = await invoke<number>("backup_check", { path });
    const ok = confirm(
      t("Sicherung mit {n} Partien einspielen? Deine jetzigen Daten werden dadurch ersetzt (eine Kopie bleibt im Datenordner als „postmortem-vor-wiederherstellung.db“).", { n: games.toLocaleString(locale) }),
    );
    if (!ok) return;
    msg.textContent = t("Spiele ein …");
    await invoke("backup_restore", { path });
    // Everything on screen came from the old data: start fresh.
    location.reload();
  } catch (e) {
    msg.textContent = String(e);
  }
}

interface TokenStatus {
  set: boolean;
  user: string | null;
}

function renderToken(st: TokenStatus) {
  $("lichess-token-status").textContent = st.set
    ? t("verbunden als {user}", { user: st.user ?? "?" })
    : t("kein Schlüssel – „Erkunden“ zeigt nur deine Partien und die Theorie");
  ($("lichess-token-remove") as HTMLButtonElement).disabled = !st.set;
}

async function saveToken(token: string | null) {
  const msg = $("lichess-token-msg");
  msg.textContent = token ? t("Prüfe bei Lichess …") : "";
  try {
    renderToken(await invoke<TokenStatus>("lichess_token_set", { token }));
    ($("lichess-token") as HTMLInputElement).value = "";
    msg.textContent = token ? t("Gespeichert.") : t("Entfernt.");
  } catch (e) {
    msg.textContent = String(e);
  }
}

async function refresh() {
  invoke<TokenStatus>("lichess_token_status").then(renderToken).catch(() => {});
  const [info, st] = await Promise.all([invoke<SettingsInfo>("get_settings"), invoke<PuzzleStatus>("puzzle_status")]);
  renderEngine(info);
  puzzle = st;
  renderPuzzle();
  $("data-info").innerHTML =
    t("{g} Partien gespeichert, davon {r} analysiert.", { g: info.games.toLocaleString(locale), r: info.reviews.toLocaleString(locale) }) +
    `<br><span class="muted">${t("Speicherort: {dir}", { dir: esc(info.dataDir) })}</span>`;
  if (!installing) {
    update = await invoke<UpdateCheck>("puzzle_check_update");
    $("settings-dot").hidden = !(puzzle.installed && update.available);
    renderPuzzle();
  }
}

function renderEngine(info: SettingsInfo) {
  $("engine-detected").textContent = info.detectedPath
    ? t("Automatisch gefunden: {path}", { path: info.detectedPath })
    : t("Nicht automatisch gefunden");
  ($("engine-path") as HTMLInputElement).value = info.stockfishPath ?? "";
  const threads = $("engine-threads") as HTMLSelectElement;
  const auto = Math.max(1, info.cpuCount - 1);
  threads.innerHTML =
    `<option value="">${t("Automatisch ({n})", { n: auto })}</option>` +
    Array.from({ length: info.cpuCount }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
  threads.value = info.threads ? String(info.threads) : "";
  $("threads-hint").textContent = t("Dein Rechner hat {n}. Hintergrund-Analysen nutzen die Hälfte.", { n: info.cpuCount });
  $("engine-msg").textContent = "";
}

async function applyEngine() {
  const msg = $("engine-msg");
  const path = ($("engine-path") as HTMLInputElement).value.trim();
  const threadsValue = ($("engine-threads") as HTMLSelectElement).value;
  msg.className = "msg muted";
  msg.textContent = t("Prüfe …");
  try {
    const info = await invoke<SettingsInfo>("set_engine_settings", {
      path: path || null,
      threads: threadsValue ? Number(threadsValue) : null,
    });
    renderEngine(info);
    msg.className = "msg ok";
    msg.textContent = t("Gespeichert ✓");
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
    btn.textContent = t("Wirklich löschen? ({size} frei)", { size: puzzle ? mb(puzzle.sizeBytes) : "" });
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
  if (!confirmDelete) del.textContent = t("Löschen");
  if (installing) {
    action.hidden = true;
    return;
  }
  const p = puzzle;
  const u = update;
  if (!p || !p.installed) {
    status.innerHTML = `${t("Nicht installiert")}${u?.offline ? ` <span class="muted">· ${t("offline")}</span>` : ""}`;
    action.hidden = !!u?.offline;
    action.textContent = u?.remoteSize ? t("Herunterladen ({size})", { size: mb(u.remoteSize) }) : t("Herunterladen");
    return;
  }
  const base = t("{n} Puzzles · Stand {date} · {size}", { n: p.count.toLocaleString(locale), date: versionDate(p.version), size: mb(p.sizeBytes) });
  if (u?.available) {
    status.innerHTML = `${base}<br><span class="update">${t("Neue Version vom {date} verfügbar", { date: versionDate(u.remoteVersion) })}</span>`;
    action.hidden = false;
    action.textContent = t("Aktualisieren");
  } else {
    status.innerHTML = `${base}<br><span class="muted">${u?.offline ? t("Offline – Update-Prüfung nicht möglich") : u ? t("Aktuell ✓") : t("Prüfe auf Updates …")}</span>`;
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
      text.textContent = p.total
        ? t("Lade herunter … {done} von {total}", { done: mb(p.done), total: mb(p.total) })
        : t("Lade herunter … {done}", { done: mb(p.done) });
      break;
    case "import":
      fill.style.width = `${50 + pct * 0.45}%`;
      text.textContent = t("Importiere Puzzles … {p} %", { p: Math.round(pct) });
      break;
    case "index":
      fill.style.width = "96%";
      text.textContent = t("Lege Suchindex an …");
      break;
    case "done":
      fill.style.width = "100%";
      text.textContent = t("Fertig – {n} Puzzles installiert.", { n: p.done.toLocaleString(locale) });
      break;
    case "cancelled":
      box.hidden = true;
      break;
    case "error":
      fill.style.width = "0";
      text.innerHTML = `<span class="error">${esc(p.message ?? t("Unbekannter Fehler"))}</span>`;
      break;
  }
}
