//! Opening training: your repertoire (opening families per colour), drilled
//! with spaced repetition, plus the opening mistakes from your own games.
//!
//! A drill is one named line from the embedded opening list. The app plays the
//! opponent's moves, you play yours. Leitner boxes: a line you get right moves
//! up a box and comes back later (1, 3, 7, 21 days); a mistake sends it back
//! to box 1 (again in a few minutes).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::analysis::{Class, GameReview};
use crate::db::{Account, Db, LineProgress};
use crate::lichess::GameInfo;
use crate::openings::{self, Line};
use crate::stats::Example;

/// Mistakes up to this ply count as "in the opening" (move 12).
pub const OPENING_PLIES: usize = 24;
/// Share of drills taken from your own opening mistakes (when there are any).
const OWN_SHARE: f64 = 0.25;
const MINUTE: i64 = 60 * 1000;
const DAY: i64 = 24 * 60 * MINUTE;

/// Wait before a line comes back, by Leitner box (index 0 unused).
const INTERVALS: [i64; 6] = [0, 10 * MINUTE, DAY, 3 * DAY, 7 * DAY, 21 * DAY];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repertoire {
    /// Opening families you play as White, e.g. "Italian Game".
    pub white: Vec<String>,
    /// Opening families you play as Black, e.g. "Caro-Kann Defense".
    pub black: Vec<String>,
}

