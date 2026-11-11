//! Which lines of an opening are worth learning: the ones that actually come
//! up. For every line we estimate its *reach* – the share of games at your
//! level (Lichess opening explorer) that arrive at it when you play your
//! moves, counted from the opening's defining moves. Lines below `MIN_REACH`
//! are rare sidelines: not part of the course unless you pick them yourself.
//! Lines that came up in your own games always count.
//!
//! The explorer is asked top-down and only where it matters: once a line's
//! reach is below the threshold, nothing below it is fetched. Answers are
//! stored (`explorer_cache`), the result per opening too (`opening_relevance`).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use shakmaty::{san::San, uci::UciMove, CastlingMode, Chess, Color, Position};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{Account, Db};
use crate::explorer::{self, Explorer, FetchError, LichessData};
use crate::openings::{epd, Line};
use crate::repertoire::{family_lines, my_color};

/// A line is common when at least this share of games at your level reaches it.
pub const MIN_REACH: f64 = 0.03;
/// Safety cap of explorer requests for one opening.
const MAX_REQUESTS: usize = 400;
/// Only the first moves of your games count (like the explorer's index).
const OWN_PLIES: usize = 30;
/// Waits after a 429 before giving up (one minute each).
const MAX_WAITS: usize = 3;
/// Pause between two explorer requests: Lichess slows down quick series.
const GAP_MS: u64 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRel {
    /// Share of games at your level that reach the line; None: not known yet.
    pub reach: Option<f64>,
    /// The line came up in your own games.
    pub in_games: bool,
}

impl LineRel {
    pub fn common(&self) -> bool {
        self.in_games || self.reach.is_none_or(|r| r >= MIN_REACH)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relevance {
    /// Rating groups of the numbers, e.g. "1600–2000" (empty: no Lichess data).
    pub ratings: String,
    /// Every position that matters was fetched.
    pub complete: bool,
    /// Rare lines that had only just been started were taken out of the
    /// flashcards once (when the numbers first came in).
    #[serde(default)]
    pub cleaned: bool,
    pub lines: HashMap<String, LineRel>,
}

impl Relevance {
    /// Part of the course? Lines without numbers are.
    pub fn common(&self, id: &str) -> bool {
        self.lines.get(id).is_none_or(|r| r.common())
    }
}

/// Is this line part of the course (`rel` of its opening, if any)?
pub fn is_common(rel: Option<&Relevance>, id: &str) -> bool {
    rel.is_none_or(|r| r.common(id))
}

/// All stored results, keyed "color|family".
pub fn all(db: &Db) -> HashMap<String, Relevance> {
    db.opening_relevance()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(color, family, data)| Some((format!("{color}|{family}"), serde_json::from_str(&data).ok()?)))
        .collect()
}

pub fn get(db: &Db, color: &str, family: &str) -> Option<Relevance> {
    all(db).remove(&format!("{color}|{family}"))
}

/// Move counts of one position.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Counts {
    pub total: u64,
    pub moves: Vec<(String, u64)>,
}

impl Counts {
    fn of(data: &LichessData) -> Counts {
        Counts { total: data.total, moves: data.moves.iter().map(|m| (m.uci.clone(), m.white + m.draws + m.black)).collect() }
    }
    pub fn get(&self, uci: &str) -> u64 {
        self.moves.iter().find(|(u, _)| u == uci).map_or(0, |(_, n)| *n)
    }
    pub fn max(&self) -> u64 {
        self.moves.iter().map(|(_, n)| *n).max().unwrap_or(0)
    }
    /// Share of the games here that continue with `uci`.
    pub fn share(&self, uci: &str) -> f64 {
        if self.total == 0 { 0.0 } else { self.get(uci) as f64 / self.total as f64 }
    }
}

