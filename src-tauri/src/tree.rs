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

use crate::db::{Account, Db, LineProgress};
use crate::openings::{self, epd, family_of};
use crate::relevance::{self, Counts, Fetching, Numbers, MIN_REACH};

/// Flashcard id prefix of a repertoire move.
pub const PREFIX: &str = "m:";
/// The tree isn't followed deeper than this.
const MAX_PLIES: usize = 40;
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
                    };
                    db.set_rep_move(&rm)?;
                    have.insert(key.clone(), rm);
                    added += 1;
                    true
                }
                Some(x) => x.uci == *uci,
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
    };
    db.set_rep_move(&rm)?;
    let now = now_ms();
    db.set_opening_progress(&card_id(&key), color, &LineProgress { box_: 0, due: now, attempts: 0, successes: 0 })?;
    Ok(rm)
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
}

struct Builder<'a> {
    me: Color,
    moves: &'a HashMap<String, RepMove>,
    counts: &'a HashMap<String, Counts>,
    progress: &'a HashMap<String, LineProgress>,
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
        let counts = self.counts.get(&epd(pos));
        if counts.is_none() && Self::worth(reach) {
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
            if self.moves.contains_key(&epd(&after)) {
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
            let covered = self.own(&after, &p, child_reach, Some((san, uci)), parent, depth);
            // Only what comes up often enough counts; the rest is fine either way.
            if let (Some(s), true) = (share, child_reach.is_none_or(|r| r >= MIN_REACH)) {
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
        });
        let Some(mine) = mine else {
            // A gap: what you could play here.
            if counts.is_none() && Self::worth(reach) {
                self.need(pos);
            }
            let book = openings::book().next.get(&key).cloned().unwrap_or_default();
            let mut ucis: Vec<String> = counts.map(|c| c.moves.iter().map(|(u, _)| u.clone()).collect()).unwrap_or_default();
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
                        uci: u,
                    })
                })
                .collect();
            sugg.sort_by(|a, b| b.share.unwrap_or(-1.0).total_cmp(&a.share.unwrap_or(-1.0)).then_with(|| b.book.cmp(&a.book)));
            sugg.truncate(MAX_SUGGESTIONS);
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
fn build(
    color: &str,
    root: &[String],
    moves: &HashMap<String, RepMove>,
    counts: &HashMap<String, Counts>,
    progress: &HashMap<String, LineProgress>,
    now: i64,
) -> (Vec<Node>, Option<f64>, Vec<(String, String)>) {
    let mut b = Builder { me: side(color), moves, counts, progress, now, nodes: vec![], seen: HashSet::new(), needed: vec![] };
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

fn view_of(color: &str, root: Vec<String>, nodes: Vec<Node>, coverage: Option<f64>, nums: &Numbers, complete: bool, error: Option<String>) -> TreeView {
    TreeView {
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
}

/// Your moves and cards of one colour.
type ColorData = (HashMap<String, RepMove>, HashMap<String, LineProgress>);

/// The summaries of several openings, keyed "color|family" (numbers at hand only).
pub fn summaries(db: &Db, accounts: &[Account], keys: &[(String, String)]) -> Result<HashMap<String, Summary>, String> {
    let nums = relevance::numbers(db, accounts)?;
    let now = now_ms();
    let mut by_color: HashMap<String, ColorData> = HashMap::new();
    let mut out = HashMap::new();
    for (color, family) in keys {
        if !by_color.contains_key(color) {
            by_color.insert(color.clone(), (db.rep_moves(color)?, db.opening_progress(color)?));
        }
        let (moves, progress) = &by_color[color];
        let (nodes, coverage, _) = build(color, &root_of(color, family), moves, &nums.counts, progress, now);
        let v = view_of(color, vec![], nodes, coverage, &nums, true, None);
        out.insert(format!("{color}|{family}"), Summary { coverage: v.coverage, gaps: v.gaps, cards: v.cards, due: v.due });
    }
    Ok(out)
}

/// The tree with the numbers already stored (quick).
pub fn view(db: &Db, accounts: &[Account], color: &str, root: Vec<String>) -> Result<TreeView, String> {
    let nums = relevance::numbers(db, accounts)?;
    let moves = db.rep_moves(color)?;
    let progress = db.opening_progress(color)?;
    let (nodes, coverage, needed) = build(color, &root, &moves, &nums.counts, &progress, now_ms());
    let error = nums.token.is_none().then(|| crate::tr!("Ohne Lichess-Schlüssel gibt es keine Häufigkeiten.", "Without a Lichess token there are no frequencies."));
    Ok(view_of(color, root, nodes, coverage, &nums, needed.is_empty(), error))
}

/// The tree after fetching the numbers that are missing (progress as
/// "relevance-progress" with family "repertoire").
pub async fn prepare(app: AppHandle, accounts: Vec<Account>, color: String, root: Vec<String>) -> Result<TreeView, String> {
    let (a, c) = (app.clone(), color.clone());
    let (mut nums, moves, progress) = tauri::async_runtime::spawn_blocking(move || {
        relevance::with_db(&a, |db| Ok::<_, String>((relevance::numbers(db, &accounts)?, db.rep_moves(&c)?, db.opening_progress(&c)?)))
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut f = Fetching::default();
    loop {
        let (nodes, coverage, needed) = build(&color, &root, &moves, &nums.counts, &progress, now_ms());
        let done = needed.is_empty();
        if done || nums.token.is_none() || f.error.is_some() || f.requests >= MAX_PREPARE {
            let error = if nums.token.is_none() {
                Some(crate::tr!("Ohne Lichess-Schlüssel gibt es keine Häufigkeiten.", "Without a Lichess token there are no frequencies."))
            } else {
                f.error.clone()
            };
            return Ok(view_of(&color, root, nodes, coverage, &nums, done, error));
        }
        relevance::fetch(&app, &mut nums, needed, &mut f, &color, "repertoire").await?;
    }
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
        let (nodes, coverage, needed) = build("black", &root, &moves, &c, &progress, 0);
        assert_eq!(nodes.len(), 4, "c6, d5, Bf5, cxd5");
        assert!(coverage.is_none() && !needed.is_empty());
        assert_eq!(nodes[0].mine.as_deref(), Some("1…c6"));
        assert_eq!(nodes[1].opp.as_deref(), Some("2. d4"));

        c.insert(key("e4 c6"), counts(&[("d2d4", 80), ("b1c3", 15), ("a2a3", 5)]));
        c.insert(key("e4 c6 d4 d5"), counts(&[("e4e5", 50), ("e4d5", 50)]));
        let (nodes, coverage, _) = build("black", &root, &moves, &c, &progress, 0);
        let gaps: Vec<&Node> = nodes.iter().filter(|n| n.gap).collect();
        assert_eq!(gaps.len(), 2, "2. Nc3 and 2. a3 have no answer: {:?}", nodes.iter().map(|n| (&n.opp, &n.mine)).collect::<Vec<_>>());
        assert_eq!(gaps[0].opp.as_deref(), Some("2. Nc3"));
        assert!((gaps[0].reach.unwrap() - 0.15).abs() < 1e-9);
        assert!(gaps[0].suggestions.iter().any(|s| s.book), "theory suggests something");
        assert!((coverage.unwrap() - 0.80).abs() < 1e-9, "{coverage:?}");
        // The node after 2. d4 has children; the leaves don't.
        assert!(nodes.iter().find(|n| n.opp.as_deref() == Some("2. d4")).unwrap().has_children);
    }

    #[test]
    fn opening_roots_end_before_your_defining_move() {
        assert_eq!(root_of("black", "Caro-Kann Defense"), ucis("e4"));
        assert_eq!(root_of("white", "Italian Game"), ucis("e4 e5 Nf3 Nc6"));
        assert_eq!(root_of("white", "Caro-Kann Defense"), ucis("e4 c6"));
    }
}
