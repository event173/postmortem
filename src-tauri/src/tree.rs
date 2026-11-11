//! Your repertoire as a tree: for every position in which you are to move,
//! the one move you play (`rep_moves`). The tree is what follows from that –
//! your move, then the opponent's replies (the ones that come up at your level,
//! from the Lichess numbers, plus the ones you have answers for), then your
//! move again. Openings are just parts of the same tree.
//!
//! Each of your moves is one flashcard (`opening_progress` as "m:<epd>"):
//! the trainer plays the moves before it and asks only for this one.
//!
//! A reply that comes up in at least `MIN_REACH` of the games reaching the
//! root but has no answer yet is a *gap*; *coverage* is the share of those
//! games your repertoire answers.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use shakmaty::{san::San, uci::UciMove, CastlingMode, Chess, Color, Move, Position};
use tauri::AppHandle;

use crate::analysis::{Class, MoveReview};
use crate::db::{Account, Db, LineProgress};
use crate::lichess::GameInfo;
use crate::openings::{self, epd, family_of};
use crate::relevance::{self, Counts, Fetching, Numbers, MIN_REACH};

/// Flashcard id prefix of a repertoire move.
pub const PREFIX: &str = "m:";
/// The tree isn't followed deeper than this.
const MAX_PLIES: usize = 40;
/// Setting: up to which move (full moves) gaps and coverage count; "0" = no limit.
const DEPTH_KEY: &str = "rep_depth";
pub const DEFAULT_DEPTH: usize = 12;

/// Up to which move gaps count (full moves, 0 = no limit).
pub fn depth(db: &Db) -> usize {
    db.setting(DEPTH_KEY).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_DEPTH)
}

pub fn set_depth(db: &Db, moves: usize) -> Result<(), String> {
    db.set_setting(DEPTH_KEY, Some(&moves.to_string()))
}

/// Plies before the opponent's move from which on only your own moves count.
fn depth_plies(moves: usize) -> usize {
    if moves == 0 { MAX_PLIES } else { (moves * 2).min(MAX_PLIES) }
}
const MAX_SUGGESTIONS: usize = 4;
/// Other moves in one of your positions worth a mention (share of games).
const ALT_SHARE: f64 = 0.05;
/// Learned lines were turned into repertoire moves (once).
const MIGRATED_KEY: &str = "rep_tree_v1";
/// Copy of the database before that, in the data folder.
pub const BACKUP_FILE: &str = "postmortem-vor-repertoire.db";
const MINUTE: i64 = 60 * 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepMove {
    pub color: String,
    /// Position before the move.
    pub epd: String,
    pub uci: String,
    pub san: String,
    /// UCI moves from the start to the position (one way there).
    pub path: Vec<String>,
    /// "line" (from a learned line), "course" (learned since), "manual".
    pub source: String,
    pub added_at: i64,
    /// Your short idea behind the move (shown after its card).
    #[serde(default)]
    pub note: String,
}

pub fn card_id(epd: &str) -> String {
    format!("{PREFIX}{epd}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn side(color: &str) -> Color {
    if color == "white" { Color::White } else { Color::Black }
}

fn parse(pos: &Chess, uci: &str) -> Option<Move> {
    uci.parse::<UciMove>().ok()?.to_move(pos).ok()
}

/// "12. Nf3" / "12…Nf6" – a move with its number; `ply` = moves played before it.
fn numbered(ply: usize, san: &str) -> String {
    let n = ply / 2 + 1;
    if ply.is_multiple_of(2) { format!("{n}. {san}") } else { format!("{n}…{san}") }
}

/// Add your moves of a line to the repertoire: in each of your positions
/// that has no move yet. A position where you already play something else
/// keeps it. With `progress`, a move whose card is new (or worse) takes it.
/// Returns how many moves were added.
pub fn add_line(db: &Db, color: &str, moves: &[String], source: &str, progress: Option<LineProgress>) -> Result<usize, String> {
    let me = side(color);
    let mut have = db.rep_moves(color)?;
    let cards = db.opening_progress(color)?;
    let mut pos = Chess::default();
    let mut path: Vec<String> = Vec::new();
    let mut added = 0;
    for uci in moves {
        let Some(m) = parse(&pos, uci) else { break };
        if pos.turn() == me {
            let key = epd(&pos);
            let mine = match have.get(&key) {
                None => {
                    let rm = RepMove {
                        color: color.to_string(),
                        epd: key.clone(),
                        uci: uci.clone(),
                        san: San::from_move(&pos, m).to_string(),
                        path: path.clone(),
                        source: source.to_string(),
                        added_at: now_ms(),
                        note: String::new(),
                    };
                    db.set_rep_move(&rm)?;
                    have.insert(key.clone(), rm);
                    added += 1;
                    true
                }
                // You play something else here: the rest of the line isn't yours.
                Some(x) if x.uci != *uci => break,
                Some(_) => true,
            };
            if let (true, Some(p)) = (mine, progress) {
                let id = card_id(&key);
                if cards.get(&id).is_none_or(|c| c.box_ < p.box_) {
                    db.set_opening_progress(&id, color, &p)?;
                }
            }
        }
        path.push(uci.clone());
        pos.play_unchecked(m);
    }
    Ok(added)
}

/// Once: turn the lines you've learned into repertoire moves – best known
/// lines first, so where two lines disagree on your move, the one that sits
/// better wins; each move takes the box of its best line. Before that, a copy
/// of the database goes to `BACKUP_FILE` in `dir`. Returns the moves added.
pub fn migrate(db: &Db, dir: &std::path::Path) -> Result<usize, String> {
    if db.setting(MIGRATED_KEY)?.is_some() {
        return Ok(0);
    }
    let lines: HashMap<&str, &openings::Line> = openings::lines().iter().map(|l| (l.id.as_str(), l)).collect();
    let mut todo: Vec<(&str, &openings::Line, LineProgress)> = Vec::new();
    for color in ["white", "black"] {
        for (id, p) in db.opening_progress(color)? {
            if let Some(line) = lines.get(id.as_str()) {
                todo.push((color, line, p));
            }
        }
    }
    let backup = dir.join(BACKUP_FILE);
    if !todo.is_empty() && !backup.exists() {
        db.copy_to(&backup)?;
    }
    todo.sort_by(|a, b| b.2.box_.cmp(&a.2.box_).then_with(|| a.1.id.cmp(&b.1.id)));
    let mut added = 0;
    for (color, line, p) in todo {
        let mut moves = line.moves.clone();
        moves.extend(db.line_extension(&line.id)?.unwrap_or_default());
        added += add_line(db, color, &moves, "line", Some(p))?;
    }
    db.set_setting(MIGRATED_KEY, Some("1"))?;
    Ok(added)
}

/// Name of the deepest named position on the way to and after the move.
pub fn opening_of(m: &RepMove) -> Option<String> {
    let mut pos = Chess::default();
    let mut name = None;
    for uci in m.path.iter().chain(std::iter::once(&m.uci)) {
        let mv = parse(&pos, uci)?;
        pos.play_unchecked(mv);
        if let Some(n) = openings::name_at(&pos) {
            name = Some(n);
        }
    }
    name
}

/// Your moves and their cards for one colour, as (move, progress).
pub fn cards(db: &Db, color: &str) -> Result<Vec<(RepMove, Option<LineProgress>)>, String> {
    let progress = db.opening_progress(color)?;
    let mut out: Vec<(RepMove, Option<LineProgress>)> =
        db.rep_moves(color)?.into_values().map(|m| {
            let p = progress.get(&card_id(&m.epd)).copied();
            (m, p)
        }).collect();
    out.sort_by(|a, b| a.0.path.len().cmp(&b.0.path.len()).then_with(|| a.0.epd.cmp(&b.0.epd)));
    Ok(out)
}

/// Due moves of one colour (a move without a card is due), oldest first.
pub fn due(db: &Db, color: &str, now: i64) -> Result<Vec<(RepMove, i64)>, String> {
    let mut out: Vec<(RepMove, i64)> = cards(db, color)?
        .into_iter()
        .filter_map(|(m, p)| {
            let at = p.map_or(m.added_at, |p| p.due);
            (at <= now).then_some((m, at))
        })
        .collect();
    out.sort_by_key(|(m, at)| (*at, m.path.len()));
    Ok(out)
}

/// How many moves are due now, and when the next one comes back.
pub fn due_summary(db: &Db, color: &str, now: i64) -> Result<(usize, Option<i64>), String> {
    let mut due = 0;
    let mut next = None;
    for (m, p) in cards(db, color)? {
        let at = p.map_or(m.added_at, |p| p.due);
        if at <= now {
            due += 1;
        } else {
            next = Some(next.map_or(at, |n: i64| n.min(at)));
        }
    }
    Ok((due, next))
}

/// Your move in a position (replacing nothing: only where you have none yet).
/// Its card is new and due right away.
pub fn set_move(db: &Db, color: &str, path: &[String], uci: &str) -> Result<RepMove, String> {
    let mut pos = Chess::default();
    for u in path {
        let m = parse(&pos, u).ok_or_else(|| format!("illegal move {u}"))?;
        pos.play_unchecked(m);
    }
    if pos.turn() != side(color) {
        return Err("not your move here".into());
    }
    let m = parse(&pos, uci).ok_or_else(|| format!("illegal move {uci}"))?;
    let key = epd(&pos);
    if let Some(have) = db.rep_moves(color)?.remove(&key) {
        return Ok(have);
    }
    let rm = RepMove {
        color: color.to_string(),
        epd: key.clone(),
        uci: uci.to_string(),
        san: San::from_move(&pos, m).to_string(),
        path: path.to_vec(),
        source: "manual".into(),
        added_at: now_ms(),
        note: String::new(),
    };
    db.set_rep_move(&rm)?;
    let now = now_ms();
    db.set_opening_progress(&card_id(&key), color, &LineProgress { box_: 0, due: now, attempts: 0, successes: 0 })?;
    Ok(rm)
}

/// The position after `path`, checked to be one where `color` is to move.
fn own_position(color: &str, path: &[String]) -> Result<Chess, String> {
    let mut pos = Chess::default();
    for u in path {
        let m = parse(&pos, u).ok_or_else(|| format!("illegal move {u}"))?;
        pos.play_unchecked(m);
    }
    if pos.turn() != side(color) {
        return Err("not your move here".into());
    }
    Ok(pos)
}

/// Your positions the tree reaches: from the start, your move in each of your
/// positions, any reply of the opponent that leads to one of them.
fn reachable(color: &str, moves: &HashMap<String, RepMove>) -> HashSet<String> {
    let me = side(color);
    let mut seen = HashSet::new();
    let mut stack = vec![Chess::default()];
    while let Some(pos) = stack.pop() {
        if pos.turn() == me {
            let key = epd(&pos);
            let Some(m) = moves.get(&key) else { continue };
            let Some(mv) = parse(&pos, &m.uci) else { continue };
            if !seen.insert(key) {
                continue;
            }
            let mut after = pos;
            after.play_unchecked(mv);
            stack.push(after);
        } else {
            for mv in pos.legal_moves() {
                let mut after = pos.clone();
                after.play_unchecked(mv);
                if moves.contains_key(&epd(&after)) {
                    stack.push(after);
                }
            }
        }
    }
    seen
}

/// Moves the tree no longer reaches (they followed a move you don't play any more).
fn orphans(color: &str, moves: &HashMap<String, RepMove>) -> Vec<String> {
    let r = reachable(color, moves);
    let mut out: Vec<String> = moves.keys().filter(|k| !r.contains(*k)).cloned().collect();
    out.sort();
    out
}

/// What a change removed, to put it back ("Rückgängig").
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub color: String,
    /// Positions whose moves the change added (taken out again first).
    pub added: Vec<String>,
    pub moves: Vec<RepMove>,
    pub cards: Vec<(String, LineProgress)>,
}