/// The Lichess numbers at your level: what's stored, and what's needed to get more.
pub(crate) struct Numbers {
    pub token: Option<String>,
    pub ratings: Vec<u32>,
    /// "1600–2000" (also the cache key prefix).
    pub label: String,
    /// EPD -> move counts.
    pub counts: HashMap<String, Counts>,
}

pub(crate) fn numbers(db: &Db, accounts: &[Account]) -> Result<Numbers, String> {
    let ratings = explorer::buckets(explorer::my_rating(db, accounts));
    let label = explorer::label(&ratings);
    let prefix = cache_prefix(&label);
    let counts = db
        .explorer_cache(&prefix)?
        .into_iter()
        .filter_map(|(key, data)| Some((key[prefix.len()..].to_string(), serde_json::from_str(&data).ok()?)))
        .collect();
    Ok(Numbers { token: explorer::token(db), ratings, label, counts })
}

/// Everything the computation needs, read from the database once.
pub struct Context {
    color: String,
    family: String,
    nums: Numbers,
    own: HashSet<(String, String)>,
    previous: Option<Relevance>,
}

fn cache_prefix(label: &str) -> String {
    format!("{label}|")
}

pub fn context(db: &Db, accounts: &[Account], color: &str, family: &str) -> Result<Context, String> {
    Ok(Context {
        color: color.to_string(),
        family: family.to_string(),
        nums: numbers(db, accounts)?,
        own: own_moves(db, accounts, color)?,
        previous: get(db, color, family),
    })
}

/// (position, move) pairs you met in your games as `color` (your moves and your opponents').
fn own_moves(db: &Db, accounts: &[Account], color: &str) -> Result<HashSet<(String, String)>, String> {
    let mut out = HashSet::new();
    for g in db.games_of(accounts, 1_000_000)? {
        if my_color(&g.game, accounts) != Some(color) {
            continue;
        }
        let mut pos = Chess::default();
        for san in g.game.moves.iter().take(OWN_PLIES) {
            let Some(m) = san.parse::<San>().ok().and_then(|s| s.to_move(&pos).ok()) else { break };
            out.insert((epd(&pos), UciMove::from_move(m, CastlingMode::Standard).to_string()));
            pos.play_unchecked(m);
        }
    }
    Ok(out)
}

