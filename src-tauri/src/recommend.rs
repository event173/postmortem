//! What your games say about your openings – for the Lernen page: how often
//! you meet an opening (as White or Black), how many of its common lines you
//! know, which variation came up most that you haven't learned, and where you
//! leave theory and go wrong right after. The best of them are suggested
//! ("Für dich"); the rest shows up next to your openings.

use std::collections::HashMap;

use serde::Serialize;
use shakmaty::Chess;

use crate::analysis::{Class, GameReview, MoveReview};
use crate::coach;
use crate::db::{Account, Db};
use crate::lichess::GameInfo;
use crate::openings::{self, book, family_of, variation_of};
use crate::repertoire::{family_detail, family_lines, my_color};
use crate::theory::{first_exit, AFTER_PLIES};

/// An opening needs at least this many of your games to be suggested.
const MIN_GAMES: usize = 3;
/// Theory moves shown for a costly exit.
const MAX_BOOK: usize = 2;

/// Where you most often leave theory in an opening and go wrong soon after.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostlyExit {
    /// 1-based ply of your move.
    pub ply: usize,
    /// Your move there (SAN), and the theory moves.
    pub played: String,
    pub book: Vec<String>,
    /// How often it happened.
    pub times: usize,
    /// One of those games (to find the line behind it).
    pub game_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub color: String,
    pub family: String,
    /// Your games in this opening with this colour.
    pub games: usize,
    /// Lines of the course you've started, and all lines of the course.
    pub known: usize,
    pub total: usize,
    /// The course is based on Lichess numbers (else: every line).
    pub numbers: bool,
    /// The variation that came up most in your games and isn't learned yet.
    pub variation: Option<String>,
    pub variation_games: usize,
    /// Analysed games, and in how many of them you left theory first and made
    /// a mistake soon after.
    pub reviewed: usize,
    pub theory_errors: usize,
    pub exit: Option<CostlyExit>,
    /// Worth suggesting (> 0), higher first.
    pub score: f64,
}

/// A costly exit while counting: position -> (ply, your moves, theory moves, times).
type Exits = HashMap<String, (usize, HashMap<String, usize>, Vec<String>, usize, String)>;

#[derive(Default)]
struct Tally {
    games: usize,
    variations: HashMap<String, usize>,
    reviewed: usize,
    theory_errors: usize,
    exits: Exits,
}

/// Did leaving theory at `ply` cost you: a mistake of yours there or soon after?
fn costly(moves: &[MoveReview], color: &str, ply: usize) -> bool {
    moves.iter().any(|m| {
        m.color == color && m.ply >= ply && m.ply < ply + AFTER_PLIES && matches!(m.classification, Class::Mistake | Class::Miss | Class::Blunder)
    })
}