/// A change to the repertoire: how many moves go, and how to undo it (not for a dry run).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub count: usize,
    pub undo: Option<Snapshot>,
}

/// Your moves in these positions with their cards, as they are now.
fn snapshot(db: &Db, color: &str, epds: &[String], added: Vec<String>) -> Result<Snapshot, String> {
    let moves = db.rep_moves(color)?;
    let progress = db.opening_progress(color)?;
    Ok(Snapshot {
        color: color.to_string(),
        added,
        moves: epds.iter().filter_map(|e| moves.get(e).cloned()).collect(),
        cards: epds.iter().filter_map(|e| progress.get(&card_id(e)).map(|p| (card_id(e), *p))).collect(),
    })
}

/// Put back what a change removed.
pub fn restore(db: &Db, s: &Snapshot) -> Result<(), String> {
    db.delete_rep_moves(&s.color, &s.added)?;
    for m in &s.moves {
        db.set_rep_move(m)?;
        if !m.note.is_empty() {
            db.set_rep_note(&s.color, &m.epd, &m.note)?;
        }
    }
    for (id, p) in &s.cards {
        db.set_opening_progress(id, &s.color, p)?;
    }
    Ok(())
}

/// What adding a line by hand did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub added: usize,
    /// Where the line leaves your repertoire: your move there (numbered SAN).
    pub conflict: Option<String>,
}

/// Your moves of a line played on the board ("Erkunden") into the repertoire,
/// each a new card – up to where you already play something else.
pub fn add_manual(db: &Db, color: &str, moves: &[String]) -> Result<Added, String> {
    let have = db.rep_moves(color)?;
    let me = side(color);
    let mut pos = Chess::default();
    let mut conflict = None;
    for (i, uci) in moves.iter().enumerate() {
        let Some(m) = parse(&pos, uci) else { break };
        if pos.turn() == me
            && let Some(x) = have.get(&epd(&pos))
            && x.uci != *uci
        {
            conflict = Some(numbered(i, &x.san));
            break;
        }
        pos.play_unchecked(m);
    }
    let now = now_ms();
    let added = add_line(db, color, moves, "manual", Some(LineProgress { box_: 0, due: now, attempts: 0, successes: 0 }))?;
    Ok(Added { added, conflict })
}

/// Play another move in a position: the new one gets a new card, the moves
/// that only followed the old one go. Returns how many go (`dry`: only counts).
pub fn change_move(db: &Db, color: &str, path: &[String], uci: &str, dry: bool) -> Result<Changed, String> {
    let pos = own_position(color, path)?;
    let m = parse(&pos, uci).ok_or_else(|| format!("illegal move {uci}"))?;
    let key = epd(&pos);
    let mut moves = db.rep_moves(color)?;
    if moves.get(&key).is_some_and(|o| o.uci == uci) {
        return Ok(Changed { count: 0, undo: None });
    }
    let rm = RepMove {
        color: color.to_string(),
        epd: key.clone(),
        uci: uci.to_string(),
        san: San::from_move(&pos, m).to_string(),
        path: path.to_vec(),
        source: "manual".into(),
        added_at: now_ms(),
        note: String::new(),
    };
    moves.insert(key.clone(), rm.clone());
    let gone = orphans(color, &moves);
    let mut undo = None;
    if !dry {
        let mut touched = gone.clone();
        touched.push(key.clone());
        undo = Some(snapshot(db, color, &touched, vec![key.clone()])?);
        db.delete_rep_moves(color, &gone)?;
        db.delete_rep_moves(color, std::slice::from_ref(&key))?;
        db.set_rep_move(&rm)?;
        db.set_opening_progress(&card_id(&key), color, &LineProgress { box_: 0, due: rm.added_at, attempts: 0, successes: 0 })?;
    }
    Ok(Changed { count: gone.len(), undo })
}

/// Remove your move in a position and everything that only follows from it.
/// Returns how many moves go (`dry`: only counts).
pub fn delete_move(db: &Db, color: &str, path: &[String], dry: bool) -> Result<Changed, String> {
    let key = epd(&own_position(color, path)?);
    let mut moves = db.rep_moves(color)?;
    if moves.remove(&key).is_none() {
        return Ok(Changed { count: 0, undo: None });
    }
    let mut gone = orphans(color, &moves);
    gone.push(key);
    remove(db, color, gone, dry)
}

/// Take these moves out (unless `dry`), keeping what's needed to undo it.
fn remove(db: &Db, color: &str, gone: Vec<String>, dry: bool) -> Result<Changed, String> {
    if dry {
        return Ok(Changed { count: gone.len(), undo: None });
    }
    let undo = snapshot(db, color, &gone, vec![])?;
    db.delete_rep_moves(color, &gone)?;
    Ok(Changed { count: gone.len(), undo: Some(undo) })
}

/// Remove the moves of one opening (and what only follows from them).
/// Returns how many go (`dry`: only counts).
pub fn delete_family(db: &Db, color: &str, family: &str, dry: bool) -> Result<Changed, String> {
    let mut moves = db.rep_moves(color)?;
    let mut gone: Vec<String> = moves.values().filter(|m| family_of_move(m).as_deref() == Some(family)).map(|m| m.epd.clone()).collect();
    for k in &gone {
        moves.remove(k);
    }
    gone.extend(orphans(color, &moves));
    remove(db, color, gone, dry)
}

