mod analysis;
mod coach;
mod db;
mod engine;
mod explore;
mod lichess;
mod live;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use analysis::GameReview;
use lichess::{FetchError, GameInfo, GameQuery};

/// Cancellation flag of the analysis currently running (if any).
#[derive(Default)]
struct AnalysisState {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

struct DbState(Mutex<db::Db>);

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

/// Games stored locally for a player (works offline), newest first.
#[tauri::command]
fn list_games(db: State<DbState>, username: String, limit: Option<u32>) -> Result<Vec<db::StoredGame>, String> {
    db.0.lock().unwrap().games_of(username.trim(), limit.unwrap_or(500))
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
async fn sync_games(db: State<'_, DbState>, username: String, older: Option<bool>) -> Result<SyncResult, String> {
    let username = username.trim().to_string();
    let range = db.0.lock().unwrap().time_range(&username)?;
    let query = match (range, older.unwrap_or(false)) {
        (Some((_, oldest)), true) => GameQuery { max: Some(50), until: Some(oldest - 1), ..Default::default() },
        (Some((newest, _)), false) => GameQuery { max: Some(500), since: Some(newest + 1), ..Default::default() },
        // First sync: a reasonable recent batch.
        (None, _) => GameQuery { max: Some(100), ..Default::default() },
    };
    match lichess::fetch_user_games(&username, query).await {
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
    let review = tauri::async_runtime::spawn_blocking(move || run_analysis(&app2, &game2, depth, &cancel))
        .await
        .map_err(|e| e.to_string())??;

    let mut db = db.0.lock().unwrap();
    db.save_games(std::slice::from_ref(&game))?;
    db.save_review(&review)?;
    Ok(review)
}

fn run_analysis(app: &AppHandle, game: &GameInfo, depth: u32, cancel: &AtomicBool) -> Result<GameReview, String> {
    let path = engine::find_stockfish()
        .ok_or("Stockfish wurde nicht gefunden. Installiere es z. B. mit: sudo apt install stockfish")?;
    let (positions, moves) = analysis::replay(&game.moves)?;

    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(1);
    let mut sf = engine::Engine::start(&path, threads, 256, 2)?;

    let total = positions.len();
    let mut lines = Vec::with_capacity(total);
    for (i, pos) in positions.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let l = match analysis::terminal_eval(pos) {
            Some(l) => l,
            None => sf.analyse(&analysis::fen(pos), depth)?,
        };
        lines.push(l);
        let _ = app.emit("analysis-progress", Progress { game_id: game.id.clone(), done: i + 1, total });
    }
    Ok(analysis::build_review(game, depth, &positions, &moves, &lines))
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
        .manage(live::Live::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = db::Db::open(&dir.join("postmortem.db"))?;
            app.manage(DbState(Mutex::new(db)));
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
            live_stop
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