/// Every opening you played, newest analysis included; best suggestions first.
pub fn insights(db: &Db, accounts: &[Account], reviewed: &[(GameInfo, GameReview)]) -> Result<Vec<Insight>, String> {
    let key_of = |game: &GameInfo| -> Option<(String, String)> {
        let color = my_color(game, accounts)?;
        let opening = openings::identify(&game.moves)?;
        Some((color.to_string(), family_of(&opening.name).to_string()))
    };
    let mut tally: HashMap<(String, String), Tally> = HashMap::new();
    for g in db.games_of(accounts, 1_000_000)? {
        let Some(key) = key_of(&g.game) else { continue };
        let Some(opening) = openings::identify(&g.game.moves) else { continue };
        let t = tally.entry(key).or_default();
        t.games += 1;
        *t.variations.entry(variation_of(&opening.name).to_string()).or_default() += 1;
    }
    for (game, review) in reviewed {
        let Some(key) = key_of(game) else { continue };
        let color = key.0.clone();
        let t = tally.entry(key).or_default();
        t.reviewed += 1;
        let Some((ply, exit, mover)) = first_exit(game) else { continue };
        if mover != color || !costly(&review.moves, &color, ply) {
            continue;
        }
        t.theory_errors += 1;
        let e = t.exits.entry(exit.key.clone()).or_insert_with(|| {
            let pos: Chess = crate::analysis::parse_fen(&exit.fen).unwrap_or_default();
            let theory = book()
                .next
                .get(&exit.key)
                .map(|ms| ms.iter().filter_map(|u| coach::parse_uci(&pos, u).map(|m| coach::san(&pos, m))).take(MAX_BOOK).collect())
                .unwrap_or_default();
            (ply, HashMap::new(), theory, 0, game.id.clone())
        });
        *e.1.entry(exit.san.clone()).or_default() += 1;
        e.3 += 1;
    }

    let mut out = Vec::new();
    for ((color, family), t) in tally {
        if t.games == 0 || family_lines(&color, &family).is_empty() {
            continue;
        }
        let detail = family_detail(db, &color, &family)?;
        let total: usize = detail.groups.iter().map(|g| g.total).sum();
        let known: usize = detail.groups.iter().map(|g| g.started).sum();
        // Most frequent variation of the course that you haven't started.
        let mut open: Vec<(&String, &usize)> = t
            .variations
            .iter()
            .filter(|(v, _)| detail.groups.iter().any(|g| &g.name == *v && g.started == 0))
            .collect();
        open.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        let exit = t
            .exits
            .into_values()
            .max_by(|a, b| a.3.cmp(&b.3).then_with(|| b.0.cmp(&a.0)))
            .map(|(ply, played, book, times, game_id)| CostlyExit {
                ply,
                played: played.into_iter().max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0))).map(|(s, _)| s).unwrap_or_default(),
                book,
                times,
                game_id,
            });
        let unknown = if total == 0 { 0.0 } else { (total - known.min(total)) as f64 / total as f64 };
        let error_rate = if t.reviewed >= MIN_GAMES { t.theory_errors as f64 / t.reviewed as f64 } else { 0.0 };
        let worth = t.games >= MIN_GAMES && (known < total || t.theory_errors >= 2);
        out.push(Insight {
            games: t.games,
            known,
            total,
            numbers: !detail.ratings.is_empty(),
            variation: open.first().map(|(v, _)| v.to_string()),
            variation_games: open.first().map_or(0, |(_, n)| **n),
            reviewed: t.reviewed,
            theory_errors: t.theory_errors,
            exit,
            score: if worth { t.games as f64 * (unknown + error_rate) } else { 0.0 },
            color,
            family,
        });
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| b.games.cmp(&a.games)).then_with(|| a.family.cmp(&b.family)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lichess::{Player, Source};

    fn game(id: &str, white: &str, black: &str, moves: &str) -> GameInfo {
        let player = |n: &str| Player { name: n.into(), rating: Some(1500) };
        GameInfo {
            id: id.into(),
            source: Source::Lichess,
            url: None,
            white: player(white),
            black: player(black),
            winner: None,
            status: "draw".into(),
            speed: "rapid".into(),
            rated: true,
            time_control: None,
            created_at: 0,
            opening: None,
            moves: moves.split_whitespace().map(String::from).collect(),
            clocks: None,
        }
    }

    #[test]
    fn suggests_what_you_meet_and_dont_know() {
        let mut db = Db::in_memory();
        let me = Account { source: Source::Lichess, username: "me".into() };
        let mut games: Vec<GameInfo> = (0..4).map(|i| game(&format!("a{i}"), "x", "me", "e4 c6 d4 d5 e5 Bf5")).collect();
        games.push(game("b", "x", "me", "e4 c6 d4 d5 exd5 cxd5"));
        games.push(game("c", "me", "x", "d4 d5 c4 e6"));
        games.push(game("d", "me", "x", "d4 d5 c4 e6 Nc3"));
        db.save_games(&games).unwrap();
        let all = insights(&db, std::slice::from_ref(&me), &[]).unwrap();
        assert_eq!(all.len(), 2, "every opening you played is there");
        let r = &all[0];
        assert_eq!((r.color.as_str(), r.family.as_str(), r.games), ("black", "Caro-Kann Defense", 5));
        assert!(r.score > 0.0 && r.known == 0 && r.total > 10 && !r.numbers);
        assert_eq!((r.variation.as_deref(), r.variation_games), (Some("Advance Variation"), 4));
        assert_eq!(all[1].score, 0.0, "two games aren't enough for a suggestion");

        // Once the advance variation is started, the next open one is named.
        let adv = family_lines("black", "Caro-Kann Defense").into_iter().find(|l| l.variation() == "Advance Variation").unwrap();
        crate::repertoire::record(&db, &adv.id, "black", true).unwrap();
        let r = &insights(&db, &[me], &[]).unwrap()[0];
        assert_eq!(r.known, 1);
        assert_eq!(r.variation.as_deref(), Some("Exchange Variation"));
    }

    #[test]
    fn costly_exits_need_your_mistake_soon_after() {
        let m = MoveReview {
            ply: 20,
            color: "black".into(),
            san: "e6".into(),
            uci: "e7e6".into(),
            classification: Class::Mistake,
            win_before: 50.0,
            win_after: 40.0,
            best_san: None,
            best_uci: None,
            best_line: None,
            comment: String::new(),
            comment_en: None,
            comment_other: None,
            comment_other_en: None,
            theme: None,
        };
        let moves = vec![m];
        assert!(costly(&moves, "black", 15));
        assert!(!costly(&moves, "white", 15), "only your own mistakes");
        assert!(!costly(&moves, "black", 21), "before you left theory");
        assert!(!costly(&moves, "black", 20 - AFTER_PLIES), "too long after");
    }
}
