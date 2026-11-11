#[macro_use]
mod i18n;
mod analysis;
mod audio;
mod backup;
mod bot;
mod cards;
mod chesscom;
mod coach;
mod db;
mod engine;
mod explorer;
mod explore;
mod lichess;
mod live;
mod opening_texts;
mod openings;
mod pgn;
mod puzzles;
mod recommend;
mod relevance;
mod repertoire;
mod stats;
mod theory;
mod trainer;
mod tree;
mod update;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use analysis::GameReview;
use db::Account;
use lichess::{FetchError, GameInfo, GameQuery, Source};

/// Cancellation flag of the analysis currently running (if any).
#[derive(Default)]
struct AnalysisState {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

struct DbState(Mutex<db::Db>);

/// The app's data directory (databases live here).
struct DataDir(std::path::PathBuf);

/// Cancellation flag of a running puzzle-database download/import.
#[derive(Default)]
struct PuzzleInstall {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

/// Cancellation flag of the running "analyse all" batch (if any).
#[derive(Default)]
struct BatchState {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BatchProgress {
    done: usize,
    total: usize,
    /// Game being analysed right now.
    current: Option<String>,
    finished: bool,
}


#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    game_id: String,
    /// Depth being analysed (preview vs. refinement).
    depth: u32,
    done: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatus {
    found: bool,
    path: Option<String>,
}

/// Language of backend messages and coach comments ("de" or "en").
#[tauri::command]
fn set_language(lang: String) {
    i18n::set(&lang);
}

#[tauri::command]
fn engine_status() -> EngineStatus {
    let path = engine::find_stockfish();
    EngineStatus { found: path.is_some(), path: path.map(|p| p.display().to_string()) }
}

/// Games stored locally for the given accounts (works offline), newest first.
#[tauri::command]
fn list_games(db: State<DbState>, accounts: Vec<Account>, limit: Option<u32>) -> Result<Vec<db::StoredGame>, String> {
    db.0.lock().unwrap().games_of(&accounts, limit.unwrap_or(500))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResult {
    /// Games that were not stored before.
    added: usize,
    offline: bool,
}

/// Pull games from Lichess into the local store. By default only games newer
/// than the newest stored one; with `older`, the next batch before the oldest.
#[tauri::command]
async fn sync_games(db: State<'_, DbState>, account: Account, older: Option<bool>) -> Result<SyncResult, String> {
    let account = Account::new(account.source, &account.username);
    let range = db.0.lock().unwrap().time_range(&account)?;
    let query = match (range, older.unwrap_or(false)) {
        (Some((_, oldest)), true) => GameQuery { max: Some(50), until: Some(oldest - 1), ..Default::default() },
        (Some((newest, _)), false) => GameQuery { max: Some(500), since: Some(newest + 1), ..Default::default() },
        // First sync: a reasonable recent batch.
        (None, _) => GameQuery { max: Some(100), ..Default::default() },
    };
    let fetched = match account.source {
        Source::Lichess => lichess::fetch_user_games(&account.username, query).await,
        Source::Chesscom => chesscom::fetch_user_games(&account.username, query).await,
        // Bot games only exist locally: nothing to sync.
        Source::Local => return Ok(SyncResult { added: 0, offline: false }),
    };
    match fetched {
        Ok(games) => {
            let added = db.0.lock().unwrap().save_games(&games)?;
            Ok(SyncResult { added, offline: false })
        }
        Err(FetchError::Offline) => Ok(SyncResult { added: 0, offline: true }),
        Err(FetchError::Other(e)) => Err(e),
    }
}

/// A single game by link; stored locally so it stays available offline.
#[tauri::command]
async fn fetch_game(db: State<'_, DbState>, url: String) -> Result<GameInfo, String> {
    if url.contains("chess.com") {
        return Err("Einzelne chess.com-Links gehen leider nicht – die API bietet das nicht an. \
                    Lade deine Partien über deinen chess.com-Namen."
            .into());
    }
    let game = lichess::fetch_game(&url).await.map_err(|e| e.to_string())?;
    db.0.lock().unwrap().save_games(std::slice::from_ref(&game))?;
    Ok(game)
}

/// A stored review of at least `depth`, without analysing anything.
#[tauri::command]
fn stored_review(db: State<DbState>, game_id: String, depth: u32) -> Result<Option<GameReview>, String> {
    db.0.lock().unwrap().review(&game_id, depth)
}

#[tauri::command]
fn cancel_analysis(state: State<AnalysisState>) {
    if let Some(flag) = state.cancel.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn analyse_game(
    app: AppHandle,
    state: State<'_, AnalysisState>,
    db: State<'_, DbState>,
    game: GameInfo,
    depth: Option<u32>,
    force: Option<bool>,
) -> Result<GameReview, String> {
    let depth = depth.unwrap_or(16).clamp(8, 30);
    // `force`: analyse again even if a review exists (e.g. for English coach comments).
    let cached = if force.unwrap_or(false) { None } else { db.0.lock().unwrap().review(&game.id, depth)? };
    if let Some(review) = cached {
        return Ok(review);
    }

    // Cancel whatever was running and register our own flag.
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = state.cancel.lock().unwrap().replace(cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }

    let app2 = app.clone();
    let game2 = game.clone();
    let review = tauri::async_runtime::spawn_blocking(move || run_analysis(&app2, &game2, depth, &cancel, engine::threads(false)))
        .await
        .map_err(|e| e.to_string())??;

    let mut db = db.0.lock().unwrap();
    db.save_games(std::slice::from_ref(&game))?;
    db.save_review(&review)?;
    Ok(review)
}

fn run_analysis(
    app: &AppHandle,
    game: &GameInfo,
    depth: u32,
    cancel: &AtomicBool,
    threads: usize,
) -> Result<GameReview, String> {
    if lichess::is_running(&game.status) {
        return Err(i18n::still_running());
    }
    let path = engine::find_stockfish()
        .ok_or_else(i18n::no_stockfish)?;
    let (positions, moves) = analysis::replay(&game.moves)?;

    // Pass 1: best line only. Pass 2: second-best line where the classification needs it.
    let mut sf = engine::Engine::start(&path, threads, 256, 1)?;
    let n = positions.len();
    let progress = |done: usize, total: usize| {
        let _ = app.emit("analysis-progress", Progress { game_id: game.id.clone(), depth, done, total });
    };
    // Until pass 1 is done we only know roughly how much pass 2 will add.
    let estimate = n + n / 2;
    let mut lines = Vec::with_capacity(n);
    for (i, pos) in positions.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let l = match analysis::terminal_eval(pos) {
            Some(l) => l,
            None => sf.analyse(&analysis::fen(pos), depth)?,
        };
        lines.push(l);
        progress(i + 1, estimate);
    }

    let second = analysis::needs_second_line(&positions, &moves, &lines);
    let total = n + second.len();
    if !second.is_empty() {
        sf.set_multipv(2)?;
    }
    for (k, &i) in second.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        lines[i] = sf.analyse(&analysis::fen(&positions[i]), depth)?;
        progress(n + k + 1, total);
    }
    Ok(analysis::build_review(game, depth, &positions, &moves, &lines))
}

/// Weakness statistics; `last` limits them to the most recent analysed games.
#[tauri::command]
fn weakness_stats(db: State<DbState>, accounts: Vec<Account>, last: Option<usize>) -> Result<stats::WeaknessStats, String> {
    let db = db.0.lock().unwrap();
    let games = db.reviewed_games_of(&accounts)?;
    Ok(stats::compute_window(&accounts, db.count_games_of(&accounts)?, &games, last))
}

/// Analyse up to `limit` stored games of a player that have no review yet,
/// newest first, in the background. Returns how many were analysed.
#[tauri::command]
async fn analyse_all(
    app: AppHandle,
    db: State<'_, DbState>,
    batch: State<'_, BatchState>,
    accounts: Vec<Account>,
    depth: Option<u32>,
    limit: Option<u32>,
) -> Result<usize, String> {
    let depth = depth.unwrap_or(14).clamp(8, 30);
    let games = db.0.lock().unwrap().unreviewed_games_of(&accounts, limit.unwrap_or(50))?;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = batch.cancel.lock().unwrap().replace(cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let total = games.len();
        let progress = |done, current: Option<&GameInfo>, finished| {
            let current = current.map(|g| g.id.clone());
            let _ = app.emit("batch-progress", BatchProgress { done, total, current, finished });
        };
        let mut done = 0;
        for game in &games {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            progress(done, Some(game), false);
            // Half the cores, so reviewing a game in parallel stays responsive.
            match run_analysis(&app, game, depth, &cancel, engine::threads(true)) {
                Ok(review) => {
                    app.state::<DbState>().0.lock().unwrap().save_review(&review)?;
                    done += 1;
                }
                Err(e) if e == "cancelled" => break,
                // A single broken game shouldn't stop the batch; missing Stockfish should.
                Err(e) if e.contains("Stockfish") => {
                    progress(done, None, true);
                    return Err(e);
                }
                Err(_) => {}
            }
        }
        progress(done, None, true);
        Ok(done)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_batch(batch: State<BatchState>) {
    if let Some(flag) = batch.cancel.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsInfo {
    /// Path chosen in the settings (None = automatic).
    stockfish_path: Option<String>,
    /// Path found automatically.
    detected_path: Option<String>,
    /// Threads chosen in the settings (None = automatic).
    threads: Option<usize>,
    cpu_count: usize,
    data_dir: String,
    games: u64,
    reviews: u64,
}

fn settings_info(db: &db::Db, dir: &DataDir) -> Result<SettingsInfo, String> {
    let config = engine::config();
    let (games, reviews) = db.counts()?;
    Ok(SettingsInfo {
        stockfish_path: config.path.map(|p| p.display().to_string()),
        detected_path: engine::detect_stockfish().map(|p| p.display().to_string()),
        threads: config.threads,
        cpu_count: engine::cpu_count(),
        data_dir: dir.0.display().to_string(),
        games,
        reviews,
    })
}

#[tauri::command]
fn get_settings(db: State<DbState>, dir: State<DataDir>) -> Result<SettingsInfo, String> {
    settings_info(&db.0.lock().unwrap(), &dir)
}

/// Engine settings from the dialog; a custom path is checked with a UCI handshake first.
#[tauri::command]
async fn set_engine_settings(
    app: AppHandle,
    path: Option<String>,
    threads: Option<usize>,
) -> Result<SettingsInfo, String> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).map(std::path::PathBuf::from);
    if let Some(p) = path.clone() {
        if !p.is_file() {
            return Err({ let p = p.display(); tr!("Datei nicht gefunden: {p}", "File not found: {p}") });
        }
        tauri::async_runtime::spawn_blocking(move || engine::verify(&p))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| tr!("Das scheint keine UCI-Engine zu sein: {e}", "This does not seem to be a UCI engine: {e}"))?;
    }
    let threads = threads.map(|t| t.clamp(1, engine::cpu_count()));
    let db = app.state::<DbState>();
    let db = db.0.lock().unwrap();
    db.set_setting("stockfish_path", path.as_ref().map(|p| p.display().to_string()).as_deref())?;
    db.set_setting("threads", threads.map(|t| t.to_string()).as_deref())?;
    engine::configure(engine::EngineConfig { path, threads });
    app.state::<live::Live>().reset();
    app.state::<bot::Bot>().reset();
    settings_info(&db, &app.state::<DataDir>())
}

#[tauri::command]
fn puzzle_status(dir: State<DataDir>) -> puzzles::PuzzleStatus {
    puzzles::status(&dir.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    games: Vec<GameInfo>,
    /// Games that were already stored.
    known: usize,
    /// One line per game that could not be read.
    errors: Vec<String>,
}

/// Store games from pasted PGN (one or many). `you` = "white" / "black" / None.
#[tauri::command]
fn import_pgn(db: State<DbState>, pgn: String, you: Option<String>) -> Result<ImportResult, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut games = Vec::new();
    let mut errors = Vec::new();
    for (i, text) in pgn::split_games(&pgn).iter().enumerate() {
        let parsed = pgn::parse(text);
        match pgn::to_game(&parsed, you.as_deref(), now) {
            Ok(g) => games.push(g),
            Err(e) => {
                let who = match (parsed.header("White"), parsed.header("Black")) {
                    (Some(w), Some(b)) => format!("{w} – {b}"),
                    _ => { let n = i + 1; tr!("Partie {n}", "Game {n}") }
                };
                errors.push(format!("{who}: {e}"));
            }
        }
    }
    if games.is_empty() && errors.is_empty() {
        return Err(tr!("Keine Partie gefunden. Bitte PGN einfügen (Züge wie „1. e4 e5 2. Nf3 …“).", "No game found. Please paste a PGN (moves like “1. e4 e5 2. Nf3 …”)."));
    }
    let added = db.0.lock().unwrap().save_games(&games)?;
    Ok(ImportResult { known: games.len() - added, games, errors })
}

/// A game as PGN text.
#[tauri::command]
fn export_pgn(game: GameInfo) -> String {
    pgn::export(&game)
}

/// Is a newer postmortem release published on GitHub?
#[tauri::command]
async fn app_update() -> update::AppUpdate {
    update::check().await
}

#[tauri::command]
fn open_releases_page() -> Result<(), String> {
    update::open_releases_page()
}

#[tauri::command]
async fn puzzle_check_update(dir: State<'_, DataDir>) -> Result<puzzles::UpdateCheck, String> {
    Ok(puzzles::check_update(&dir.0).await)
}

/// Download and import the Lichess puzzle database (progress via `puzzle-progress` events).
#[tauri::command]
async fn puzzle_install(
    app: AppHandle,
    dir: State<'_, DataDir>,
    install: State<'_, PuzzleInstall>,
) -> Result<puzzles::PuzzleStatus, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = install.cancel.lock().unwrap();
        if running.is_some() {
            return Err(tr!("Der Download läuft bereits.", "The download is already running."));
        }
        *running = Some(cancel.clone());
    }
    let result = puzzles::install(app.clone(), dir.0.clone(), cancel).await;
    *install.cancel.lock().unwrap() = None;
    result
}

/// Delete the local puzzle database (not while it is being downloaded).
#[tauri::command]
fn puzzle_delete(dir: State<DataDir>, install: State<PuzzleInstall>) -> Result<puzzles::PuzzleStatus, String> {
    if install.cancel.lock().unwrap().is_some() {
        return Err(tr!("Erst den laufenden Download abbrechen.", "Cancel the running download first."));
    }
    puzzles::delete(&dir.0)?;
    Ok(puzzles::status(&dir.0))
}

#[tauri::command]
fn puzzle_cancel(install: State<PuzzleInstall>) {
    if let Some(flag) = install.cancel.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Run a closure with the database on a worker thread (keeps the UI responsive).
async fn with_db<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&db::Db, &std::path::Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<DbState>();
        let dir = app.state::<DataDir>();
        let db = db.0.lock().unwrap();
        f(&db, &dir.0)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Analysed games of the accounts, limited to the most recent `last`.
fn window(db: &db::Db, accounts: &[Account], last: Option<usize>) -> Result<Vec<(GameInfo, GameReview)>, String> {
    let mut games = db.reviewed_games_of(accounts)?;
    if let Some(n) = last {
        games.truncate(n);
    }
    Ok(games)
}

/// Your openings by colour: results, accuracy, mistakes in the opening.
#[tauri::command]
async fn opening_report(app: AppHandle, accounts: Vec<Account>, last: Option<usize>) -> Result<Vec<repertoire::OpeningStat>, String> {
    with_db(app, move |db, _| Ok(repertoire::report(&window(db, &accounts, last)?, &accounts))).await
}

/// Where you leave opening theory, and what it costs you.
#[tauri::command]
async fn theory_report(app: AppHandle, accounts: Vec<Account>, last: Option<usize>) -> Result<theory::TheoryReport, String> {
    with_db(app, move |db, _| {
        let mut games: Vec<GameInfo> = db.games_of(&accounts, u32::MAX)?.into_iter().map(|g| g.game).collect();
        if let Some(n) = last {
            games.truncate(n);
        }
        let reviews: std::collections::HashMap<String, GameReview> =
            db.reviewed_games_of(&accounts)?.into_iter().map(|(g, r)| (g.id, r)).collect();
        Ok(theory::report(&games, &reviews, &accounts))
    })
    .await
}

/// One small record per stored game (rating, result, speed) for the rating history.
#[tauri::command]
async fn game_summaries(app: AppHandle, accounts: Vec<Account>) -> Result<Vec<stats::GameSummary>, String> {
    with_db(app, move |db, _| Ok(stats::summaries(&db.games_of(&accounts, u32::MAX)?, &accounts))).await
}

/// All opening families with base line and thumbnail position (computed once).
#[tauri::command]
fn opening_families() -> Vec<repertoire::Family> {
    static FAMILIES: std::sync::OnceLock<Vec<repertoire::Family>> = std::sync::OnceLock::new();
    FAMILIES.get_or_init(repertoire::families).clone()
}

#[tauri::command]
fn repertoire_get(db: State<DbState>) -> repertoire::Repertoire {
    repertoire::load(&db.0.lock().unwrap())
}

#[tauri::command]
fn repertoire_set(db: State<DbState>, repertoire: repertoire::Repertoire) -> Result<repertoire::Status, String> {
    let db = db.0.lock().unwrap();
    repertoire::save(&db, &repertoire)?;
    repertoire::status(&db)
}

#[tauri::command]
fn opening_status(db: State<DbState>) -> Result<repertoire::Status, String> {
    repertoire::status(&db.0.lock().unwrap())
}

#[tauri::command]
async fn opening_next(
    app: AppHandle,
    accounts: Vec<Account>,
    last: Option<usize>,
    mode: Option<repertoire::Mode>,
    focus: Option<repertoire::Focus>,
) -> Result<Option<repertoire::Drill>, String> {
    let mode = mode.unwrap_or_default();
    with_db(app, move |db, _| repertoire::next(db, &accounts, &window(db, &accounts, last)?, mode, focus.as_ref())).await
}

/// Put a position into the flashcard box (Stockfish finds the best moves; takes a few seconds).
#[tauri::command]
async fn card_create(
    app: AppHandle,
    fen: String,
    played: Option<String>,
    source: String,
    game_id: Option<String>,
    ply: Option<usize>,
) -> Result<cards::Card, String> {
    let card = tauri::async_runtime::spawn_blocking(move || cards::build(&fen, played.as_deref(), &source, game_id, ply))
        .await
        .map_err(|e| e.to_string())??;
    with_db(app, move |db, _| {
        db.save_card(&card)?;
        Ok(card)
    })
    .await
}

#[tauri::command]
fn cards_list(db: State<DbState>) -> Result<Vec<cards::CardInfo>, String> {
    cards::list(&db.0.lock().unwrap())
}

#[tauri::command]
fn card_delete(db: State<DbState>, id: String) -> Result<(), String> {
    db.0.lock().unwrap().delete_card(&id)
}

/// Ids of the favourite games.
#[tauri::command]
fn favorites(db: State<DbState>) -> Result<Vec<String>, String> {
    db.0.lock().unwrap().favorites()
}

/// Mark or unmark a game as favourite.
#[tauri::command]
fn favorite_set(db: State<DbState>, game_id: String, on: bool) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    db.0.lock().unwrap().set_favorite(&game_id, on, now)
}

/// Your mistakes, misses and blunders per analysed game (for the game list filter).
#[tauri::command]
async fn game_errors(app: AppHandle, accounts: Vec<Account>) -> Result<std::collections::HashMap<String, u32>, String> {
    with_db(app, move |db, _| {
        let games = window(db, &accounts, None)?;
        Ok(games
            .iter()
            .filter_map(|(game, review)| {
                let me = repertoire::my_color(game, &accounts)?;
                let n = review
                    .moves
                    .iter()
                    .filter(|m| m.color == me && matches!(m.classification, analysis::Class::Mistake | analysis::Class::Miss | analysis::Class::Blunder))
                    .count();
                Some((game.id.clone(), n as u32))
            })
            .collect())
    })
    .await
}

/// Write a backup of the local database to `path`; returns its size in bytes.
#[tauri::command]
async fn backup_create(app: AppHandle, path: String) -> Result<u64, String> {
    with_db(app, move |db, _| backup::create(db, std::path::Path::new(&path))).await
}

/// Check a backup before restoring it; returns the number of games in it.
#[tauri::command]
async fn backup_check(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || backup::check(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// Replace the local database with a backup (the frontend reloads afterwards).
#[tauri::command]
async fn backup_restore(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.state::<DataDir>().0.clone();
        let state = app.state::<DbState>();
        let mut db = state.0.lock().unwrap();
        backup::restore(&mut db, &dir, std::path::Path::new(&path))?;
        // Engine settings come with the backup.
        engine::configure(engine::EngineConfig {
            path: db.setting("stockfish_path")?.map(std::path::PathBuf::from),
            threads: db.setting("threads")?.and_then(|t| t.parse().ok()),
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Index your games for "Frei spielen" (returns the number of games).
#[tauri::command]
async fn explorer_prepare(app: AppHandle, accounts: Vec<Account>) -> Result<usize, String> {
    let handle = app.clone();
    with_db(app, move |db, _| handle.state::<explorer::Explorer>().prepare(db, &accounts)).await
}

/// Candidate moves from your games and the theory.
#[tauri::command]
fn explorer_moves(explorer: State<explorer::Explorer>, fen: String) -> Result<explorer::Moves, String> {
    explorer.moves(&fen)
}

/// How often the moves are played on Lichess at your level (None without a token).
#[tauri::command]
async fn explorer_lichess(app: AppHandle, fen: String, accounts: Vec<Account>) -> Result<Option<explorer::LichessData>, String> {
    let (token, rating) = with_db(app.clone(), move |db, _| Ok((explorer::token(db), explorer::my_rating(db, &accounts)))).await?;
    app.state::<explorer::Explorer>().lichess(&fen, token, rating).await
}

/// Open Lichess' page for creating a personal token (with a description filled in).
#[tauri::command]
fn open_lichess_token_page() -> Result<(), String> {
    update::open_in_browser("https://lichess.org/account/oauth/token/create?description=postmortem")
}

#[tauri::command]
fn lichess_token_status(db: State<DbState>) -> explorer::TokenStatus {
    explorer::token_status(&db.0.lock().unwrap())
}

/// Store (after checking it with Lichess) or remove the personal Lichess token.
#[tauri::command]
async fn lichess_token_set(app: AppHandle, token: Option<String>) -> Result<explorer::TokenStatus, String> {
    let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let user = match &token {
        Some(t) => Some(explorer::check_token(t).await?),
        None => None,
    };
    with_db(app, move |db, _| {
        explorer::store_token(db, token.as_deref().zip(user.as_deref()))?;
        Ok(explorer::token_status(db))
    })
    .await
}

/// Start an opening over (all its lines new again, for one colour).
#[tauri::command]
fn opening_reset(db: State<DbState>, color: String, family: String) -> Result<repertoire::Status, String> {
    repertoire::reset(&db.0.lock().unwrap(), &color, &family)
}

/// Opening mistakes from your own games that are due for practice.
#[tauri::command]
async fn opening_own_count(app: AppHandle, accounts: Vec<Account>, last: Option<usize>) -> Result<usize, String> {
    with_db(app, move |db, _| repertoire::own_due_count(db, &accounts, &window(db, &accounts, last)?)).await
}

/// The opening line behind a moment of one of your games (to learn the whole
/// opening, not just the position).
#[tauri::command]
fn opening_line_for_game(db: State<DbState>, game_id: String, ply: usize, color: String) -> Result<Option<repertoire::Focus>, String> {
    let db = db.0.lock().unwrap();
    let Some(game) = db.game(&game_id)? else { return Ok(None) };
    Ok(repertoire::line_for_game(&db, &game, ply, &color))
}

/// Where a repertoire tree starts: an opening's defining moves, or the start.
fn tree_root(color: &str, family: Option<&str>) -> Vec<String> {
    family.map(|f| tree::root_of(color, f)).unwrap_or_default()
}

/// Your repertoire as a tree (whole, or from an opening), with the numbers at hand.
#[tauri::command]
async fn rep_tree(app: AppHandle, accounts: Vec<Account>, color: String, family: Option<String>) -> Result<tree::TreeView, String> {
    with_db(app, move |db, _| tree::view(db, &accounts, &color, tree_root(&color, family.as_deref()))).await
}

/// The same after fetching missing numbers from Lichess (takes a while the first time).
#[tauri::command]
async fn rep_tree_prepare(app: AppHandle, accounts: Vec<Account>, color: String, family: Option<String>) -> Result<tree::TreeView, String> {
    let root = tree_root(&color, family.as_deref());
    tree::prepare(app, accounts, color, root).await
}

/// Your openings in a few numbers (coverage, gaps, cards, due), keyed "color|family".
#[tauri::command]
async fn rep_summaries(app: AppHandle, accounts: Vec<Account>, keys: Vec<(String, String)>) -> Result<std::collections::HashMap<String, tree::Summary>, String> {
    with_db(app, move |db, _| tree::summaries(db, &accounts, &keys)).await
}

/// Your move in a position of the tree (fills a gap; a new card).
#[tauri::command]
fn rep_set_move(db: State<DbState>, color: String, path: Vec<String>, uci: String) -> Result<tree::RepMove, String> {
    tree::set_move(&db.0.lock().unwrap(), &color, &path, &uci)
}

/// Play another move in a position of your repertoire (`dry`: only count
/// the moves that would go with the old one).
#[tauri::command]
fn rep_change_move(db: State<DbState>, color: String, path: Vec<String>, uci: String, dry: bool) -> Result<usize, String> {
    tree::change_move(&db.0.lock().unwrap(), &color, &path, &uci, dry)
}

/// Let Stockfish check your moves (whole repertoire or one opening) it hasn't seen yet.
#[tauri::command]
async fn rep_check_quality(app: AppHandle, accounts: Vec<Account>, color: String, family: Option<String>) -> Result<tree::TreeView, String> {
    let root = tree_root(&color, family.as_deref());
    tree::check_quality(app, accounts, color, root).await
}

/// Your short idea behind a repertoire move.
#[tauri::command]
fn rep_set_note(db: State<DbState>, color: String, epd: String, note: String) -> Result<(), String> {
    let note: String = note.trim().chars().take(300).collect();
    db.0.lock().unwrap().set_rep_note(&color, &epd, &note).map(|_| ())
}

/// Your ideas behind your moves of one colour, by position (for the flashcards).
#[tauri::command]
fn rep_notes(db: State<DbState>, color: String) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(db.0.lock().unwrap().rep_moves(&color)?.into_values().filter(|m| !m.note.is_empty()).map(|m| (m.epd, m.note)).collect())
}

/// Up to which move gaps and coverage count (0 = no limit).
#[tauri::command]
fn rep_set_depth(db: State<DbState>, depth: usize) -> Result<(), String> {
    tree::set_depth(&db.0.lock().unwrap(), depth)
}

/// The moves of a line played in "Erkunden" into your repertoire.
#[tauri::command]
fn rep_add_line(db: State<DbState>, color: String, moves: Vec<String>) -> Result<tree::Added, String> {
    tree::add_manual(&db.0.lock().unwrap(), &color, &moves)
}

/// Remove your move in a position and what only follows from it (`dry`: only count).
#[tauri::command]
fn rep_delete_move(db: State<DbState>, color: String, path: Vec<String>, dry: bool) -> Result<usize, String> {
    tree::delete_move(&db.0.lock().unwrap(), &color, &path, dry)
}

/// Remove the moves of one opening from your repertoire (`dry`: only count).
#[tauri::command]
fn rep_delete_family(db: State<DbState>, color: String, family: String, dry: bool) -> Result<usize, String> {
    tree::delete_family(&db.0.lock().unwrap(), &color, &family, dry)
}

/// Compare new games with your repertoire; where you played something else,
/// that card is due again. Returns those moments.
#[tauri::command]
async fn rep_check_games(app: AppHandle, accounts: Vec<Account>) -> Result<Vec<tree::Deviation>, String> {
    with_db(app, move |db, _| tree::check_new_games(db, &accounts)).await
}

/// Where your games left your repertoire, newest first.
#[tauri::command]
async fn rep_deviations(app: AppHandle, accounts: Vec<Account>, limit: usize) -> Result<Vec<tree::GameReport>, String> {
    with_db(app, move |db, _| tree::deviations(db, &accounts, limit)).await
}

/// What your games say about your openings ("Für dich", "Deine Eröffnungen").
#[tauri::command]
async fn opening_recommendations(app: AppHandle, accounts: Vec<Account>) -> Result<Vec<recommend::Insight>, String> {
    with_db(app, move |db, _| recommend::insights(db, &accounts, &window(db, &accounts, None)?)).await
}

/// How often the lines of an opening come up at your level (Lichess explorer,
/// your games): fetches what's missing, then the course knows its main lines.
#[tauri::command]
async fn opening_relevance_prepare(app: AppHandle, accounts: Vec<Account>, color: String, family: String) -> Result<relevance::Prepared, String> {
    relevance::prepare(app, accounts, color, family).await
}

/// Variations of an opening for one colour, with learning progress.
#[tauri::command]
fn opening_family_detail(db: State<DbState>, color: String, family: String) -> Result<repertoire::FamilyDetail, String> {
    repertoire::family_detail(&db.0.lock().unwrap(), &color, &family)
}

/// Learning progress per opening ("white|Caro-Kann Defense" -> lines, learned, due).
#[tauri::command]
fn opening_progress(db: State<DbState>) -> Result<std::collections::HashMap<String, repertoire::FamilyProgress>, String> {
    repertoire::family_progress(&db.0.lock().unwrap())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DrillResult {
    box_level: u8,
    due: i64,
    status: repertoire::Status,
}

#[tauri::command]
fn opening_record(db: State<DbState>, id: String, color: String, success: bool) -> Result<DrillResult, String> {
    let db = db.0.lock().unwrap();
    let p = repertoire::record(&db, &id, &color, success)?;
    Ok(DrillResult { box_level: p.box_, due: p.due, status: repertoire::status(&db)? })
}

/// Next training puzzle based on the accounts' last `last` analysed games.
#[tauri::command]
async fn puzzle_next(app: AppHandle, accounts: Vec<Account>, last: Option<usize>) -> Result<Option<trainer::Puzzle>, String> {
    with_db(app, move |db, dir| trainer::next(db, dir, &accounts, last)).await
}

#[tauri::command]
async fn puzzle_record(
    app: AppHandle,
    accounts: Vec<Account>,
    attempt: trainer::AttemptInput,
) -> Result<trainer::RatingChange, String> {
    with_db(app, move |db, _| trainer::record(db, &accounts, &attempt)).await
}

#[tauri::command]
async fn puzzle_profile(app: AppHandle, accounts: Vec<Account>) -> Result<trainer::Profile, String> {
    with_db(app, move |db, _| trainer::profile(db, &accounts)).await
}

/// Wikibooks explanation of an opening position, if there is one.
#[tauri::command]
fn opening_text(fen: String) -> Option<opening_texts::OpeningText> {
    opening_texts::lookup(&fen)
}

/// Open the Wikibooks page an opening text comes from (nothing else).
#[tauri::command]
fn open_opening_source(url: String) -> Result<(), String> {
    if !url.starts_with(opening_texts::WIKI) {
        return Err("unexpected URL".into());
    }
    update::open_in_browser(&url)
}

#[tauri::command]
fn position_info(fen: String) -> Result<explore::PositionInfo, String> {
    explore::position_info(&fen)
}

#[tauri::command]
fn play_move(fen: String, from: String, to: String, promotion: Option<String>) -> Result<explore::PlayedMove, String> {
    explore::play_move(&fen, &from, &to, promotion.as_deref())
}

#[tauri::command]
async fn evaluate_move(fen: String, uci: String, depth: Option<u32>) -> Result<analysis::MoveReview, String> {
    let depth = depth.unwrap_or(14).clamp(8, 24);
    tauri::async_runtime::spawn_blocking(move || explore::evaluate_move(&fen, &uci, depth))
        .await
        .map_err(|e| e.to_string())?
}

/// The engine's continuation after a move (to show on the board why it fails).
#[tauri::command]
async fn refutation(fen: String, uci: String, depth: Option<u32>) -> Result<explore::Refutation, String> {
    let depth = depth.unwrap_or(16).clamp(8, 24);
    tauri::async_runtime::spawn_blocking(move || explore::refutation(&fen, &uci, depth))
        .await
        .map_err(|e| e.to_string())?
}

/// The engine's best line from a position (for "Engine zieht").
#[tauri::command]
async fn engine_line(fen: String, depth: Option<u32>, plies: Option<usize>) -> Result<explore::Refutation, String> {
    let depth = depth.unwrap_or(16).clamp(8, 24);
    let plies = plies.unwrap_or(1).clamp(1, 12);
    tauri::async_runtime::spawn_blocking(move || explore::engine_line(&fen, depth, plies))
        .await
        .map_err(|e| e.to_string())?
}

/// Is native sound output available? (Otherwise the frontend uses Web Audio.)
#[tauri::command]
fn sound_available(audio: State<audio::Audio>) -> bool {
    audio.available()
}

/// Register a sound (WAV bytes) under a name.
#[tauri::command]
fn sound_register(audio: State<audio::Audio>, name: String, data: Vec<u8>) -> Result<(), String> {
    audio.register(&name, data)
}

#[tauri::command]
fn sound_play(audio: State<audio::Audio>, name: String, volume: f32) -> Result<(), String> {
    audio.play(&name, volume)
}

#[tauri::command]
fn bot_levels() -> Vec<bot::Level> {
    bot::levels()
}

/// The bot's reply in a position (blocking the engine is fine: off the main thread).
#[tauri::command]
async fn bot_move(app: AppHandle, fen: String, level: u8) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<bot::Bot>().play(&fen, level.clamp(1, 8)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn game_status(fens: Vec<String>) -> Result<explore::GameStatus, String> {
    explore::game_status(&fens)
}

/// Name you appear under in games against the computer.
use pgn::LOCAL_PLAYER;

/// Store a finished game against the bot so it can be reviewed like any other.
#[tauri::command]
fn save_bot_game(
    db: State<DbState>,
    moves: Vec<String>,
    you: String,
    level: u8,
    winner: Option<String>,
    status: String,
    time_control: Option<String>,
) -> Result<GameInfo, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let me = lichess::Player { name: LOCAL_PLAYER.into(), rating: None };
    // By strength, not level number (the levels were renumbered in 0.2.9).
    let elo = bot::level_elo(level);
    let bot = lichess::Player { name: format!("Stockfish ~{elo}"), rating: Some(elo) };
    let (white, black) = if you == "white" { (me, bot) } else { (bot, me) };
    let game = GameInfo {
        id: format!("pm{now}"),
        source: Source::Local,
        url: None,
        white,
        black,
        winner,
        status,
        speed: "bot".into(),
        rated: false,
        time_control,
        created_at: now,
        opening: openings::identify(&moves),
        moves,
        clocks: None,
    };
    db.0.lock().unwrap().save_games(std::slice::from_ref(&game))?;
    Ok(game)
}

#[tauri::command]
async fn live_analyse(app: AppHandle, id: u64, fen: String) -> Result<(), String> {
    // Stopping the previous search can block briefly, so keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || app.state::<live::Live>().analyse(&app, id, &fen))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn live_stop(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<live::Live>().stop())
        .await
        .map_err(|e| e.to_string())?
}

/// True if the database at `path` holds any of your data (games or puzzle attempts).
fn has_user_data(path: &std::path::Path) -> bool {
    let Ok(conn) = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    ["games", "puzzle_log"].iter().any(|table| {
        conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table})"), [], |r| r.get::<_, bool>(0))
            .unwrap_or(false)
    })
}

/// The app ID changed from `dev.postmortem.app` to `io.github.event173.postmortem`
/// (needed for Flathub). Move data from the old folder – games, reviews, puzzle
/// database, settings of the web view – unless the new folder already holds
/// real data. A new folder with only an empty database (created by a start
/// before this migration existed) is replaced.
fn migrate_old_data_dir(new_dir: &std::path::Path) {
    let Some(old_dir) = new_dir.parent().map(|p| p.join("dev.postmortem.app")) else { return };
    if !old_dir.join("postmortem.db").is_file() || has_user_data(&new_dir.join("postmortem.db")) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&old_dir) else { return };
    // Leftovers of the empty database must not mix with the old one's WAL files.
    for name in ["postmortem.db", "postmortem.db-wal", "postmortem.db-shm"] {
        let _ = std::fs::remove_file(new_dir.join(name));
    }
    for entry in entries.flatten() {
        let target = new_dir.join(entry.file_name());
        // Anything already in the new folder came from an empty start: old data wins.
        if target.is_dir() {
            let _ = std::fs::remove_dir_all(&target);
        } else if target.exists() {
            let _ = std::fs::remove_file(&target);
        }
        let _ = std::fs::rename(entry.path(), &target);
    }
    let _ = std::fs::remove_dir(&old_dir); // only succeeds if everything moved
}

#[cfg(test)]
mod migration_tests {
    #[test]
    fn moves_old_data_once() {
        let root = std::env::temp_dir().join(format!("postmortem-migrate-{}", std::process::id()));
        let old = root.join("dev.postmortem.app");
        let new = root.join("io.github.event173.postmortem");
        std::fs::create_dir_all(old.join("localstorage")).unwrap();
        std::fs::write(old.join("postmortem.db"), b"games").unwrap();
        std::fs::write(old.join("localstorage").join("x"), b"prefs").unwrap();
        std::fs::create_dir_all(new.join("localstorage")).unwrap(); // created empty by the web view
        super::migrate_old_data_dir(&new);
        assert_eq!(std::fs::read(new.join("postmortem.db")).unwrap(), b"games");
        assert_eq!(std::fs::read(new.join("localstorage").join("x")).unwrap(), b"prefs");
        assert!(!old.exists());
        // Second run: nothing to do, nothing breaks.
        super::migrate_old_data_dir(&new);
        assert!(new.join("postmortem.db").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn replaces_an_empty_new_database_but_never_real_data() {
        let root = std::env::temp_dir().join(format!("postmortem-migrate2-{}", std::process::id()));
        let old = root.join("dev.postmortem.app");
        let new = root.join("io.github.event173.postmortem");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(new.join("localstorage")).unwrap();
        std::fs::write(new.join("localstorage").join("x"), b"new empty prefs").unwrap();

        // Old folder: a real database with a game.
        let mut old_db = crate::db::Db::open(&old.join("postmortem.db")).unwrap();
        old_db.save_games(&[sample_game()]).unwrap();
        drop(old_db);
        std::fs::create_dir_all(old.join("localstorage")).unwrap();
        std::fs::write(old.join("localstorage").join("x"), b"old prefs").unwrap();
        std::fs::write(old.join("puzzles.db"), b"puzzles").unwrap();
        // New folder: an empty database from a start before the migration existed.
        drop(crate::db::Db::open(&new.join("postmortem.db")).unwrap());

        super::migrate_old_data_dir(&new);
        assert!(super::has_user_data(&new.join("postmortem.db")));
        assert_eq!(std::fs::read(new.join("localstorage").join("x")).unwrap(), b"old prefs");
        assert_eq!(std::fs::read(new.join("puzzles.db")).unwrap(), b"puzzles");
        assert!(!old.exists());

        // Now the new folder has real data: a stray old folder must not overwrite it.
        std::fs::create_dir_all(&old).unwrap();
        drop(crate::db::Db::open(&old.join("postmortem.db")).unwrap());
        super::migrate_old_data_dir(&new);
        assert!(super::has_user_data(&new.join("postmortem.db")));
        assert!(old.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn sample_game() -> crate::lichess::GameInfo {
        crate::lichess::GameInfo {
            id: "g1".into(),
            source: Default::default(),
            url: None,
            white: crate::lichess::Player { name: "a".into(), rating: None },
            black: crate::lichess::Player { name: "b".into(), rating: None },
            winner: None,
            status: "draw".into(),
            speed: "blitz".into(),
            rated: false,
            time_control: None,
            created_at: 1,
            opening: None,
            moves: vec!["e4".into()],
            clocks: None,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AnalysisState::default())
        .manage(BatchState::default())
        .manage(PuzzleInstall::default())
        .manage(live::Live::default())
        .manage(bot::Bot::default())
        .manage(audio::Audio::open())
        .manage(explorer::Explorer::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            migrate_old_data_dir(&dir);
            let db = db::Db::open(&dir.join("postmortem.db"))?;
            // Once: learned lines become repertoire moves (with a backup before).
            if let Err(e) = tree::migrate(&db, &dir) {
                eprintln!("repertoire migration failed: {e}");
            }
            engine::configure(engine::EngineConfig {
                path: db.setting("stockfish_path")?.map(std::path::PathBuf::from),
                threads: db.setting("threads")?.and_then(|t| t.parse().ok()),
            });
            app.manage(DbState(Mutex::new(db)));
            app.manage(DataDir(dir));
            // Reviews used to be cached as JSON files; they now live in the database.
            if let Ok(cache) = app.path().app_cache_dir() {
                let _ = std::fs::remove_dir_all(cache.join("reviews"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_status,
            set_language,
            theory_report,
            game_summaries,
            list_games,
            sync_games,
            fetch_game,
            cancel_analysis,
            stored_review,
            app_update,
            import_pgn,
            export_pgn,
            open_releases_page,
            analyse_game,
            position_info,
            play_move,
            evaluate_move,
            live_analyse,
            live_stop,
            weakness_stats,
            analyse_all,
            cancel_batch,
            get_settings,
            set_engine_settings,
            puzzle_status,
            puzzle_check_update,
            puzzle_install,
            puzzle_cancel,
            puzzle_delete,
            puzzle_next,
            puzzle_record,
            puzzle_profile,
            refutation,
            engine_line,
            opening_report,
            opening_families,
            opening_text,
            open_opening_source,
            repertoire_get,
            repertoire_set,
            opening_status,
            opening_next,
            opening_own_count,
            opening_reset,
            card_create,
            cards_list,
            card_delete,
            favorites,
            favorite_set,
            game_errors,
            backup_create,
            backup_check,
            backup_restore,
            explorer_prepare,
            explorer_moves,
            explorer_lichess,
            lichess_token_status,
            lichess_token_set,
            open_lichess_token_page,
            opening_record,
            opening_progress,
            opening_family_detail,
            opening_relevance_prepare,
            opening_recommendations,
            opening_line_for_game,
            rep_tree,
            rep_tree_prepare,
            rep_set_move,
            rep_change_move,
            rep_add_line,
            rep_set_note,
            rep_check_quality,
            rep_notes,
            rep_set_depth,
            rep_delete_move,
            rep_delete_family,
            rep_check_games,
            rep_deviations,
            rep_summaries,
            sound_available,
            sound_register,
            sound_play,
            bot_levels,
            bot_move,
            game_status,
            save_bot_game
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod integration {
    use super::*;

    /// Full pipeline against the live Lichess API and a local Stockfish.
    /// Run with: cargo test -- --ignored --nocapture
    /// Optional env: POSTMORTEM_TEST_USER, POSTMORTEM_TEST_DEPTH, POSTMORTEM_STOCKFISH
    #[test]
    #[ignore]
    fn review_real_game() {
        let user = std::env::var("POSTMORTEM_TEST_USER").unwrap_or_else(|_| "thibault".into());
        let depth = std::env::var("POSTMORTEM_TEST_DEPTH").ok().and_then(|d| d.parse().ok()).unwrap_or(12);
        let query = GameQuery { max: Some(5), ..Default::default() };
        let games = tauri::async_runtime::block_on(lichess::fetch_user_games(&user, query)).unwrap();
        let game = games.first().expect("no games");
        println!("{} vs {} ({} plies)", game.white.name, game.black.name, game.moves.len());

        let path = engine::find_stockfish().expect("stockfish not found");
        let (positions, moves) = analysis::replay(&game.moves).unwrap();
        let mut sf = engine::Engine::start(&path, 4, 128, 2).unwrap();
        let start = std::time::Instant::now();
        let lines: Vec<_> = positions
            .iter()
            .map(|p| analysis::terminal_eval(p).unwrap_or_else(|| sf.analyse(&analysis::fen(p), depth).unwrap()))
            .collect();
        println!("analysed in {:.1}s", start.elapsed().as_secs_f64());

        let review = analysis::build_review(game, depth, &positions, &moves, &lines);
        println!("accuracy: white {} / black {}", review.accuracy.white, review.accuracy.black);
        for m in &review.moves {
            println!(
                "{:>3} {:<8} {:<11} {:>5.1} -> {:>5.1}  {}",
                m.ply,
                m.san,
                format!("{:?}", m.classification),
                m.win_before,
                m.win_after,
                m.comment
            );
        }
        assert_eq!(review.moves.len(), game.moves.len());
    }
}