/// Reach of every line with the numbers at hand, and the positions still
/// needed (the first unknown one of each line that is still above the threshold).
fn evaluate(lines: &[&Line], color: &str, counts: &HashMap<String, Counts>, own: &HashSet<(String, String)>) -> (HashMap<String, LineRel>, Vec<(String, String)>) {
    let me = if color == "white" { Color::White } else { Color::Black };
    // The defining moves of the opening (its shortest line) are given.
    let base = lines.iter().map(|l| l.moves.len()).min().unwrap_or(0);
    let mut out = HashMap::new();
    let mut needed: Vec<(String, String)> = Vec::new();
    for line in lines {
        let mut pos = Chess::default();
        let mut reach = 1.0;
        let mut known = true;
        let mut below = false;
        let mut in_games = true;
        for (i, uci) in line.moves.iter().enumerate() {
            let Some(m) = uci.parse::<UciMove>().ok().and_then(|u| u.to_move(&pos).ok()) else { break };
            if i >= base {
                let key = epd(&pos);
                in_games &= own.contains(&(key.clone(), uci.clone()));
                if known && !below {
                    match counts.get(&key) {
                        None => {
                            known = false;
                            if !needed.iter().any(|(k, _)| *k == key) {
                                needed.push((key, crate::analysis::fen(&pos)));
                            }
                        }
                        Some(c) => {
                            let n = c.get(uci) as f64;
                            if pos.turn() == me {
                                // Your choice: the usual move keeps the line whole,
                                // an unusual one counts as much as it's played.
                                let max = c.max() as f64;
                                reach *= if max == 0.0 { 0.0 } else { n / max };
                            } else {
                                reach *= if c.total == 0 { 0.0 } else { n / c.total as f64 };
                            }
                            below = reach < MIN_REACH;
                        }
                    }
                }
            }
            pos.play_unchecked(m);
        }
        let reach = (known || below).then_some(reach);
        out.insert(line.id.clone(), LineRel { reach, in_games });
    }
    (out, needed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// "ready", "partial" (something went wrong – see `error`) or "noToken".
    pub state: String,
    pub ratings: String,
    /// Explorer requests made now.
    pub requests: usize,
    /// Lines in the course / all lines.
    pub common: usize,
    pub total: usize,
    /// Rare lines taken out of the flashcards now.
    pub removed: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    color: &'a str,
    family: &'a str,
    /// Positions fetched so far.
    done: usize,
    /// Waiting for Lichess (after a 429).
    waiting: bool,
}

pub(crate) fn with_db<T>(app: &AppHandle, f: impl FnOnce(&Db) -> T) -> T {
    let state = app.state::<crate::DbState>();
    let db = state.0.lock().unwrap();
    f(&db)
}

/// Fetch what's missing for one opening (one colour) and store the result.
pub async fn prepare(app: AppHandle, accounts: Vec<Account>, color: String, family: String) -> Result<Prepared, String> {
    let a = app.clone();
    let (c, f) = (color.clone(), family.clone());
    let mut ctx = tauri::async_runtime::spawn_blocking(move || with_db(&a, |db| context(db, &accounts, &c, &f)))
        .await
        .map_err(|e| e.to_string())??;
    let lines = family_lines(&color, &family);
    let mut f = Fetching::default();
    let (rel, complete) = loop {
        let (rel, needed) = evaluate(&lines, &color, &ctx.nums.counts, &ctx.own);
        if ctx.nums.token.is_none() {
            break (rel, false);
        }
        if needed.is_empty() {
            break (rel, true);
        }
        if f.requests >= MAX_REQUESTS || f.error.is_some() {
            break (rel, false);
        }
        fetch(&app, &mut ctx.nums, needed, &mut f, &color, &family).await?;
    };
    let requests = f.requests;
    let mut error = f.error;
    let state = if ctx.nums.token.is_none() {
        "noToken"
    } else if complete {
        "ready"
    } else {
        "partial"
    };
    if state == "partial" && error.is_none() {
        error = Some(tr!("Lichess hat nicht alle Zahlen geliefert – später geht es weiter.", "Lichess didn't deliver all numbers – it continues later."));
    }
    let common = rel.values().filter(|r| r.common()).count();
    let total = rel.len();
    let removed = with_db(&app, |db| store(db, &ctx, rel, complete))?;
    Ok(Prepared { state: state.into(), ratings: ctx.nums.label.clone(), requests, common, total, removed, error })
}

/// How a series of explorer requests is going.
#[derive(Default)]
pub(crate) struct Fetching {
    pub requests: usize,
    waits: usize,
    /// Why it stopped (then no more requests).
    pub error: Option<String>,
}

/// Fetch these positions from the Lichess explorer (one at a time, with a
/// pause between; after a 429 one minute's wait, then the caller asks again)
/// and store them. Progress goes out as "relevance-progress" with `color`/`family`.
pub(crate) async fn fetch(app: &AppHandle, nums: &mut Numbers, needed: Vec<(String, String)>, f: &mut Fetching, color: &str, family: &str) -> Result<(), String> {
    let Some(token) = nums.token.clone() else { return Ok(()) };
    let explorer = app.state::<Explorer>();
    for (key, fen) in needed {
        if f.requests >= MAX_REQUESTS || f.error.is_some() {
            break;
        }
        if f.requests > 0 {
            let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(GAP_MS))).await;
        }
        let data = match explorer.fetch(&fen, &token, &nums.ratings).await {
            Ok(d) => d,
            Err(FetchError::RateLimited) if f.waits < MAX_WAITS => {
                f.waits += 1;
                let _ = app.emit("relevance-progress", ProgressEvent { color, family, done: f.requests, waiting: true });
                let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_secs(62))).await;
                break;
            }
            Err(e) => {
                f.error = Some(e.message());
                break;
            }
        };
        f.requests += 1;
        let counts = Counts::of(&data);
        let json = serde_json::to_string(&counts).map_err(|e| e.to_string())?;
        let cache_key = format!("{}{key}", cache_prefix(&nums.label));
        with_db(app, |db| db.set_explorer_cache(&cache_key, &json, now_ms()))?;
        nums.counts.insert(key, counts);
        let _ = app.emit("relevance-progress", ProgressEvent { color, family, done: f.requests, waiting: false });
    }
    Ok(())
}