// ---------------------------------------------------------------------------
// your games against your repertoire

/// One of your games where it left your repertoire.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deviation {
    pub color: String,
    /// "deviation": you played another move than yours; "gap": the opponent
    /// played something you have no answer for.
    pub kind: String,
    /// Your position (EPD) and the moves to it.
    pub epd: String,
    pub path: Vec<String>,
    /// What you played there (numbered SAN), if the game went on.
    pub played: Option<String>,
    pub played_uci: Option<String>,
    /// Your repertoire move there (numbered SAN); none at a gap.
    pub mine: Option<String>,
    /// The opponent's move before (numbered SAN).
    pub opp: Option<String>,
    pub game_id: String,
    /// Plies played before your move.
    pub ply: usize,
    pub created_at: i64,
    /// The game was played after the move (or the move before the gap) was in your repertoire.
    pub since: bool,
    pub opening: Option<String>,
    pub family: Option<String>,
}

/// What else the tree knows about your moves: your games and Stockfish's verdicts.
#[derive(Debug, Default)]
pub struct Context {
    pub games: GameCheck,
    /// By `eval_key`.
    pub evals: HashMap<String, MoveReview>,
}

pub fn eval_key(epd: &str, uci: &str) -> String {
    format!("{epd}|{uci}")
}

/// Stockfish's verdict on one of your moves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub class: Class,
    /// Stockfish's move instead (numbered SAN), if another.
    pub best: Option<String>,
    pub best_uci: Option<String>,
    /// Worth changing: a mistake, or an inaccuracy outside theory.
    pub weak: bool,
}

fn verdict(r: &MoveReview, ply: usize, book: bool) -> Verdict {
    let other = r.best_uci.as_deref().is_some_and(|b| b != r.uci);
    let weak = other && (matches!(r.classification, Class::Mistake | Class::Miss | Class::Blunder) || (r.classification == Class::Inaccuracy && !book));
    Verdict {
        class: r.classification,
        best: if other { r.best_san.as_deref().map(|s| numbered(ply, s)) } else { None },
        best_uci: if other { r.best_uci.clone() } else { None },
        weak,
    }
}

/// Your games walked along your repertoire (one colour).
#[derive(Debug, Default)]
pub struct GameCheck {
    /// How often each of your positions came up in your games, on the way of your repertoire.
    pub reached: HashMap<String, u32>,
    /// Where games left it, newest games first.
    pub deviations: Vec<Deviation>,
    /// Per game in your repertoire: when it was played and how many of your
    /// repertoire moves you played before it left (for `progress`).
    pub stays: Vec<(i64, usize)>,
}

/// Follow your games as long as they stay in your repertoire.
pub fn check_games(games: &[GameInfo], accounts: &[Account], color: &str, moves: &HashMap<String, RepMove>) -> GameCheck {
    let mut out = GameCheck::default();
    if moves.is_empty() {
        return out;
    }
    let me = side(color);
    for g in games {
        if crate::repertoire::my_color(g, accounts) != Some(color) {
            continue;
        }
        let mut pos = Chess::default();
        let mut path: Vec<String> = Vec::new();
        let mut opp: Option<String> = None;
        // When the last repertoire move on the way came in.
        let mut since: i64 = 0;
        // Your repertoire moves played; None: the game isn't in your repertoire at all.
        let mut stay: Option<usize> = Some(0);
        for (i, san) in g.moves.iter().enumerate().take(MAX_PLIES) {
            let Some(m) = san.parse::<San>().ok().and_then(|s| s.to_move(&pos).ok()) else { break };
            let uci = UciMove::from_move(m, CastlingMode::Standard).to_string();
            if pos.turn() == me {
                let key = epd(&pos);
                let mine = moves.get(&key);
                if mine.is_none() && path.is_empty() {
                    // Nothing for the first move (as White): not your repertoire.
                    stay = None;
                    break;
                }
                *out.reached.entry(key.clone()).or_default() += 1;
                if mine.is_some_and(|r| r.uci == uci) {
                    since = since.max(mine.map_or(0, |r| r.added_at));
                    stay = stay.map(|n| n + 1);
                } else {
                    let name = mine.and_then(opening_of).or_else(|| path_opening(&path));
                    out.deviations.push(Deviation {
                        color: color.to_string(),
                        kind: if mine.is_some() { "deviation" } else { "gap" }.into(),
                        epd: key,
                        path: path.clone(),
                        played: Some(numbered(i, &San::from_move(&pos, m).to_string())),
                        played_uci: Some(uci),
                        mine: mine.map(|r| numbered(i, &r.san)),
                        opp: opp.clone(),
                        game_id: g.id.clone(),
                        ply: i,
                        created_at: g.created_at,
                        since: g.created_at > mine.map_or(since, |r| r.added_at),
                        family: name.as_deref().map(|n| family_of(n).to_string()),
                        opening: name,
                    });
                    break;
                }
            } else {
                opp = Some(numbered(i, &San::from_move(&pos, m).to_string()));
            }
            path.push(uci);
            pos.play_unchecked(m);
        }
        if let Some(n) = stay {
            out.stays.push((g.created_at, n));
        }
    }
    out.deviations.sort_by_key(|d| std::cmp::Reverse(d.created_at));
    out
}

/// How long your games stay in your repertoire: the average number of your
/// repertoire moves played in your last games, and in the ones before.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub recent: Option<f64>,
    pub before: Option<f64>,
    /// Games in each window.
    pub window: usize,
    pub games: usize,
}

const PROGRESS_WINDOW: usize = 20;

pub fn progress(db: &Db, accounts: &[Account]) -> Result<Progress, String> {
    let mut stays: Vec<(i64, usize)> = check_all(db, accounts)?.into_values().flat_map(|c| c.stays).collect();
    stays.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    Ok(progress_of(&stays))
}

fn progress_of(stays: &[(i64, usize)]) -> Progress {
    let avg = |xs: &[(i64, usize)]| (!xs.is_empty()).then(|| xs.iter().map(|(_, n)| *n as f64).sum::<f64>() / xs.len() as f64);
    let recent = &stays[..stays.len().min(PROGRESS_WINDOW)];
    let older = stays.get(PROGRESS_WINDOW..(2 * PROGRESS_WINDOW).min(stays.len())).unwrap_or(&[]);
    Progress {
        recent: avg(recent),
        // Only a comparison with enough games behind it.
        before: if older.len() >= PROGRESS_WINDOW / 2 { avg(older) } else { None },
        window: PROGRESS_WINDOW,
        games: stays.len(),
    }
}

/// Setting: compare only serious games with your repertoire (no bots, no bullet); on unless "0".
const SERIOUS_KEY: &str = "rep_serious_only";

pub fn serious_only(db: &Db) -> bool {
    db.setting(SERIOUS_KEY).ok().flatten().as_deref() != Some("0")
}

pub fn set_serious_only(db: &Db, on: bool) -> Result<(), String> {
    db.set_setting(SERIOUS_KEY, Some(if on { "1" } else { "0" }))
}

/// A game worth comparing with your repertoire: not against a bot, not bullet.
fn serious(g: &GameInfo) -> bool {
    g.source != crate::lichess::Source::Local && !matches!(g.speed.as_str(), "bullet" | "ultraBullet" | "bot")
}

/// Name of the deepest named position along a path.
fn path_opening(path: &[String]) -> Option<String> {
    let mut pos = Chess::default();
    let mut name = None;
    for u in path {
        let m = parse(&pos, u)?;
        pos.play_unchecked(m);
        if let Some(n) = openings::name_at(&pos) {
            name = Some(n);
        }
    }
    name
}

/// Your games for comparing with your repertoire (only serious ones, if set).
fn games_of(db: &Db, accounts: &[Account]) -> Result<Vec<GameInfo>, String> {
    let only = serious_only(db);
    Ok(db.games_of(accounts, 1_000_000)?.into_iter().map(|g| g.game).filter(|g| !only || serious(g)).collect())
}

/// Your games walked along both colours of your repertoire.
fn check_all(db: &Db, accounts: &[Account]) -> Result<HashMap<String, GameCheck>, String> {
    let games = games_of(db, accounts)?;
    let mut out = HashMap::new();
    for color in ["white", "black"] {
        out.insert(color.to_string(), check_games(&games, accounts, color, &db.rep_moves(color)?));
    }
    Ok(out)
}

