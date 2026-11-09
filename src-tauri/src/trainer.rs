//! Puzzle training: picks puzzles that fit your weaknesses, without drilling
//! only one theme.
//!
//! Mix per puzzle: ~60 % weakness themes (weighted by how often the weakness
//! shows up in the chosen games and by how *badly* you solve that theme),
//! ~25 % mixed puzzles at your level, ~15 % positions from your own games.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::analysis::{Class, GameReview};
use crate::coach::Theme;
use crate::db::{Account, Attempt, Db};
use crate::lichess::GameInfo;
use crate::stats;

const OWN_SHARE: f64 = 0.15;
const WEAKNESS_SHARE: f64 = 0.60;
/// Solved own-mistake positions rest this long before they may come back.
const OWN_REST_MS: i64 = 3 * 24 * 3600 * 1000;
/// Attempts per theme that count for its mastery.
const MASTERY_WINDOW: usize = 20;
const DEFAULT_RATING: f64 = 1500.0;
/// "Positional" means the coach found no concrete tactic – puzzles train that
/// poorly, so it counts much less than the concrete tactical weaknesses.
const POSITIONAL_WEIGHT: f64 = 0.25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Lichess,
    Own,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Lichess => "lichess",
            Kind::Own => "own",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    /// Chosen for one of your weaknesses.
    Weakness,
    /// Any theme at your level, so training doesn't get one-sided.
    Mixed,
    /// A position from your own games where you went wrong.
    Own,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnInfo {
    pub game_id: String,
    pub ply: usize,
    pub san: String,
    pub classification: Class,
    pub opponent: String,
    pub created_at: i64,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Puzzle {
    pub kind: Kind,
    pub id: String,
    pub fen: String,
    /// UCI. Lichess: the opponent's setup move first, then the solution
    /// alternating with replies. Own: just the engine's best move.
    pub moves: Vec<String>,
    pub rating: Option<i64>,
    /// Lichess puzzle themes (shown after solving).
    pub themes: Vec<String>,
    pub category: Category,
    /// The weakness this puzzle was chosen for.
    pub theme: Option<Theme>,
    /// How often that weakness occurs per game in the chosen games.
    pub theme_per_game: Option<f64>,
    pub game_url: Option<String>,
    pub own: Option<OwnInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mastery {
    pub theme: Theme,
    pub attempts: u32,
    pub solved: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub rating: f64,
    pub attempts: u32,
    pub solved: u32,
    pub today_attempts: u32,
    pub today_solved: u32,
    pub mastery: Vec<Mastery>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptInput {
    pub id: String,
    pub kind: Kind,
    pub theme: Option<Theme>,
    pub rating: Option<i64>,
    pub solved: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatingChange {
    pub rating: f64,
    pub delta: f64,
}

/// Lichess puzzle themes that train a given weakness.
fn lichess_themes(theme: Theme) -> &'static [&'static str] {
    match theme {
        Theme::HangingPiece => &["hangingPiece", "trappedPiece"],
        Theme::AllowedFork => &["fork"],
        Theme::AllowedMate => &["mateIn1", "mateIn2", "backRankMate"],
        Theme::MissedMate => &["mateIn1", "mateIn2", "mateIn3"],
        Theme::LostMaterial => &["pin", "skewer", "discoveredAttack", "deflection", "attraction"],
        Theme::MissedTactic => &["hangingPiece", "fork", "pin", "skewer", "discoveredAttack"],
        Theme::MissedChance => &["crushing", "hangingPiece", "intermezzo"],
        Theme::Positional => &["quietMove", "defensiveMove", "zugzwang"],
    }
}

fn theme_key(theme: Theme) -> String {
    serde_json::to_value(theme).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Pick by weight; `None` if all weights are zero.
fn weighted<T: Copy>(items: &[(T, f64)], rng: &mut fastrand::Rng) -> Option<T> {
    let total: f64 = items.iter().map(|(_, w)| w.max(0.0)).sum();
    if total <= 0.0 {
        return None;
    }
    let mut x = rng.f64() * total;
    for &(item, w) in items {
        x -= w.max(0.0);
        if x <= 0.0 {
            return Some(item);
        }
    }
    items.last().map(|&(i, _)| i)
}

/// Your puzzle rating: stored, or initialised from your recent game ratings.
pub fn rating(db: &Db, games: &[(GameInfo, GameReview)], accounts: &[Account]) -> f64 {
    if let Some(r) = db.setting("puzzle_rating").ok().flatten().and_then(|r| r.parse().ok()) {
        return r;
    }
    let mine: Vec<f64> = games
        .iter()
        .take(10)
        .filter_map(|(g, _)| {
            let me = accounts.iter().find(|a| a.source == g.source)?.username.to_lowercase();
            let p = if g.white.name.to_lowercase() == me { &g.white } else { &g.black };
            p.rating.map(f64::from)
        })
        .collect();
    if mine.is_empty() { DEFAULT_RATING } else { mine.iter().sum::<f64>() / mine.len() as f64 }
}

fn open_puzzles(dir: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(crate::puzzles::db_path(dir), OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    crate::puzzles::status(dir).installed.then_some(conn)
}

type PuzzleRow = (String, String, String, i64, String, String);

/// Up to 40 unseen, well-liked puzzles with rating in `from..=to`, lowest first.
fn query_range(
    conn: &Connection,
    from: i64,
    to: i64,
    theme: Option<&str>,
    seen: &HashSet<String>,
) -> Result<Vec<PuzzleRow>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT id, fen, moves, rating, themes, game_url FROM puzzles
             WHERE rating BETWEEN ?1 AND ?2 AND popularity >= 80 AND plays >= 200
               AND (?3 IS NULL OR instr(' ' || themes || ' ', ' ' || ?3 || ' ') > 0)
             ORDER BY rating LIMIT 40",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from, to, theme], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).filter(|r: &PuzzleRow| !seen.contains(&r.0)).collect())
}

/// A random well-liked Lichess puzzle near `rating`, optionally with a theme.
fn pick_lichess(
    conn: &Connection,
    rating: f64,
    theme: Option<&str>,
    seen: &HashSet<String>,
    rng: &mut fastrand::Rng,
) -> Result<Option<Puzzle>, String> {
    for spread in [100.0, 200.0, 400.0] {
        // Start at a random rating inside the window and walk the index upwards
        // (fast: no full scan, no ORDER BY random()). If the upper part has
        // nothing, wrap around to the lower part so sparse themes are still found.
        let low = (rating - spread).round() as i64;
        let high = (rating + spread).round() as i64;
        let start = low + (rng.f64() * (high - low) as f64) as i64;
        let mut candidates = query_range(conn, start, high, theme, seen)?;
        if candidates.is_empty() && start > low {
            candidates = query_range(conn, low, start - 1, theme, seen)?;
        }
        if candidates.is_empty() {
            continue;
        }
        let (id, fen, moves, rating, themes, url) = candidates.swap_remove(rng.usize(..candidates.len()));
        return Ok(Some(Puzzle {
            kind: Kind::Lichess,
            id,
            fen,
            moves: moves.split_whitespace().map(String::from).collect(),
            rating: Some(rating),
            themes: themes.split_whitespace().map(String::from).collect(),
            category: Category::Mixed,
            theme: None,
            theme_per_game: None,
            game_url: Some(url),
            own: None,
        }));
    }
    Ok(None)
}

/// A position from your own games where you made a serious mistake.
fn pick_own(
    games: &[(GameInfo, GameReview)],
    accounts: &[Account],
    resting: &HashSet<String>,
    rng: &mut fastrand::Rng,
) -> Option<Puzzle> {
    let mut candidates = Vec::new();
    for (game, review) in games {
        let Some(me) = accounts.iter().find(|a| a.source == game.source).map(|a| a.username.to_lowercase()) else {
            continue;
        };
        let color = if game.white.name.to_lowercase() == me { "white" } else { "black" };
        let opponent = if color == "white" { &game.black.name } else { &game.white.name };
        for m in &review.moves {
            let serious = matches!(m.classification, Class::Mistake | Class::Miss | Class::Blunder);
            let id = format!("{}:{}", game.id, m.ply);
            if m.color != color || !serious || m.best_uci.is_none() || resting.contains(&id) {
                continue;
            }
            let Some(fen) = review.fens.get(m.ply - 1) else { continue };
            candidates.push(Puzzle {
                kind: Kind::Own,
                id,
                fen: fen.clone(),
                moves: vec![m.best_uci.clone()?],
                rating: None,
                themes: vec![],
                category: Category::Own,
                theme: m.theme,
                theme_per_game: None,
                game_url: game.url.clone(),
                own: Some(OwnInfo {
                    game_id: game.id.clone(),
                    ply: m.ply,
                    san: m.san.clone(),
                    classification: m.classification,
                    opponent: opponent.clone(),
                    created_at: game.created_at,
                    comment: m.localized_comment(),
                }),
            });
        }
    }
    if candidates.is_empty() {
        return None;
    }
    Some(candidates.swap_remove(rng.usize(..candidates.len())))
}

/// Weakness themes weighted by frequency × (1.5 − solve rate): themes you
/// already solve reliably come up less, even if they still appear in games.
fn theme_weights(weakness: &stats::WeaknessStats, mastery: &HashMap<String, (u32, u32)>) -> Vec<(Theme, f64)> {
    weakness
        .themes
        .iter()
        .map(|t| {
            let rate = mastery
                .get(&theme_key(t.theme))
                .filter(|(attempts, _)| *attempts >= 3)
                .map(|&(attempts, solved)| solved as f64 / attempts as f64)
                .unwrap_or(0.5);
            let relevance = if t.theme == Theme::Positional { POSITIONAL_WEIGHT } else { 1.0 };
            (t.theme, t.count as f64 * (1.5 - rate) * relevance)
        })
        .collect()
}

/// Next puzzle for the accounts, based on their last `last` games (all if None).
pub fn next(db: &Db, data_dir: &Path, accounts: &[Account], last: Option<usize>) -> Result<Option<Puzzle>, String> {
    let mut rng = fastrand::Rng::new();
    let all_games = db.reviewed_games_of(accounts)?;
    let n = last.unwrap_or(all_games.len()).min(all_games.len());
    let games = &all_games[..n];
    let player_rating = rating(db, &all_games, accounts);
    let puzzles = open_puzzles(data_dir);
    let seen = db.attempted_ids(Kind::Lichess.as_str())?;
    let resting = db.solved_since(Kind::Own.as_str(), now_ms() - OWN_REST_MS)?;

    let weakness = stats::compute(accounts, 0, games);
    let mastery: HashMap<String, (u32, u32)> =
        db.theme_mastery(MASTERY_WINDOW)?.into_iter().map(|(t, a, s)| (t, (a, s))).collect();
    let weights = theme_weights(&weakness, &mastery);

    // Draw a category, then fall back to the others if it has nothing to offer.
    let roll = rng.f64();
    let mut order = if roll < OWN_SHARE {
        vec![Category::Own, Category::Weakness, Category::Mixed]
    } else if roll < OWN_SHARE + WEAKNESS_SHARE {
        vec![Category::Weakness, Category::Mixed, Category::Own]
    } else {
        vec![Category::Mixed, Category::Weakness, Category::Own]
    };
    if puzzles.is_none() {
        order = vec![Category::Own];
    }

    for category in order {
        match category {
            Category::Own => {
                if let Some(p) = pick_own(games, accounts, &resting, &mut rng) {
                    return Ok(Some(p));
                }
            }
            Category::Weakness => {
                let (Some(conn), Some(theme)) = (&puzzles, weighted(&weights, &mut rng)) else { continue };
                let options = lichess_themes(theme);
                let lichess_theme = options[rng.usize(..options.len())];
                if let Some(mut p) = pick_lichess(conn, player_rating, Some(lichess_theme), &seen, &mut rng)? {
                    p.category = Category::Weakness;
                    p.theme = Some(theme);
                    let count = weakness.themes.iter().find(|t| t.theme == theme).map_or(0, |t| t.count);
                    p.theme_per_game =
                        (weakness.games_analysed > 0).then(|| count as f64 / weakness.games_analysed as f64);
                    return Ok(Some(p));
                }
            }
            Category::Mixed => {
                let Some(conn) = &puzzles else { continue };
                if let Some(p) = pick_lichess(conn, player_rating, None, &seen, &mut rng)? {
                    return Ok(Some(p));
                }
            }
        }
    }
    Ok(None)
}

/// Elo-style update against the puzzle's rating; faster at the start.
pub fn update_rating(rating: f64, puzzle_rating: f64, solved: bool, attempts: u32) -> f64 {
    let k = if attempts < 20 { 40.0 } else { 20.0 };
    let expected = 1.0 / (1.0 + 10f64.powf((puzzle_rating - rating) / 400.0));
    rating + k * (if solved { 1.0 } else { 0.0 } - expected)
}

pub fn record(db: &Db, accounts: &[Account], input: &AttemptInput) -> Result<RatingChange, String> {
    let before = rating(db, &db.reviewed_games_of(accounts)?, accounts);
    let (attempts, ..) = db.attempt_counts(0)?;
    db.log_attempt(&Attempt {
        puzzle_id: input.id.clone(),
        kind: input.kind.as_str().into(),
        theme: input.theme.map(theme_key),
        solved: input.solved,
        rating: input.rating,
        at: now_ms(),
    })?;
    // Only rated Lichess puzzles move the rating; own positions are review.
    let after = match (input.kind, input.rating) {
        (Kind::Lichess, Some(r)) => update_rating(before, r as f64, input.solved, attempts),
        _ => before,
    };
    db.set_setting("puzzle_rating", Some(&format!("{after:.1}")))?;
    Ok(RatingChange { rating: after, delta: after - before })
}

pub fn profile(db: &Db, accounts: &[Account]) -> Result<Profile, String> {
    let games = db.reviewed_games_of(accounts)?;
    let start_of_day = {
        let now = now_ms();
        now - now.rem_euclid(24 * 3600 * 1000)
    };
    let (attempts, solved, today_attempts, today_solved) = db.attempt_counts(start_of_day)?;
    let mastery = db
        .theme_mastery(MASTERY_WINDOW)?
        .into_iter()
        .filter_map(|(t, attempts, solved)| {
            let theme: Theme = serde_json::from_value(serde_json::Value::String(t)).ok()?;
            Some(Mastery { theme, attempts, solved })
        })
        .collect();
    Ok(Profile { rating: rating(db, &games, accounts), attempts, solved, today_attempts, today_solved, mastery })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rating_moves_towards_results() {
        let up = update_rating(1500.0, 1500.0, true, 0);
        let down = update_rating(1500.0, 1500.0, false, 0);
        assert!((up - 1520.0).abs() < 1e-9 && (down - 1480.0).abs() < 1e-9);
        // Solving a much easier puzzle barely helps; failing it hurts.
        assert!(update_rating(1500.0, 1000.0, true, 50) - 1500.0 < 1.5);
        assert!(1500.0 - update_rating(1500.0, 1000.0, false, 50) > 18.0);
    }

    #[test]
    fn mastered_themes_get_less_weight() {
        let ws = |forks: usize, pins: usize| stats::WeaknessStats {
            games_total: 0,
            games_analysed: 1,
            moves: 0,
            accuracy_avg: None,
            classes: HashMap::new(),
            themes: vec![
                stats::ThemeStat { theme: Theme::AllowedFork, count: forks, baseline_per_game: None, examples: vec![] },
                stats::ThemeStat { theme: Theme::HangingPiece, count: pins, baseline_per_game: None, examples: vec![] },
            ],
            phases: HashMap::new(),
            clock: HashMap::new(),
            trend: vec![],
            history: Default::default(),
        };
        let mut mastery = HashMap::new();
        mastery.insert("allowedFork".to_string(), (10, 10)); // always solved
        mastery.insert("hangingPiece".to_string(), (10, 0)); // never solved
        let w = theme_weights(&ws(10, 4), &mastery);
        // 10 forks × 0.5 = 5 vs 4 hanging × 1.5 = 6: the unsolved weakness wins.
        assert!((w[0].1 - 5.0).abs() < 1e-9);
        assert!((w[1].1 - 6.0).abs() < 1e-9);
        // Too few attempts -> neutral factor 1.0.
        mastery.insert("allowedFork".to_string(), (2, 2));
        assert!((theme_weights(&ws(10, 4), &mastery)[0].1 - 10.0).abs() < 1e-9);

        // "Positional" counts only a quarter.
        let mut s = ws(0, 0);
        s.themes = vec![stats::ThemeStat { theme: Theme::Positional, count: 22, baseline_per_game: None, examples: vec![] }];
        assert!((theme_weights(&s, &HashMap::new())[0].1 - 5.5).abs() < 1e-9);
    }

    #[test]
    fn weighted_choice_respects_weights() {
        let mut rng = fastrand::Rng::with_seed(7);
        let items = [("a", 0.0), ("b", 3.0), ("c", 1.0)];
        let mut counts = HashMap::new();
        for _ in 0..4000 {
            *counts.entry(weighted(&items, &mut rng).unwrap()).or_insert(0) += 1;
        }
        assert!(!counts.contains_key("a"));
        let ratio = counts["b"] as f64 / counts["c"] as f64;
        assert!((2.5..3.5).contains(&ratio), "{ratio}");
        assert_eq!(weighted(&[("x", 0.0)], &mut rng), None);
    }

    fn puzzle_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE puzzles (id TEXT PRIMARY KEY, fen TEXT, moves TEXT, rating INTEGER,
                popularity INTEGER, plays INTEGER, themes TEXT, game_url TEXT) WITHOUT ROWID;
             CREATE INDEX puzzles_rating ON puzzles(rating);
             INSERT INTO puzzles VALUES
               ('fork1', 'f', 'a b', 1520, 95, 5000, 'fork middlegame short', 'u1'),
               ('fork2', 'f', 'a b', 1480, 95, 5000, 'endgame fork', 'u2'),
               ('unpop', 'f', 'a b', 1500, 10, 5000, 'fork', 'u3'),
               ('pin1',  'f', 'a b', 1510, 90, 900, 'pin long', 'u4'),
               ('far',   'f', 'a b', 2600, 99, 9000, 'fork', 'u5');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn picks_matching_unseen_popular_puzzles() {
        let conn = puzzle_db();
        let mut rng = fastrand::Rng::with_seed(1);
        let mut seen = HashSet::new();
        for _ in 0..20 {
            let p = pick_lichess(&conn, 1500.0, Some("fork"), &seen, &mut rng).unwrap().unwrap();
            assert!(p.id == "fork1" || p.id == "fork2", "{}", p.id);
            assert!(p.themes.contains(&"fork".to_string()));
        }
        // Theme names match whole words only ("pin" must not match "pinned"-like words).
        assert_eq!(pick_lichess(&conn, 1500.0, Some("pin"), &seen, &mut rng).unwrap().unwrap().id, "pin1");
        assert!(pick_lichess(&conn, 1500.0, Some("pi"), &seen, &mut rng).unwrap().is_none());
        // Seen puzzles are skipped; when all are seen, nothing comes back.
        seen.insert("fork1".to_string());
        seen.insert("fork2".to_string());
        assert!(pick_lichess(&conn, 1500.0, Some("fork"), &seen, &mut rng).unwrap().is_none());
        // Mixed (no theme) still finds something at the level.
        assert!(pick_lichess(&conn, 1500.0, None, &seen, &mut rng).unwrap().is_some());
    }

    #[test]
    fn every_weakness_maps_to_lichess_themes() {
        for t in [
            Theme::AllowedMate,
            Theme::MissedMate,
            Theme::AllowedFork,
            Theme::HangingPiece,
            Theme::LostMaterial,
            Theme::MissedTactic,
            Theme::MissedChance,
            Theme::Positional,
        ] {
            assert!(!lichess_themes(t).is_empty());
            assert!(!theme_key(t).is_empty());
        }
    }
}