impl Repertoire {
    fn families(&self, color: &str) -> &[String] {
        if color == "white" { &self.white } else { &self.black }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Family {
    pub name: String,
    pub lines: usize,
    /// ECO code of the family's base line.
    pub eco: String,
    /// The defining moves, e.g. "1. e4 c5".
    pub moves: String,
    /// Position after the defining moves (for the thumbnail).
    pub fen: String,
}

/// Which drills to offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Repertoire lines and, sometimes, your own opening mistakes.
    #[default]
    Mixed,
    /// Only repertoire lines.
    Repertoire,
    /// Only positions from your own games.
    Own,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnMistake {
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
pub struct Drill {
    /// "line" (repertoire) or "own" (position from your games).
    pub kind: String,
    pub id: String,
    pub color: String,
    pub name: String,
    pub eco: String,
    /// Start position (FEN).
    pub fen: String,
    /// Line: all moves from the start position (both sides). Own: the best move.
    pub moves: Vec<String>,
    /// "new", "due" or "early" (nothing due – practising ahead).
    pub status: String,
    pub own: Option<OwnMistake>,
    /// Moves that are named theory; the rest is the engine's continuation.
    pub book_len: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideStatus {
    pub families: Vec<String>,
    pub lines: usize,
    /// Lines in box 3 or higher.
    pub learned: usize,
    pub due: usize,
    pub new: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub white: SideStatus,
    pub black: SideStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningStat {
    pub color: String,
    pub family: String,
    pub games: usize,
    pub wins: usize,
    pub draws: usize,
    pub losses: usize,
    pub accuracy_avg: f64,
    /// Your mistakes, misses and blunders within the first moves.
    pub opening_errors: usize,
    /// Games with at least one such error.
    pub games_with_error: usize,
    pub examples: Vec<Example>,
}

const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn load(db: &Db) -> Repertoire {
    db.setting("repertoire").ok().flatten().and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default()
}

pub fn save(db: &Db, rep: &Repertoire) -> Result<(), String> {
    db.set_setting("repertoire", Some(&serde_json::to_string(rep).map_err(|e| e.to_string())?))
}

/// All opening families, alphabetically, each with its base line: the
/// shortest line of the family ("Sicilian Defense" -> 1. e4 c5).
pub fn families() -> Vec<Family> {
    let mut groups: HashMap<&str, (usize, &Line)> = HashMap::new();
    for l in openings::lines() {
        let e = groups.entry(l.family.as_str()).or_insert((0, l));
        e.0 += 1;
        if l.moves.len() < e.1.moves.len() {
            e.1 = l;
        }
    }
    let mut out: Vec<Family> = groups
        .into_iter()
        .map(|(name, (count, base))| {
            let start = shakmaty::Chess::default();
            let fen = crate::explore::line_moves(START_FEN, &base.moves)
                .ok()
                .and_then(|m| m.last().map(|x| x.fen.clone()))
                .unwrap_or_else(|| START_FEN.to_string());
            Family {
                name: name.to_string(),
                lines: count,
                eco: base.eco.clone(),
                moves: crate::coach::san_line(&start, &base.moves, base.moves.len()),
                fen,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Lines of the chosen families in which `color` has at least one move to play.
fn trainable<'a>(rep: &Repertoire, color: &str) -> Vec<&'a Line> {
    let fams = rep.families(color);
    openings::lines()
        .iter()
        .filter(|l| fams.contains(&l.family))
        .filter(|l| if color == "white" { !l.moves.is_empty() } else { l.moves.len() >= 2 })
        .collect()
}

pub fn status(db: &Db) -> Result<Status, String> {
    let rep = load(db);
    let now = now_ms();
    let side = |color: &str| -> Result<SideStatus, String> {
        let progress = db.opening_progress(color)?;
        let lines = trainable(&rep, color);
        let mut s = SideStatus { families: rep.families(color).to_vec(), lines: lines.len(), ..Default::default() };
        for l in lines {
            match progress.get(&l.id) {
                None => s.new += 1,
                Some(p) => {
                    if p.box_ >= 3 {
                        s.learned += 1;
                    }
                    if p.due <= now {
                        s.due += 1;
                    }
                }
            }
        }
        Ok(s)
    };
    Ok(Status { white: side("white")?, black: side("black")? })
}

pub(crate) fn my_color(game: &GameInfo, accounts: &[Account]) -> Option<&'static str> {
    let me = accounts.iter().find(|a| a.source == game.source)?.username.to_lowercase();
    if game.white.name.to_lowercase() == me {
        Some("white")
    } else if game.black.name.to_lowercase() == me {
        Some("black")
    } else {
        None
    }
}

/// Your serious mistakes in the opening phase, newest games first.
fn own_mistakes(games: &[(GameInfo, GameReview)], accounts: &[Account]) -> Vec<Drill> {
    let mut out = Vec::new();
    for (game, review) in games {
        let Some(color) = my_color(game, accounts) else { continue };
        let opponent = if color == "white" { &game.black.name } else { &game.white.name };
        let (eco, name) = game.opening.as_ref().map_or((String::new(), "Eröffnung".to_string()), |o| (o.eco.clone(), o.name.clone()));
        for m in &review.moves {
            let serious = matches!(m.classification, Class::Mistake | Class::Miss | Class::Blunder);
            if m.color != color || !serious || m.ply > OPENING_PLIES {
                continue;
            }
            let (Some(best), Some(fen)) = (m.best_uci.clone(), review.fens.get(m.ply - 1)) else { continue };
            out.push(Drill {
                kind: "own".into(),
                id: format!("own:{}:{}", game.id, m.ply),
                color: color.into(),
                name: name.clone(),
                eco: eco.clone(),
                fen: fen.clone(),
                moves: vec![best],
                status: "due".into(),
                book_len: 1,
                own: Some(OwnMistake {
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
    out
}

fn line_drill(line: &Line, color: &str, status: &str) -> Drill {
    Drill {
        kind: "line".into(),
        id: line.id.clone(),
        color: color.into(),
        name: line.name.clone(),
        eco: line.eco.clone(),
        fen: START_FEN.into(),
        moves: line.moves.clone(),
        status: status.into(),
        own: None,
        book_len: line.moves.len(),
    }
}

/// Plies a line should have at least (8 moves per side), and the most
/// the engine adds beyond the named theory.
const TARGET_PLIES: usize = 16;
const MAX_EXTENSION: usize = 10;

/// Lengthen a short named line with Stockfish's best continuation, ending on
/// one of *your* moves. Computed once per line and cached.
fn extend(db: &Db, drill: &mut Drill) {
    if drill.kind != "line" {
        return;
    }
    let ext = match db.line_extension(&drill.id) {
        Ok(Some(ext)) => ext,
        _ => {
            let want = TARGET_PLIES.saturating_sub(drill.moves.len()).clamp(4, MAX_EXTENSION);
            let Some(end) = crate::explore::line_moves(START_FEN, &drill.moves).ok().and_then(|m| m.last().map(|x| x.fen.clone()))
            else {
                return;
            };
            let Ok(line) = crate::explore::engine_line(&end, 18, want) else { return };
            let ext: Vec<String> = line.moves.into_iter().map(|m| m.uci).collect();
            let _ = db.set_line_extension(&drill.id, &ext);
            ext
        }
    };
    drill.moves.extend(ext);
    trim_to_own_move(&mut drill.moves, drill.book_len, &drill.color);
}

/// Drop engine moves at the end until the line ends on your own move
/// (White moves on even indices, Black on odd ones). Theory moves stay.
fn trim_to_own_move(moves: &mut Vec<String>, book_len: usize, color: &str) {
    let mine = |i: usize| i.is_multiple_of(2) == (color == "white");
    while moves.len() > book_len && !mine(moves.len() - 1) {
        moves.pop();
    }
}

/// Learn one opening for one colour (the "Lernen" buttons in the opening list).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Focus {
    pub color: String,
    pub family: String,
    /// Only this variation group (e.g. "Advance Variation").
    #[serde(default)]
    pub variation: Option<String>,
    /// Only this one line.
    #[serde(default)]
    pub line: Option<String>,
}

impl Focus {
    fn matches(&self, l: &Line) -> bool {
        l.family == self.family
            && self.variation.as_deref().is_none_or(|v| l.variation() == v)
            && self.line.as_deref().is_none_or(|id| l.id == id)
    }
}

/// Next drill: due lines first (oldest first), then new lines (shortest, i.e.
/// most general, first), sometimes one of your own opening mistakes; if nothing
/// is due, the line that is due soonest. With a focus, only that opening and
/// colour, and new lines strictly in order (like a course).
pub fn next(
    db: &Db,
    accounts: &[Account],
    games: &[(GameInfo, GameReview)],
    mode: Mode,
    focus: Option<&Focus>,
) -> Result<Option<Drill>, String> {
    let mut rng = fastrand::Rng::new();
    let mut rep = load(db);
    if let Some(f) = focus {
        rep = if f.color == "white" {
            Repertoire { white: vec![f.family.clone()], black: vec![] }
        } else {
            Repertoire { white: vec![], black: vec![f.family.clone()] }
        };
    }
    let in_focus = |l: &Line| focus.is_none_or(|f| f.matches(l));
    let mode = if focus.is_some() { Mode::Repertoire } else { mode };
    let now = now_ms();

    // Own mistakes: due unless solved recently (they use the same progress table).
    let progress_w = db.opening_progress("white")?;
    let progress_b = db.opening_progress("black")?;
    let progress_of = |color: &str| if color == "white" { &progress_w } else { &progress_b };
    let own: Vec<Drill> = own_mistakes(games, accounts)
        .into_iter()
        .filter(|d| progress_of(&d.color).get(&d.id).is_none_or(|p| p.due <= now))
        .collect();

    let mut due: Vec<(i64, &Line, &str)> = Vec::new();
    let mut new: Vec<(&Line, &str)> = Vec::new();
    let mut later: Vec<(i64, &Line, &str)> = Vec::new();
    for color in ["white", "black"] {
        for line in trainable(&rep, color).into_iter().filter(|l| in_focus(l)) {
            match progress_of(color).get(&line.id) {
                None => new.push((line, color)),
                Some(p) if p.due <= now => due.push((p.due, line, color)),
                Some(p) => later.push((p.due, line, color)),
            }
        }
    }

    if mode == Mode::Own {
        return Ok((!own.is_empty()).then(|| own[rng.usize(..own.len())].clone()));
    }
    let take_own = mode == Mode::Mixed && (rng.f64() < OWN_SHARE || (due.is_empty() && new.is_empty()));
    if !own.is_empty() && take_own {
        return Ok(Some(own[rng.usize(..own.len())].clone()));
    }
    let pick = |len: usize, rng: &mut fastrand::Rng| if focus.is_some() { 0 } else { rng.usize(..len.min(3)) };
    let mut drill = if !due.is_empty() {
        due.sort_by_key(|(d, ..)| *d);
        // A little randomness among the most overdue so the order isn't rigid.
        let (_, line, color) = due[pick(due.len(), &mut rng)];
        Some(line_drill(line, color, "due"))
    } else if !new.is_empty() {
        // Follow the move tree (a parent line before its sub-lines, siblings
        // together) instead of jumping across the opening.
        new.sort_by(|(a, _), (b, _)| a.moves.cmp(&b.moves));
        let (line, color) = new[pick(new.len(), &mut rng)];
        Some(line_drill(line, color, "new"))
    } else {
        later.iter().min_by_key(|(d, ..)| *d).map(|(_, line, color)| line_drill(line, color, "early"))
    };
    if let Some(d) = drill.as_mut() {
        extend(db, d);
    }
    Ok(drill)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyProgress {
    pub lines: usize,
    /// Lines seen at least once.
    pub started: usize,
    /// Lines in box 3 or higher.
    pub learned: usize,
    pub due: usize,
}

/// Learning progress per family and colour, for every family you've started or
/// added: key "white|Caro-Kann Defense".
pub fn family_progress(db: &Db) -> Result<HashMap<String, FamilyProgress>, String> {
    let rep = load(db);
    let now = now_ms();
    let mut out: HashMap<String, FamilyProgress> = HashMap::new();
    for color in ["white", "black"] {
        let progress = db.opening_progress(color)?;
        let all = Repertoire {
            white: if color == "white" { families().into_iter().map(|f| f.name).collect() } else { vec![] },
            black: if color == "black" { families().into_iter().map(|f| f.name).collect() } else { vec![] },
        };
        for line in trainable(&all, color) {
            let p = progress.get(&line.id);
            let in_rep = rep.families(color).contains(&line.family);
            if p.is_none() && !in_rep {
                continue;
            }
            let e = out.entry(format!("{color}|{}", line.family)).or_default();
            e.lines += 1;
            if let Some(p) = p {
                e.started += 1;
                e.learned += (p.box_ >= 3) as usize;
                e.due += (p.due <= now) as usize;
            }
        }
    }
    // Families that were started but have only some lines counted above: count all lines.
    for (key, e) in out.iter_mut() {
        let (color, family) = key.split_once('|').unwrap_or_default();
        let rep = Repertoire {
            white: if color == "white" { vec![family.to_string()] } else { vec![] },
            black: if color == "black" { vec![family.to_string()] } else { vec![] },
        };
        e.lines = trainable(&rep, color).len();
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineInfo {
    pub id: String,
    /// Name without the family.
    pub name: String,
    pub plies: usize,
    /// 0 = not seen yet, 1..=5 = Leitner box.
    pub box_level: u8,
    pub due: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariationGroup {
    pub name: String,
    pub total: usize,
    pub started: usize,
    pub learned: usize,
    pub due: usize,
    pub lines: Vec<LineInfo>,
}

/// Variations of one opening for one colour, in move-tree order, with progress.
pub fn family_detail(db: &Db, color: &str, family: &str) -> Result<Vec<VariationGroup>, String> {
    let progress = db.opening_progress(color)?;
    let now = now_ms();
    let rep = if color == "white" {
        Repertoire { white: vec![family.to_string()], black: vec![] }
    } else {
        Repertoire { white: vec![], black: vec![family.to_string()] }
    };
    let mut lines = trainable(&rep, color);
    lines.sort_by(|a, b| a.moves.cmp(&b.moves));
    let mut groups: Vec<VariationGroup> = Vec::new();
    for l in lines {
        let p = progress.get(&l.id);
        let info = LineInfo {
            id: l.id.clone(),
            name: l.short_name().to_string(),
            plies: l.moves.len(),
            box_level: p.map_or(0, |p| p.box_),
            due: p.is_some_and(|p| p.due <= now),
        };
        let idx = match groups.iter().position(|g| g.name == l.variation()) {
            Some(i) => i,
            None => {
                groups.push(VariationGroup { name: l.variation().to_string(), total: 0, started: 0, learned: 0, due: 0, lines: vec![] });
                groups.len() - 1
            }
        };
        let g = &mut groups[idx];
        g.total += 1;
        g.started += (info.box_level > 0) as usize;
        g.learned += (info.box_level >= 3) as usize;
        g.due += info.due as usize;
        g.lines.push(info);
    }
    Ok(groups)
}

/// Leitner update: right -> one box up, wrong -> back to box 1.
pub fn update(previous: Option<LineProgress>, success: bool, now: i64) -> LineProgress {
    let p = previous.unwrap_or(LineProgress { box_: 0, due: now, attempts: 0, successes: 0 });
    let box_ = if success { (p.box_ + 1).clamp(1, 5) } else { 1 };
    LineProgress {
        box_,
        due: now + INTERVALS[box_ as usize],
        attempts: p.attempts + 1,
        successes: p.successes + success as u32,
    }
}

pub fn record(db: &Db, id: &str, color: &str, success: bool) -> Result<LineProgress, String> {
    let previous = db.opening_progress(color)?.get(id).copied();
    let p = update(previous, success, now_ms());
    db.set_opening_progress(id, color, &p)?;
    Ok(p)
}

/// Your openings by colour and family: results, accuracy and opening mistakes.
pub fn report(games: &[(GameInfo, GameReview)], accounts: &[Account]) -> Vec<OpeningStat> {
    let mut map: HashMap<(String, String), OpeningStat> = HashMap::new();
    for (game, review) in games {
        let (Some(color), Some(opening)) = (my_color(game, accounts), game.opening.as_ref()) else { continue };
        let family = openings::family_of(&opening.name).to_string();
        let stat = map.entry((color.to_string(), family.clone())).or_insert_with(|| OpeningStat {
            color: color.into(),
            family,
            games: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            accuracy_avg: 0.0,
            opening_errors: 0,
            games_with_error: 0,
            examples: vec![],
        });
        stat.games += 1;
        match game.winner.as_deref() {
            None => stat.draws += 1,
            Some(w) if w == color => stat.wins += 1,
            Some(_) => stat.losses += 1,
        }
        // Running sum for now, turned into an average below.
        stat.accuracy_avg += if color == "white" { review.accuracy.white } else { review.accuracy.black };
        let opponent = if color == "white" { &game.black.name } else { &game.white.name };
        let mut had_error = false;
        for m in review.moves.iter().filter(|m| m.color == color && m.ply <= OPENING_PLIES) {
            if matches!(m.classification, Class::Mistake | Class::Miss | Class::Blunder) {
                stat.opening_errors += 1;
                had_error = true;
                if stat.examples.len() < 8 {
                    stat.examples.push(Example {
                        game_id: game.id.clone(),
                        ply: m.ply,
                        san: m.san.clone(),
                        classification: m.classification,
                        created_at: game.created_at,
                        opponent: opponent.clone(),
                    });
                }
            }
        }
        stat.games_with_error += had_error as usize;
    }
    let mut out: Vec<OpeningStat> = map
        .into_values()
        .map(|mut s| {
            s.accuracy_avg = (s.accuracy_avg / s.games as f64 * 10.0).round() / 10.0;
            s
        })
        .collect();
    out.sort_by(|a, b| b.games.cmp(&a.games).then_with(|| a.family.cmp(&b.family)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leitner_boxes() {
        let now = 1_000_000;
        let p = update(None, true, now);
        assert_eq!((p.box_, p.due, p.attempts, p.successes), (1, now + 10 * MINUTE, 1, 1));
        let p = update(Some(p), true, now);
        assert_eq!((p.box_, p.due), (2, now + DAY));
        let mut q = p;
        for _ in 0..10 {
            q = update(Some(q), true, now);
        }
        assert_eq!((q.box_, q.due), (5, now + 21 * DAY), "box is capped at 5");
        let r = update(Some(q), false, now);
        assert_eq!((r.box_, r.due, r.attempts), (1, now + 10 * MINUTE, 13));
    }

    #[test]
    fn repertoire_lines_and_status() {
        let db = Db::in_memory();
        let rep = Repertoire { white: vec!["Italian Game".into()], black: vec!["Caro-Kann Defense".into()] };
        save(&db, &rep).unwrap();
        assert_eq!(load(&db).black, ["Caro-Kann Defense"]);

        let caro = trainable(&rep, "black");
        assert!(caro.len() > 10);
        assert!(caro.iter().all(|l| l.family == "Caro-Kann Defense" && l.moves.len() >= 2));

        let st = status(&db).unwrap();
        assert_eq!(st.black.new, st.black.lines);
        assert_eq!(st.white.learned, 0);

        // A new line is offered; after recording it is not new anymore.
        let d = next(&db, &[], &[], Mode::Mixed, None).unwrap().unwrap();
        assert_eq!(d.kind, "line");
        assert_eq!(d.status, "new");
        assert_eq!(d.fen, START_FEN);
        record(&db, &d.id, &d.color, true).unwrap();
        let st2 = status(&db).unwrap();
        let side = if d.color == "white" { &st2.white } else { &st2.black };
        assert_eq!(side.new + 1, side.lines);
    }

    #[test]
    fn focus_teaches_one_opening_in_order() {
        let db = Db::in_memory();
        // Repertoire has something else; the focus wins.
        save(&db, &Repertoire { white: vec!["Italian Game".into()], black: vec![] }).unwrap();
        let focus = Focus { color: "black".into(), family: "Caro-Kann Defense".into(), variation: None, line: None };
        let first = next(&db, &[], &[], Mode::Mixed, Some(&focus)).unwrap().unwrap();
        assert_eq!(first.color, "black");
        assert!(first.name.starts_with("Caro-Kann Defense"));
        assert_eq!(first.status, "new");
        // Deterministic: asking again gives the same first lesson.
        assert_eq!(next(&db, &[], &[], Mode::Mixed, Some(&focus)).unwrap().unwrap().id, first.id);
        record(&db, &first.id, "black", true).unwrap();
        let second = next(&db, &[], &[], Mode::Mixed, Some(&focus)).unwrap().unwrap();
        assert_ne!(second.id, first.id);
        assert!(second.book_len >= 2);

        let progress = family_progress(&db).unwrap();
        let caro = &progress["black|Caro-Kann Defense"];
        assert_eq!(caro.started, 1);
        assert!(caro.lines > 10);
        assert!(progress.contains_key("white|Italian Game"), "repertoire families are listed");
    }

    #[test]
    fn variations_are_grouped_and_focusable() {
        let db = Db::in_memory();
        let groups = family_detail(&db, "black", "Caro-Kann Defense").unwrap();
        let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
        assert!(names.contains(&"Advance Variation") && names.contains(&openings::MAIN_LINE), "{names:?}");
        let advance = groups.iter().find(|g| g.name == "Advance Variation").unwrap();
        assert!(advance.total > 3 && advance.started == 0);

        let focus = Focus {
            color: "black".into(),
            family: "Caro-Kann Defense".into(),
            variation: Some("Advance Variation".into()),
            line: None,
        };
        let d = next(&db, &[], &[], Mode::Mixed, Some(&focus)).unwrap().unwrap();
        assert!(d.name.starts_with("Caro-Kann Defense: Advance Variation"), "{}", d.name);

        let one = Focus { line: Some(advance.lines[2].id.clone()), ..focus };
        assert_eq!(next(&db, &[], &[], Mode::Mixed, Some(&one)).unwrap().unwrap().id, advance.lines[2].id);
    }

    #[test]
    fn extensions_end_on_your_move() {
        let line = |n: usize| (0..n).map(|i| format!("m{i}")).collect::<Vec<_>>();
        // White, 2 theory + 4 engine moves: index 5 is Black's -> cut to 5 (index 4, White).
        let mut w = line(6);
        trim_to_own_move(&mut w, 2, "white");
        assert_eq!(w.len(), 5);
        // Already ending on a White move (index 6): nothing to cut.
        let mut w7 = line(7);
        trim_to_own_move(&mut w7, 2, "white");
        assert_eq!(w7.len(), 7);
        // Black: ends on an odd index.
        let mut b = line(7);
        trim_to_own_move(&mut b, 2, "black");
        assert_eq!(b.len(), 6);
        // Theory is never cut, even if it ends on the opponent's move.
        let mut t = line(3);
        trim_to_own_move(&mut t, 3, "black");
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn empty_repertoire_without_games_has_no_drill() {
        let db = Db::in_memory();
        assert!(next(&db, &[], &[], Mode::Mixed, None).unwrap().is_none());
    }

    #[test]
    fn families_are_sorted_and_counted() {
        let f = families();
        assert_eq!(f.len(), 149);
        assert!(f.windows(2).all(|w| w[0].name <= w[1].name));
        let sicilian = f.iter().find(|x| x.name == "Sicilian Defense").unwrap();
        assert!(sicilian.lines > 100);
        assert_eq!(sicilian.moves, "1. e4 c5");
        assert!(sicilian.fen.starts_with("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w"));
    }

    #[test]
    fn own_mode_without_games_offers_nothing() {
        let db = Db::in_memory();
        save(&db, &Repertoire { white: vec!["Italian Game".into()], black: vec![] }).unwrap();
        assert!(next(&db, &[], &[], Mode::Own, None).unwrap().is_none());
        assert!(next(&db, &[], &[], Mode::Repertoire, None).unwrap().is_some());
    }
}