/// New games since the last check: where you played something else than your
/// repertoire move (in a game after it came in), that card is due again –
/// back to box 1. Returns those deviations.
pub fn check_new_games(db: &Db, accounts: &[Account]) -> Result<Vec<Deviation>, String> {
    let checked = db.rep_checked()?;
    let games: Vec<GameInfo> = games_of(db, accounts)?.into_iter().filter(|g| !checked.contains(&g.id)).collect();
    if games.is_empty() {
        return Ok(Vec::new());
    }
    let now = now_ms();
    let mut out = Vec::new();
    for color in ["white", "black"] {
        let moves = db.rep_moves(color)?;
        let progress = db.opening_progress(color)?;
        let mut done = HashSet::new();
        for d in check_games(&games, accounts, color, &moves).deviations {
            if d.kind != "deviation" || !d.since {
                continue;
            }
            if done.insert(d.epd.clone()) {
                let id = card_id(&d.epd);
                let prev = progress.get(&id).copied();
                let p = LineProgress { box_: 1, due: now, attempts: prev.map_or(0, |p| p.attempts), successes: prev.map_or(0, |p| p.successes) };
                db.set_opening_progress(&id, color, &p)?;
            }
            out.push(d);
        }
    }
    let ids: Vec<String> = games.into_iter().map(|g| g.id).collect();
    db.add_rep_checked(&ids, now)?;
    Ok(out)
}

/// Where your games left your repertoire, newest first – one entry per
/// position and move, with how often.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameReport {
    #[serde(flatten)]
    pub latest: Deviation,
    pub times: u32,
}

pub fn deviations(db: &Db, accounts: &[Account], limit: usize) -> Result<Vec<GameReport>, String> {
    let mut all: Vec<Deviation> = check_all(db, accounts)?.into_values().flat_map(|c| c.deviations).collect();
    all.sort_by_key(|d| std::cmp::Reverse(d.created_at));
    let mut out: Vec<GameReport> = Vec::new();
    for d in all {
        // A gap is one entry whatever you played; a deviation one per move.
        let same = |r: &GameReport| r.latest.color == d.color && r.latest.epd == d.epd && (d.kind == "gap" || r.latest.played_uci == d.played_uci);
        if let Some(r) = out.iter_mut().find(|r| same(r)) {
            r.times += 1;
        } else {
            out.push(GameReport { latest: d, times: 1 });
        }
    }
    out.truncate(limit);
    Ok(out)
}

/// Where the tree of an opening starts: its defining moves, without your own
/// last one (so the opening's first node is your defining move).
pub fn root_of(color: &str, family: &str) -> Vec<String> {
    let Some(base) = crate::repertoire::family_lines(color, family).into_iter().min_by_key(|l| l.moves.len()) else {
        return Vec::new();
    };
    let mut moves = base.moves.clone();
    let mine = |i: usize| i.is_multiple_of(2) == (color == "white");
    if !moves.is_empty() && mine(moves.len() - 1) {
        moves.pop();
    }
    moves
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub uci: String,
    /// Numbered SAN.
    pub san: String,
    /// Share of the games here (Lichess), if known.
    pub share: Option<f64>,
    /// A move of the opening theory.
    pub book: bool,
    /// How often you played it here in your games.
    pub games: u32,
}

/// What you played in your games instead of your move (or at a gap).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stray {
    /// Numbered SAN.
    pub played: String,
    pub uci: String,
    pub times: u32,
    /// The newest such game, and the plies before your move.
    pub game_id: String,
    pub ply: usize,
    /// In a game after your move was in the repertoire.
    pub since: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// EPD of the position in which you are to move.
    pub id: String,
    pub parent: Option<String>,
    pub depth: usize,
    /// The opponent's move that leads here (numbered SAN), none at the root.
    pub opp: Option<String>,
    pub opp_uci: Option<String>,
    /// Your move here (numbered SAN), none for a gap.
    pub mine: Option<String>,
    pub mine_uci: Option<String>,
    /// Share of the games reaching the root that get here, if known.
    pub reach: Option<f64>,
    pub box_level: u8,
    pub due: bool,
    pub due_at: i64,
    /// Your card for this move hasn't been practised yet.
    pub is_new: bool,
    /// Position before your move, and after it.
    pub fen: String,
    pub fen_after: Option<String>,
    /// UCI moves from the start to this position.
    pub path: Vec<String>,
    pub gap: bool,
    /// For a gap: moves to choose from.
    pub suggestions: Vec<Suggestion>,
    /// For your move: other moves often played here.
    pub alts: Vec<Suggestion>,
    pub has_children: bool,
    /// Name of the opening here, if the position has one.
    pub opening: Option<String>,
    /// How often this position came up in your games (on the way of your repertoire).
    pub games: u32,
    /// What you played here in your games instead (newest first).
    pub strays: Vec<Stray>,
    /// Your idea behind your move here.
    pub note: String,
    /// For a gap: the theory move to play (the one played most at your level,
    /// else the main line); none outside theory.
    pub recommended: Option<String>,
    /// Stockfish's verdict on your move here, once checked.
    pub verdict: Option<Verdict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeView {
    pub color: String,
    /// UCI moves to the root.
    pub root: Vec<String>,
    /// Pre-order; children by how often they come up.
    pub nodes: Vec<Node>,
    /// Share of the games reaching the root that your repertoire answers (with numbers).
    pub coverage: Option<f64>,
    pub gaps: usize,
    pub cards: usize,
    pub due: usize,
    /// Rating groups of the numbers ("" = none).
    pub ratings: String,
    /// Every position that matters has numbers.
    pub complete: bool,
    /// Why numbers are missing (no token, Lichess error).
    pub error: Option<String>,
    /// Gaps and coverage count up to this move (0 = no limit).
    pub depth: usize,
    /// Your moves Stockfish finds weak, and how many it has checked.
    pub weak: usize,
    pub checked: usize,
}

struct Builder<'a> {
    me: Color,
    moves: &'a HashMap<String, RepMove>,
    counts: &'a HashMap<String, Counts>,
    progress: &'a HashMap<String, LineProgress>,
    ctx: &'a Context,
    /// From this many plies on, only your own moves count (no gaps, no numbers).
    limit: usize,
    now: i64,
    nodes: Vec<Node>,
    seen: HashSet<String>,
    needed: Vec<(String, String)>,
}