/// Save the result; the first time all numbers are there, take the rare lines
/// out of the flashcards that were only just started (box 1–2). Returns how many.
fn store(db: &Db, ctx: &Context, lines: HashMap<String, LineRel>, complete: bool) -> Result<usize, String> {
    let has_numbers = ctx.nums.token.is_some() || ctx.previous.as_ref().is_some_and(|p| !p.ratings.is_empty());
    let mut rel = Relevance {
        ratings: if has_numbers { ctx.nums.label.clone() } else { String::new() },
        complete,
        cleaned: ctx.previous.as_ref().is_some_and(|p| p.cleaned),
        lines,
    };
    let mut removed = 0;
    if complete && !rel.cleaned {
        let progress = db.opening_progress(&ctx.color)?;
        let rare: Vec<String> = rel
            .lines
            .iter()
            .filter(|(id, r)| !r.common() && progress.get(*id).is_some_and(|p| p.box_ <= 2))
            .map(|(id, _)| id.clone())
            .collect();
        removed = db.reset_opening_progress(&rare, &ctx.color)?;
        rel.cleaned = true;
    }
    db.set_opening_relevance(&ctx.color, &ctx.family, &serde_json::to_string(&rel).map_err(|e| e.to_string())?, now_ms())?;
    Ok(removed)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openings;

    fn counts(moves: &[(&str, u64)]) -> Counts {
        Counts { total: moves.iter().map(|(_, n)| n).sum(), moves: moves.iter().map(|(u, n)| (u.to_string(), *n)).collect() }
    }

    fn line(id: &str, moves: &str) -> Line {
        Line { id: id.into(), eco: "B10".into(), name: id.into(), family: "Test".into(), moves: moves.split(' ').map(String::from).collect() }
    }

    fn key(moves: &str) -> String {
        let mut pos = Chess::default();
        for u in moves.split_whitespace() {
            let m = u.parse::<UciMove>().unwrap().to_move(&pos).unwrap();
            pos.play_unchecked(m);
        }
        openings::epd(&pos)
    }

    #[test]
    fn reach_follows_opponent_shares_and_stops_below_threshold() {
        let base = line("base", "e2e4 c7c6");
        let main = line("main", "e2e4 c7c6 d2d4 d7d5");
        let rare = line("rare", "e2e4 c7c6 f1c4 d7d5");
        let deep = line("deep", "e2e4 c7c6 f1c4 d7d5 c4b3 d5e4");
        let lines = vec![&base, &main, &rare, &deep];
        let mut c = HashMap::new();
        let (_, needed) = evaluate(&lines, "black", &c, &HashSet::new());
        assert_eq!(needed.len(), 1, "first the position after the defining moves");
        c.insert(key("e2e4 c7c6"), counts(&[("d2d4", 80), ("f1c4", 2), ("b1c3", 18)]));
        c.insert(key("e2e4 c7c6 d2d4"), counts(&[("d7d5", 95), ("g7g6", 5)]));
        let (rel, needed) = evaluate(&lines, "black", &c, &HashSet::new());
        assert!(needed.is_empty(), "nothing below a rare line is fetched: {needed:?}");
        assert!(rel["main"].common() && (rel["main"].reach.unwrap() - 0.8).abs() < 1e-9);
        assert!(!rel["rare"].common() && !rel["deep"].common());
        assert!(rel["base"].common());
    }

    #[test]
    fn rare_own_moves_and_own_games() {
        let base = line("base", "e2e4 c7c6");
        let odd = line("odd", "e2e4 c7c6 d2d4 a7a5");
        let lines = vec![&base, &odd];
        let mut c = HashMap::new();
        c.insert(key("e2e4 c7c6"), counts(&[("d2d4", 100)]));
        c.insert(key("e2e4 c7c6 d2d4"), counts(&[("d7d5", 95), ("a7a5", 1), ("g7g6", 4)]));
        let (rel, _) = evaluate(&lines, "black", &c, &HashSet::new());
        assert!(!rel["odd"].common(), "hardly anyone plays …a5");
        assert!((rel["odd"].reach.unwrap() - 1.0 / 95.0).abs() < 1e-9, "own moves count relative to the usual one");
        let own: HashSet<_> = [(key("e2e4 c7c6"), "d2d4".to_string()), (key("e2e4 c7c6 d2d4"), "a7a5".to_string())].into();
        let (rel, _) = evaluate(&lines, "black", &c, &own);
        assert!(rel["odd"].common() && rel["odd"].in_games, "but you played it");
    }

    #[test]
    fn cached_answers_are_found_again() {
        let db = Db::in_memory();
        let label = explorer::label(&[1600, 1800]);
        assert!(label.contains('–'), "the label has a multi-byte dash: {label}");
        let c = counts(&[("d2d4", 3)]);
        db.set_explorer_cache(&format!("{}{}", cache_prefix(&label), key("e2e4 c7c6")), &serde_json::to_string(&c).unwrap(), 0).unwrap();
        db.set_explorer_cache(&format!("{}{}", cache_prefix("1400–1800"), key("e2e4")), "{}", 0).unwrap();
        let rows = db.explorer_cache(&cache_prefix(&label)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(&rows[0].0[cache_prefix(&label).len()..], key("e2e4 c7c6"));
    }

    #[test]
    fn unknown_lines_count_as_common() {
        let r = Relevance::default();
        assert!(r.common("anything") && is_common(None, "x"));
        let l = LineRel { reach: None, in_games: false };
        assert!(l.common());
    }

    #[test]
    fn cleanup_removes_only_fresh_rare_lines_once() {
        let db = Db::in_memory();
        let p = |box_| crate::db::LineProgress { box_, due: 0, attempts: 1, successes: 1 };
        db.set_opening_progress("rare-new", "black", &p(1)).unwrap();
        db.set_opening_progress("rare-known", "black", &p(4)).unwrap();
        db.set_opening_progress("main", "black", &p(1)).unwrap();
        let lines: HashMap<String, LineRel> = [
            ("rare-new".to_string(), LineRel { reach: Some(0.01), in_games: false }),
            ("rare-known".to_string(), LineRel { reach: Some(0.01), in_games: false }),
            ("main".to_string(), LineRel { reach: Some(0.5), in_games: false }),
        ]
        .into();
        let ctx = |previous| Context {
            color: "black".into(),
            family: "Test".into(),
            nums: Numbers { token: Some("t".into()), ratings: vec![1600], label: "1600–1800".into(), counts: HashMap::new() },
            own: HashSet::new(),
            previous,
        };
        assert_eq!(store(&db, &ctx(None), lines.clone(), true).unwrap(), 1);
        let left = db.opening_progress("black").unwrap();
        assert!(left.contains_key("rare-known") && left.contains_key("main") && !left.contains_key("rare-new"));
        db.set_opening_progress("rare-new", "black", &p(1)).unwrap();
        assert_eq!(store(&db, &ctx(get(&db, "black", "Test")), lines, true).unwrap(), 0, "only once");
        assert!(get(&db, "black", "Test").unwrap().cleaned);
    }
}
