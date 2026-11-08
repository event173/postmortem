mod analysis;
mod chesscom;
mod coach;
mod db;
mod engine;
mod explore;
mod lichess;
mod live;
mod openings;
mod puzzles;
mod stats;
mod trainer;

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
    done: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatus {
    found: bool,
    path: Option<String>,
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
) -> Result<GameReview, String> {
    let depth = depth.unwrap_or(16).clamp(8, 30);
    if let Some(review) = db.0.lock().unwrap().review(&game.id, depth)? {
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
    let path = engine::find_stockfish()
        .ok_or("Stockfish wurde nicht gefunden. Installiere es z. B. mit: sudo apt install stockfish")?;
    let (positions, moves) = analysis::replay(&game.moves)?;

    // Pass 1: best line only. Pass 2: second-best line where the classification needs it.
    let mut sf = engine::Engine::start(&path, threads, 256, 1)?;
    let n = positions.len();
    let progress = |done: usize, total: usize| {
        let _ = app.emit("analysis-progress", Progress { game_id: game.id.clone(), done, total });
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
            return Err(format!("Datei nicht gefunden: {}", p.display()));
        }
        tauri::async_runtime::spawn_blocking(move || engine::verify(&p))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Das scheint keine UCI-Engine zu sein: {e}"))?;
    }
    let threads = threads.map(|t| t.clamp(1, engine::cpu_count()));
    let db = app.state::<DbState>();
    let db = db.0.lock().unwrap();
    db.set_setting("stockfish_path", path.as_ref().map(|p| p.display().to_string()).as_deref())?;
    db.set_setting("threads", threads.map(|t| t.to_string()).as_deref())?;
    engine::configure(engine::EngineConfig { path, threads });
    app.state::<live::Live>().reset();
    settings_info(&db, &app.state::<DataDir>())
}

#[tauri::command]
fn puzzle_status(dir: State<DataDir>) -> puzzles::PuzzleStatus {
    puzzles::status(&dir.0)
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
            return Err("Der Download läuft bereits.".into());
        }
        *running = Some(cancel.clone());
    }
    let result = puzzles::install(app.clone(), dir.0.clone(), cancel).await;
    *install.cancel.lock().unwrap() = None;
    result
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AnalysisState::default())
        .manage(BatchState::default())
        .manage(PuzzleInstall::default())
        .manage(live::Live::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = db::Db::open(&dir.join("postmortem.db"))?;
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
            list_games,
            sync_games,
            fetch_game,
            cancel_analysis,
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
            puzzle_next,
            puzzle_record,
            puzzle_profile,
            refutation
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