impl Builder<'_> {
    fn need(&mut self, pos: &Chess) {
        let key = epd(pos);
        if !self.needed.iter().any(|(k, _)| *k == key) {
            self.needed.push((key, crate::analysis::fen(pos)));
        }
    }

    fn worth(reach: Option<f64>) -> bool {
        reach.is_none_or(|r| r >= MIN_REACH)
    }

    /// Opponent to move in `pos`: their replies – the frequent ones and the
    /// ones you have answers for. Returns the covered share (1 = all fine).
    fn replies(&mut self, pos: &Chess, path: &[String], reach: Option<f64>, parent: Option<&str>, depth: usize) -> f64 {
        if path.len() >= MAX_PLIES {
            return 1.0;
        }
        // Past the depth limit: only where you have moves, and nothing missing counts.
        let deep = path.len() >= self.limit;
        let counts = if deep { None } else { self.counts.get(&epd(pos)) };
        if !deep && counts.is_none() && Self::worth(reach) {
            self.need(pos);
        }
        // (move, share)
        let mut cand: Vec<(Move, String, Option<f64>)> = Vec::new();
        if let Some(c) = counts {
            for (uci, _) in &c.moves {
                let share = c.share(uci);
                if reach.is_none_or(|r| r * share >= MIN_REACH)
                    && let Some(m) = parse(pos, uci)
                {
                    cand.push((m, uci.clone(), Some(share)));
                }
            }
        }
        for m in pos.legal_moves() {
            let uci = UciMove::from_move(m, CastlingMode::Standard).to_string();
            if cand.iter().any(|(_, u, _)| *u == uci) {
                continue;
            }
            let mut after = pos.clone();
            after.play_unchecked(m);
            let k = epd(&after);
            if self.moves.contains_key(&k) || (!deep && self.ctx.games.reached.contains_key(&k)) {
                cand.push((m, uci.clone(), counts.map(|c| c.share(&uci))));
            }
        }
        cand.sort_by(|a, b| b.2.unwrap_or(-1.0).total_cmp(&a.2.unwrap_or(-1.0)).then_with(|| a.1.cmp(&b.1)));
        let mut uncovered = 0.0;
        for (m, uci, share) in cand {
            let san = numbered(path.len(), &San::from_move(pos, m).to_string());
            let mut after = pos.clone();
            after.play_unchecked(m);
            let mut p = path.to_vec();
            p.push(uci.clone());
            let child_reach = reach.zip(share).map(|(r, s)| r * s);
            let covered = self.own(&after, &p, if deep { None } else { child_reach }, Some((san, uci)), parent, depth);
            // Only what comes up often enough counts; the rest is fine either way.
            if let (Some(s), true, false) = (share, child_reach.is_none_or(|r| r >= MIN_REACH), deep) {
                uncovered += s * (1.0 - covered);
            }
        }
        (1.0 - uncovered).max(0.0)
    }

    /// You to move in `pos`: your move (or a gap) and what follows.
    fn own(&mut self, pos: &Chess, path: &[String], reach: Option<f64>, opp: Option<(String, String)>, parent: Option<&str>, depth: usize) -> f64 {
        let key = epd(pos);
        if !self.seen.insert(key.clone()) {
            // Reached again by another move order: shown once.
            return 1.0;
        }
        let counts = self.counts.get(&key);
        let idx = self.nodes.len();
        let mine = self.moves.get(&key).cloned();
        let card = self.progress.get(&card_id(&key)).copied();
        let mut strays: Vec<Stray> = Vec::new();
        for d in self.ctx.games.deviations.iter().filter(|d| d.epd == key) {
            let (Some(played), Some(uci)) = (&d.played, &d.played_uci) else { continue };
            if let Some(s) = strays.iter_mut().find(|s| s.uci == *uci) {
                s.times += 1;
                s.since |= d.since;
            } else {
                strays.push(Stray { played: played.clone(), uci: uci.clone(), times: 1, game_id: d.game_id.clone(), ply: d.ply, since: d.since });
            }
        }
        self.nodes.push(Node {
            id: key.clone(),
            parent: parent.map(String::from),
            depth,
            opp: opp.as_ref().map(|o| o.0.clone()),
            opp_uci: opp.map(|o| o.1),
            mine: mine.as_ref().map(|m| numbered(path.len(), &m.san)),
            mine_uci: mine.as_ref().map(|m| m.uci.clone()),
            reach,
            box_level: card.map_or(0, |c| c.box_),
            due: mine.as_ref().is_some_and(|m| card.map_or(m.added_at, |c| c.due) <= self.now),
            due_at: card.map_or(0, |c| c.due),
            is_new: mine.is_some() && card.is_none_or(|c| c.attempts == 0),
            fen: crate::analysis::fen(pos),
            fen_after: None,
            path: path.to_vec(),
            gap: mine.is_none(),
            suggestions: vec![],
            alts: vec![],
            has_children: false,
            opening: openings::name_at(pos),
            games: self.ctx.games.reached.get(&key).copied().unwrap_or(0),
            strays,
            note: mine.as_ref().map(|m| m.note.clone()).unwrap_or_default(),
            recommended: None,
            verdict: mine.as_ref().and_then(|m| {
                let r = self.ctx.evals.get(&eval_key(&key, &m.uci))?;
                let book = openings::book().next.get(&key).is_some_and(|b| b.contains(&m.uci));
                Some(verdict(r, path.len(), book))
            }),
        });
        let Some(mine) = mine else {
            // A gap: what you could play here.
            if counts.is_none() && Self::worth(reach) {
                self.need(pos);
            }
            let book = openings::book().next.get(&key).cloned().unwrap_or_default();
            let mine_in_games: Vec<(String, u32)> = self.nodes[idx].strays.iter().map(|s| (s.uci.clone(), s.times)).collect();
            let mut ucis: Vec<String> = mine_in_games.iter().map(|(u, _)| u.clone()).collect();
            for (u, _) in counts.map(|c| c.moves.clone()).unwrap_or_default() {
                if !ucis.contains(&u) {
                    ucis.push(u);
                }
            }
            for u in &book {
                if !ucis.contains(u) {
                    ucis.push(u.clone());
                }
            }
            let mut sugg: Vec<Suggestion> = ucis
                .into_iter()
                .filter_map(|u| {
                    let m = parse(pos, &u)?;
                    Some(Suggestion {
                        san: numbered(path.len(), &San::from_move(pos, m).to_string()),
                        share: counts.map(|c| c.share(&u)),
                        book: book.contains(&u),
                        games: mine_in_games.iter().find(|(x, _)| *x == u).map_or(0, |(_, n)| *n),
                        uci: u,
                    })
                })
                .collect();
            // The theory move to play: the one played most at your level, else the main line.
            let recommended = book
                .iter()
                .filter(|u| parse(pos, u).is_some())
                .enumerate()
                .max_by(|(i, a), (j, b)| {
                    let share = |u: &str| counts.map_or(0.0, |c| c.share(u));
                    share(a).total_cmp(&share(b)).then_with(|| j.cmp(i))
                })
                .map(|(_, u)| u.clone());
            // The recommendation first, then what you already play here, then by how often.
            sugg.sort_by(|a, b| {
                (Some(&b.uci) == recommended.as_ref())
                    .cmp(&(Some(&a.uci) == recommended.as_ref()))
                    .then_with(|| (b.games > 0).cmp(&(a.games > 0)))
                    .then_with(|| b.share.unwrap_or(-1.0).total_cmp(&a.share.unwrap_or(-1.0)))
                    .then_with(|| b.book.cmp(&a.book))
            });
            sugg.truncate(MAX_SUGGESTIONS);
            self.nodes[idx].recommended = recommended;
            self.nodes[idx].suggestions = sugg;
            return 0.0;
        };
        let Some(m) = parse(pos, &mine.uci) else { return 1.0 };
        if let Some(c) = counts {
            self.nodes[idx].alts = c
                .moves
                .iter()
                .filter(|(u, _)| *u != mine.uci && c.share(u) >= ALT_SHARE)
                .take(2)
                .filter_map(|(u, _)| {
                    let am = parse(pos, u)?;
                    Some(Suggestion {
                        uci: u.clone(),
                        san: numbered(path.len(), &San::from_move(pos, am).to_string()),
                        share: Some(c.share(u)),
                        book: false,
                        games: 0,
                    })
                })
                .collect();
        }
        let mut after = pos.clone();
        after.play_unchecked(m);
        self.nodes[idx].fen_after = Some(crate::analysis::fen(&after));
        let mut p = path.to_vec();
        p.push(mine.uci.clone());
        let before = self.nodes.len();
        let covered = self.replies(&after, &p, reach, Some(&key), depth + 1);
        self.nodes[idx].has_children = self.nodes.len() > before;
        covered
    }
}

/// The tree from `root` with the numbers at hand, and the positions whose
/// numbers are still missing.
#[allow(clippy::too_many_arguments)]
fn build(
    color: &str,
    root: &[String],
    moves: &HashMap<String, RepMove>,
    counts: &HashMap<String, Counts>,
    progress: &HashMap<String, LineProgress>,
    ctx: &Context,
    depth: usize,
    now: i64,
) -> (Vec<Node>, Option<f64>, Vec<(String, String)>) {
    let mut b = Builder { me: side(color), moves, counts, progress, ctx, limit: depth_plies(depth), now, nodes: vec![], seen: HashSet::new(), needed: vec![] };
    let mut pos = Chess::default();
    let mut path = Vec::new();
    for u in root {
        let Some(m) = parse(&pos, u) else { break };
        pos.play_unchecked(m);
        path.push(u.clone());
    }
    let covered = if pos.turn() == b.me {
        b.own(&pos, &path, Some(1.0), None, None, 0)
    } else {
        b.replies(&pos, &path, Some(1.0), None, 0)
    };
    // Coverage means something only with numbers for the first replies.
    let first_replies = if pos.turn() == b.me {
        moves.get(&epd(&pos)).and_then(|m| parse(&pos, &m.uci)).map(|m| {
            let mut after = pos.clone();
            after.play_unchecked(m);
            epd(&after)
        })
    } else {
        Some(epd(&pos))
    };
    let known = first_replies.is_some_and(|k| counts.contains_key(&k));
    (b.nodes, known.then_some(covered), b.needed)
}

#[allow(clippy::too_many_arguments)]
fn view_of(color: &str, root: Vec<String>, nodes: Vec<Node>, coverage: Option<f64>, nums: &Numbers, complete: bool, error: Option<String>, depth: usize) -> TreeView {
    TreeView {
        depth,
        weak: nodes.iter().filter(|n| n.verdict.as_ref().is_some_and(|v| v.weak)).count(),
        checked: nodes.iter().filter(|n| n.verdict.is_some()).count(),
        color: color.to_string(),
        root,
        coverage: if nums.counts.is_empty() { None } else { coverage },
        gaps: nodes.iter().filter(|n| n.gap).count(),
        cards: nodes.iter().filter(|n| !n.gap).count(),
        due: nodes.iter().filter(|n| n.due).count(),
        nodes,
        ratings: if nums.token.is_some() { nums.label.clone() } else { String::new() },
        complete,
        error,
    }
}

/// An opening of your repertoire in a few numbers (for "Deine Eröffnungen").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub coverage: Option<f64>,
    pub gaps: usize,
    pub cards: usize,
    pub due: usize,
    pub weak: usize,
}

/// Your moves and cards of one colour.
type ColorData = (HashMap<String, RepMove>, HashMap<String, LineProgress>, Context);

/// The summaries of several openings, keyed "color|family" (numbers at hand only).
pub fn summaries(db: &Db, accounts: &[Account], keys: &[(String, String)]) -> Result<HashMap<String, Summary>, String> {
    let nums = relevance::numbers(db, accounts)?;
    let now = now_ms();
    let depth = depth(db);
    let games = games_of(db, accounts)?;
    let evals = db.move_evals()?;
    let mut by_color: HashMap<String, ColorData> = HashMap::new();
    let mut out = HashMap::new();
    for (color, family) in keys {
        if !by_color.contains_key(color) {
            let moves = db.rep_moves(color)?;
            let ctx = Context { games: check_games(&games, accounts, color, &moves), evals: evals.clone() };
            by_color.insert(color.clone(), (moves, db.opening_progress(color)?, ctx));
        }
        let (moves, progress, check) = &by_color[color];
        let (nodes, coverage, _) = build(color, &root_of(color, family), moves, &nums.counts, progress, check, depth, now);
        let v = view_of(color, vec![], nodes, coverage, &nums, true, None, depth);
        out.insert(format!("{color}|{family}"), Summary { coverage: v.coverage, gaps: v.gaps, cards: v.cards, due: v.due, weak: v.weak });
    }
    Ok(out)
}

/// The tree with the numbers already stored (quick).
pub fn view(db: &Db, accounts: &[Account], color: &str, root: Vec<String>) -> Result<TreeView, String> {
    let nums = relevance::numbers(db, accounts)?;
    let moves = db.rep_moves(color)?;
    let progress = db.opening_progress(color)?;
    let check = Context { games: check_games(&games_of(db, accounts)?, accounts, color, &moves), evals: db.move_evals()? };
    let depth = depth(db);
    let (nodes, coverage, needed) = build(color, &root, &moves, &nums.counts, &progress, &check, depth, now_ms());
    let error = nums.token.is_none().then(|| crate::tr!("Ohne Lichess-Schlüssel gibt es keine Häufigkeiten.", "Without a Lichess token there are no frequencies."));
    Ok(view_of(color, root, nodes, coverage, &nums, needed.is_empty(), error, depth))
}

/// The tree after fetching the numbers that are missing (progress as
/// "relevance-progress" with family "repertoire").
pub async fn prepare(app: AppHandle, accounts: Vec<Account>, color: String, root: Vec<String>) -> Result<TreeView, String> {
    let (a, c) = (app.clone(), color.clone());
    let (mut nums, moves, progress, check, depth) = tauri::async_runtime::spawn_blocking(move || {
        relevance::with_db(&a, |db| {
            let moves = db.rep_moves(&c)?;
            let check = Context { games: check_games(&games_of(db, &accounts)?, &accounts, &c, &moves), evals: db.move_evals()? };
            Ok::<_, String>((relevance::numbers(db, &accounts)?, moves, db.opening_progress(&c)?, check, depth(db)))
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut f = Fetching::default();
    loop {
        let (nodes, coverage, needed) = build(&color, &root, &moves, &nums.counts, &progress, &check, depth, now_ms());
        let done = needed.is_empty();
        if done || nums.token.is_none() || f.error.is_some() || f.requests >= MAX_PREPARE {
            let error = if nums.token.is_none() {
                Some(crate::tr!("Ohne Lichess-Schlüssel gibt es keine Häufigkeiten.", "Without a Lichess token there are no frequencies."))
            } else {
                f.error.clone()
            };
            return Ok(view_of(&color, root, nodes, coverage, &nums, done, error, depth));
        }
        relevance::fetch(&app, &mut nums, needed, &mut f, &color, "repertoire").await?;
    }
}

/// Stockfish's depth for checking your moves.
const QUALITY_DEPTH: u32 = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QualityProgress<'a> {
    color: &'a str,
    done: usize,
    total: usize,
}

/// Let Stockfish check your moves from `root` that it hasn't seen yet
/// (progress as "rep-quality-progress"); then the tree again.
pub async fn check_quality(app: AppHandle, accounts: Vec<Account>, color: String, root: Vec<String>) -> Result<TreeView, String> {
    let (a, acc, c, r) = (app.clone(), accounts.clone(), color.clone(), root.clone());
    let v = tauri::async_runtime::spawn_blocking(move || relevance::with_db(&a, |db| view(db, &acc, &c, r)))
        .await
        .map_err(|e| e.to_string())??;
    let todo: Vec<(String, String, String)> = v
        .nodes
        .iter()
        .filter(|n| n.verdict.is_none())
        .filter_map(|n| Some((n.id.clone(), n.fen.clone(), n.mine_uci.clone()?)))
        .collect();
    if !todo.is_empty() {
        let (a, c) = (app.clone(), color.clone());
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            use tauri::Emitter;
            let mut sf = crate::explore::start_engine()?;
            let total = todo.len();
            for (i, (key, fen, uci)) in todo.into_iter().enumerate() {
                let r = crate::explore::evaluate_with(&mut sf, &fen, &uci, QUALITY_DEPTH)?;
                relevance::with_db(&a, |db| db.set_move_eval(&eval_key(&key, &uci), &r, now_ms()))?;
                let _ = a.emit("rep-quality-progress", QualityProgress { color: &c, done: i + 1, total });
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    tauri::async_runtime::spawn_blocking(move || relevance::with_db(&app, |db| view(db, &accounts, &color, root)))
        .await
        .map_err(|e| e.to_string())?
}

/// Safety cap of explorer requests for one tree.
const MAX_PREPARE: usize = 300;

/// Card for a new move from a course: box 1, back in ten minutes (like a line).
pub fn learned_now() -> LineProgress {
    LineProgress { box_: 1, due: now_ms() + 10 * MINUTE, attempts: 1, successes: 1 }
}

/// Opening family of a repertoire move (for "Deine Eröffnungen").
pub fn family_of_move(m: &RepMove) -> Option<String> {
    opening_of(m).map(|n| family_of(&n).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ucis(s: &str) -> Vec<String> {
        let mut pos = Chess::default();
        let mut out = Vec::new();
        for san in s.split_whitespace() {
            let m = san.parse::<San>().unwrap().to_move(&pos).unwrap();
            out.push(UciMove::from_move(m, CastlingMode::Standard).to_string());
            pos.play_unchecked(m);
        }
        out
    }

    fn key(s: &str) -> String {
        let mut pos = Chess::default();
        for u in ucis(s) {
            let m = parse(&pos, &u).unwrap();
            pos.play_unchecked(m);
        }
        epd(&pos)
    }

    fn p(box_: u8) -> LineProgress {
        LineProgress { box_, due: 0, attempts: 1, successes: 1 }
    }

    #[test]
    fn lines_become_your_moves_and_the_better_one_wins() {
        let db = Db::in_memory();
        add_line(&db, "white", &ucis("e4 e5 Nf3 Nc6 Bc4 Bc5 c3"), "line", Some(p(4))).unwrap();
        // Another line plays 4. d3 – your 4. c3 stays.
        let added = add_line(&db, "white", &ucis("e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6"), "line", Some(p(1))).unwrap();
        assert_eq!(added, 0);
        let moves = db.rep_moves("white").unwrap();
        assert_eq!(moves.len(), 4, "e4, Nf3, Bc4, c3");
        let c3 = &moves[&key("e4 e5 Nf3 Nc6 Bc4 Bc5")];
        assert_eq!((c3.san.as_str(), c3.path.len()), ("c3", 6));
        // Shared moves keep the better box.
        let cards = db.opening_progress("white").unwrap();
        assert_eq!(cards[&card_id(&key(""))].box_, 4);
        // A new move from a course: box 1, and it doesn't lower a known one.
        add_line(&db, "white", &ucis("e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5"), "course", Some(learned_now())).unwrap();
        let cards = db.opening_progress("white").unwrap();
        assert_eq!(cards[&card_id(&key("e4 e5 Nf3 Nc6 Bc4 Nf6"))].box_, 1);
        assert_eq!(cards[&card_id(&key(""))].box_, 4);
    }

    #[test]
    fn migration_runs_once_and_keeps_a_backup() {
        let db = Db::in_memory();
        let line = openings::lines().iter().find(|l| l.name == "Caro-Kann Defense: Advance Variation").unwrap();
        db.set_opening_progress(&line.id, "black", &p(3)).unwrap();
        let dir = std::env::temp_dir().join(format!("postmortem-tree-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let n = migrate(&db, &dir).unwrap();
        assert!(n >= 2, "1…c6 and 2…d5 at least: {n}");
        assert!(dir.join(BACKUP_FILE).exists());
        assert_eq!(migrate(&db, &dir).unwrap(), 0, "only once");
        std::fs::remove_dir_all(&dir).unwrap();
        let due = due(&db, "black", i64::MAX).unwrap();
        assert_eq!(due.len(), n);
        assert_eq!(due[0].0.path.len(), 1, "earliest first, then by depth");
    }

    #[test]
    fn set_move_fills_a_gap_with_a_new_card() {
        let db = Db::in_memory();
        assert!(set_move(&db, "black", &ucis("e4"), "e2e4").is_err());
        assert!(set_move(&db, "white", &ucis("e4"), "e7e5").is_err(), "not your move");
        let m = set_move(&db, "black", &ucis("e4"), "c7c6").unwrap();
        assert_eq!(m.san, "c6");
        let (due, _) = due_summary(&db, "black", now_ms() + 1).unwrap();
        assert_eq!(due, 1);
        // Doesn't replace your move.
        assert_eq!(set_move(&db, "black", &ucis("e4"), "e7e5").unwrap().uci, "c7c6");
    }

    fn counts(moves: &[(&str, u64)]) -> Counts {
        Counts { total: moves.iter().map(|(_, n)| n).sum(), moves: moves.iter().map(|(u, n)| (u.to_string(), *n)).collect() }
    }

    #[test]
    fn tree_shows_answers_gaps_and_coverage() {
        let db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5"), "line", Some(p(3))).unwrap();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 exd5 cxd5"), "line", Some(p(2))).unwrap();
        let moves = db.rep_moves("black").unwrap();
        let progress = db.opening_progress("black").unwrap();
        let root = ucis("e4");
        let mut c = HashMap::new();
        // Without numbers: only what you have, no coverage.
        let (nodes, coverage, needed) = build("black", &root, &moves, &c, &progress, &Context::default(), 0, 0);
        assert_eq!(nodes.len(), 4, "c6, d5, Bf5, cxd5");
        assert!(coverage.is_none() && !needed.is_empty());
        assert_eq!(nodes[0].mine.as_deref(), Some("1…c6"));
        assert_eq!(nodes[1].opp.as_deref(), Some("2. d4"));

        c.insert(key("e4 c6"), counts(&[("d2d4", 80), ("b1c3", 15), ("a2a3", 5)]));
        c.insert(key("e4 c6 d4 d5"), counts(&[("e4e5", 50), ("e4d5", 50)]));
        let (nodes, coverage, _) = build("black", &root, &moves, &c, &progress, &Context::default(), 0, 0);
        let gaps: Vec<&Node> = nodes.iter().filter(|n| n.gap).collect();
        assert_eq!(gaps.len(), 2, "2. Nc3 and 2. a3 have no answer: {:?}", nodes.iter().map(|n| (&n.opp, &n.mine)).collect::<Vec<_>>());
        assert_eq!(gaps[0].opp.as_deref(), Some("2. Nc3"));
        assert!((gaps[0].reach.unwrap() - 0.15).abs() < 1e-9);
        assert!(gaps[0].suggestions.iter().any(|s| s.book), "theory suggests something");
        let rec = gaps[0].recommended.as_deref().expect("a theory move");
        assert_eq!(gaps[0].suggestions[0].uci, rec, "the recommendation comes first");
        assert_eq!(rec, "d7d5", "2. Nc3 d5 is the main line");
        assert!((coverage.unwrap() - 0.80).abs() < 1e-9, "{coverage:?}");
        // The node after 2. d4 has children; the leaves don't.
        assert!(nodes.iter().find(|n| n.opp.as_deref() == Some("2. d4")).unwrap().has_children);
    }

    #[test]
    fn past_the_depth_limit_only_your_moves_count() {
        let db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5"), "line", Some(p(3))).unwrap();
        let moves = db.rep_moves("black").unwrap();
        let progress = db.opening_progress("black").unwrap();
        let mut c = HashMap::new();
        c.insert(key("e4 c6"), counts(&[("d2d4", 80), ("b1c3", 20)]));
        c.insert(key("e4 c6 d4 d5"), counts(&[("e4e5", 50), ("e4d5", 50)]));
        let root = ucis("e4");
        let (nodes, coverage, _) = build("black", &root, &moves, &c, &progress, &Context::default(), 0, 0);
        assert_eq!(nodes.iter().filter(|n| n.gap).count(), 2, "2. Nc3 and 3. exd5");
        assert!((coverage.unwrap() - 0.4).abs() < 1e-9, "{coverage:?}");
        // Up to move 2: 3. exd5 doesn't count any more, your 3…Bf5 is still there.
        let (nodes, coverage, needed) = build("black", &root, &moves, &c, &progress, &Context::default(), 2, 0);
        assert_eq!(nodes.iter().filter(|n| n.gap).count(), 1);
        assert!(nodes.iter().any(|n| n.mine.as_deref() == Some("3…Bf5")));
        assert!((coverage.unwrap() - 0.8).abs() < 1e-9, "{coverage:?}");
        assert!(needed.iter().all(|(k, _)| *k != key("e4 c6 d4 d5 e5 Bf5")), "nothing fetched past the limit");
    }

    #[test]
    fn stockfish_verdicts_mark_weak_moves() {
        let db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 f6"), "line", None).unwrap();
        let moves = db.rep_moves("black").unwrap();
        let k = key("e4 c6 d4 d5 e5");
        let review = |uci: &str, class: Class, best: &str| MoveReview {
            uci: uci.into(),
            classification: class,
            ply: 0,
            color: "black".into(),
            san: String::new(),
            win_before: 50.0,
            win_after: 40.0,
            best_san: Some("Bf5".into()),
            best_uci: Some(best.into()),
            best_line: None,
            comment: String::new(),
            comment_en: None,
            comment_other: None,
            comment_other_en: None,
            theme: None,
        };
        let mut evals = HashMap::new();
        evals.insert(eval_key(&k, "f7f6"), review("f7f6", Class::Mistake, "c8f5"));
        evals.insert(eval_key(&key("e4"), "c7c6"), review("c7c6", Class::Inaccuracy, "e7e5"));
        let ctx = Context { games: GameCheck::default(), evals };
        let (nodes, _, _) = build("black", &[], &moves, &HashMap::new(), &HashMap::new(), &ctx, 0, 0);
        let f6 = nodes.iter().find(|n| n.id == k).unwrap().verdict.as_ref().unwrap();
        assert!(f6.weak);
        assert_eq!(f6.best.as_deref(), Some("3…Bf5"));
        let c6 = nodes.iter().find(|n| n.id == key("e4")).unwrap().verdict.as_ref().unwrap();
        assert!(!c6.weak, "an inaccuracy in theory is fine");
    }

    #[test]
    fn a_note_stays_with_its_move() {
        let db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5"), "line", None).unwrap();
        let k = key("e4 c6 d4");
        db.set_rep_note("black", &k, "Zentrum angreifen").unwrap();
        assert_eq!(db.rep_moves("black").unwrap()[&k].note, "Zentrum angreifen");
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5"), "line", None).unwrap();
        assert_eq!(db.rep_moves("black").unwrap()[&k].note, "Zentrum angreifen", "kept when lines come in");
        change_move(&db, "black", &ucis("e4 c6 d4"), "g7g6", false).unwrap();
        assert_eq!(db.rep_moves("black").unwrap()[&k].note, "", "a new move starts without");
        // Undo brings back the old move, its card and its note.
        db.set_rep_note("black", &k, "Fianchetto").unwrap();
        let changed = change_move(&db, "black", &ucis("e4 c6 d4"), "d7d5", false).unwrap();
        assert_eq!(db.rep_moves("black").unwrap()[&k].san, "d5");
        restore(&db, &changed.undo.unwrap()).unwrap();
        let back = &db.rep_moves("black").unwrap()[&k];
        assert_eq!((back.san.as_str(), back.note.as_str()), ("g6", "Fianchetto"));
        assert_eq!(db.opening_progress("black").unwrap()[&card_id(&k)].box_, 0);
    }

    #[test]
    fn a_line_stops_where_you_play_something_else() {
        let db = Db::in_memory();
        add_line(&db, "white", &ucis("e4 e5 Nf3 Nc6 Bc4"), "line", None).unwrap();
        // 3. Bb5 isn't yours: nothing after it comes in.
        add_line(&db, "white", &ucis("e4 e5 Nf3 Nc6 Bb5 a6 Ba4"), "line", None).unwrap();
        assert_eq!(db.rep_moves("white").unwrap().len(), 3);
    }

    #[test]
    fn changing_a_move_drops_what_followed_it() {
        let db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5 Nf3 e6"), "line", Some(p(3))).unwrap();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 exd5 cxd5"), "line", Some(p(3))).unwrap();
        assert_eq!(db.rep_moves("black").unwrap().len(), 5);
        let path = ucis("e4 c6 d4 d5 e5");
        // 3…c5 instead of 3…Bf5: 4…e6 goes with it.
        assert_eq!(change_move(&db, "black", &path, "c6c5", true).unwrap().count, 1);
        assert_eq!(db.rep_moves("black").unwrap().len(), 5, "dry run changes nothing");
        let changed = change_move(&db, "black", &path, "c6c5", false).unwrap();
        assert_eq!(changed.count, 1);
        let moves = db.rep_moves("black").unwrap();
        assert_eq!(moves.len(), 4);
        let k = key("e4 c6 d4 d5 e5");
        assert_eq!(moves[&k].san, "c5");
        let cards = db.opening_progress("black").unwrap();
        assert_eq!(cards[&card_id(&k)].box_, 0, "a new card");
        assert!(!cards.contains_key(&card_id(&key("e4 c6 d4 d5 e5 Bf5 Nf3"))), "its card is gone too");
        // A line by hand stops where you play something else.
        let r = add_manual(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5 Nf3")).unwrap();
        assert_eq!((r.added, r.conflict.as_deref()), (0, Some("3…c5")));
        let r = add_manual(&db, "black", &ucis("e4 c6 d4 d5 exd5 cxd5 c4 Nf6")).unwrap();
        assert_eq!((r.added, r.conflict), (1, None));
        // Same move again: nothing to do.
        assert_eq!(change_move(&db, "black", &path, "c6c5", false).unwrap().count, 0);
    }

    #[test]
    fn deleting_a_move_takes_its_branch() {
        let db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5"), "line", None).unwrap();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 exd5 cxd5"), "line", None).unwrap();
        add_line(&db, "black", &ucis("d4 d5 c4 c6"), "line", None).unwrap();
        // 2…d5 goes, with both answers after it; the d4 lines stay.
        assert_eq!(delete_move(&db, "black", &ucis("e4 c6 d4"), true).unwrap().count, 3);
        let deleted = delete_move(&db, "black", &ucis("e4 c6 d4"), false).unwrap();
        assert_eq!(deleted.count, 3);
        // Undo puts the branch back.
        restore(&db, deleted.undo.as_ref().unwrap()).unwrap();
        assert_eq!(db.rep_moves("black").unwrap().len(), 6);
        delete_move(&db, "black", &ucis("e4 c6 d4"), false).unwrap();
        assert_eq!(db.rep_moves("black").unwrap().len(), 3, "1…c6, 1…d5, 2…c6");
        // A whole opening: the Slav moves.
        assert!(delete_family(&db, "black", "Slav Defense", false).unwrap().count >= 1);
        assert!(db.rep_moves("black").unwrap().contains_key(&key("e4")));
    }

    fn game(id: &str, white: &str, black: &str, sans: &str, at: i64) -> GameInfo {
        serde_json::from_value(serde_json::json!({
            "id": id, "source": "lichess", "white": {"name": white}, "black": {"name": black},
            "winner": null, "status": "mate", "speed": "blitz", "rated": true, "timeControl": null,
            "createdAt": at, "opening": null, "moves": sans.split_whitespace().collect::<Vec<_>>(),
        }))
        .unwrap()
    }

    #[test]
    fn games_show_deviations_and_gaps() {
        let db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5"), "line", Some(p(4))).unwrap();
        let accounts = vec![Account::new(crate::lichess::Source::Lichess, "me")];
        let moves = db.rep_moves("black").unwrap();
        let added = moves.values().map(|m| m.added_at).max().unwrap();
        let games = vec![
            game("a", "x", "me", "e4 c6 d4 d5 e5 c5 c3", added + 10),
            game("b", "x", "me", "e4 c6 Nc3 d5", added - 10),
            game("c", "me", "x", "e4 c6 d4 d5", added + 10),
        ];
        let check = check_games(&games, &accounts, "black", &moves);
        assert_eq!(check.deviations.len(), 2);
        let dev = check.deviations.iter().find(|d| d.kind == "deviation").unwrap();
        assert_eq!((dev.played.as_deref(), dev.mine.as_deref(), dev.since), (Some("3…c5"), Some("3…Bf5"), true));
        let gap = check.deviations.iter().find(|d| d.kind == "gap").unwrap();
        assert_eq!((gap.opp.as_deref(), gap.played.as_deref(), gap.since), (Some("2. Nc3"), Some("2…d5"), false));
        assert_eq!(check.reached[&key("e4")], 2);

        // The gap from your games shows in the tree, with what you played as the first suggestion.
        let (nodes, _, _) = build("black", &ucis("e4"), &moves, &HashMap::new(), &db.opening_progress("black").unwrap(), &Context { games: check, evals: HashMap::new() }, 0, 0);
        let g = nodes.iter().find(|n| n.opp.as_deref() == Some("2. Nc3")).unwrap();
        assert!(g.gap && g.games == 1);
        assert_eq!((g.suggestions[0].san.as_str(), g.suggestions[0].games), ("2…d5", 1));
        let bf5 = nodes.iter().find(|n| n.mine.as_deref() == Some("3…Bf5")).unwrap();
        assert_eq!(bf5.strays.len(), 1);
    }

    #[test]
    fn progress_compares_your_last_games_with_the_ones_before() {
        let stays: Vec<(i64, usize)> = (0..40).map(|i| (100 - i as i64, if i < 20 { 6 } else { 3 })).collect();
        let p = progress_of(&stays);
        assert_eq!((p.recent, p.before, p.games), (Some(6.0), Some(3.0), 40));
        assert_eq!(progress_of(&stays[..25]).before, None, "too few games to compare");
        assert_eq!(progress_of(&[]).recent, None);
    }

    #[test]
    fn games_count_their_repertoire_moves_and_bullet_is_left_out() {
        let db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5"), "line", None).unwrap();
        let moves = db.rep_moves("black").unwrap();
        let accounts = vec![Account::new(crate::lichess::Source::Lichess, "me")];
        let games = vec![game("a", "x", "me", "e4 c6 d4 d5 e5 c5", 2), game("b", "x", "me", "d4 d5", 1)];
        let check = check_games(&games, &accounts, "black", &moves);
        assert_eq!(check.stays, vec![(2, 2), (1, 0)], "c6 and d5; nothing against 1. d4");
        let mut bullet = game("c", "x", "me", "e4 c6", 3);
        bullet.speed = "bullet".into();
        assert!(!serious(&bullet) && serious(&games[0]));
    }

    #[test]
    fn a_new_game_off_your_repertoire_makes_the_card_due() {
        let mut db = Db::in_memory();
        add_line(&db, "black", &ucis("e4 c6 d4 d5 e5 Bf5"), "line", Some(LineProgress { box_: 4, due: i64::MAX, attempts: 4, successes: 4 })).unwrap();
        let accounts = vec![Account::new(crate::lichess::Source::Lichess, "me")];
        let later = now_ms() + 1000;
        db.save_games(&[game("a", "x", "me", "e4 c6 d4 d5 e5 c5 c3", later)]).unwrap();
        let found = check_new_games(&db, &accounts).unwrap();
        assert_eq!(found.len(), 1);
        let card = db.opening_progress("black").unwrap()[&card_id(&key("e4 c6 d4 d5 e5"))];
        assert_eq!(card.box_, 1);
        assert!(card.due <= now_ms());
        assert!(check_new_games(&db, &accounts).unwrap().is_empty(), "each game once");
    }

    #[test]
    fn opening_roots_end_before_your_defining_move() {
        assert_eq!(root_of("black", "Caro-Kann Defense"), ucis("e4"));
        assert_eq!(root_of("white", "Italian Game"), ucis("e4 e5 Nf3 Nc6"));
        assert_eq!(root_of("white", "Caro-Kann Defense"), ucis("e4 c6"));
    }
}

