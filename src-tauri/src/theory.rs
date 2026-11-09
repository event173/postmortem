//! "Hier verlässt du die Theorie": positions in which *you* are the first to
//! leave the known (named) opening lines, grouped over all your games – and
//! whether it costs you something (from the reviews, where a game is analysed).

use std::collections::HashMap;

use serde::Serialize;
use shakmaty::{san::SanPlus, Chess, Position};

use crate::analysis::{self, Class, GameReview};
use crate::coach;
use crate::db::Account;
use crate::lichess::GameInfo;
use crate::openings::{self, book, epd};
use crate::repertoire::my_color;

/// Theory in the dataset rarely goes deeper than this.
const MAX_PLIES: usize = 40;
/// Your errors within this many plies after leaving theory count as "it went wrong".
const AFTER_PLIES: usize = 10;
const MAX_POSITIONS: usize = 8;
/// Book moves shown as "theory would be".
const MAX_BOOK: usize = 4;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveCount {
    pub san: String,
    pub count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TheoryExit {
    pub color: String,
    /// Position before your move.
    pub fen: String,
    /// 1-based ply of your move.
    pub ply: usize,
    pub opening: Option<String>,
    pub family: Option<String>,
    pub games: usize,
    pub wins: usize,
    pub draws: usize,
    pub losses: usize,
    /// What you played here, most frequent first.
    pub played: Vec<MoveCount>,
    /// Theory moves in this position.
    pub book: Vec<String>,
    /// Engine's best move (from a review of one of the games).
    pub best: Option<String>,
    /// Games among `games` that have a review.
    pub analysed: usize,
    /// Average winning chances your move lost (analysed games only), in %-points.
    pub avg_loss: Option<f64>,
    /// Analysed games with a mistake/blunder of yours right after leaving theory.
    pub errors_after: usize,
    /// Most recent game, to open it at `ply`.
    pub game_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TheoryReport {
    pub games: usize,
    /// Games in which you left theory first / your opponent did.
    pub you_first: usize,
    pub opponent_first: usize,
    /// Average move number at which you leave theory.
    pub avg_exit_move: Option<f64>,
    /// Positions you left theory in at least twice, most frequent first.
    pub positions: Vec<TheoryExit>,
}

struct Exit {
    key: String,
    fen: String,
    ply: usize,
    uci: String,
    san: String,
}

/// The first move of the game that leaves theory, if the game ever does.
fn first_exit(game: &GameInfo) -> Option<(usize, Exit, &'static str)> {
    let book = book();
    let mut pos = Chess::default();
    for (i, san) in game.moves.iter().take(MAX_PLIES).enumerate() {
        let m = san.parse::<SanPlus>().ok()?.san.to_move(&pos).ok()?;
        let mut after = pos.clone();
        after.play_unchecked(m);
        if !book.positions.contains(&epd(&after)) {
            let mover = if i % 2 == 0 { "white" } else { "black" };
            let exit = Exit {
                key: epd(&pos),
                fen: analysis::fen(&pos),
                ply: i + 1,
                uci: shakmaty::uci::UciMove::from_move(m, shakmaty::CastlingMode::Standard).to_string(),
                san: coach::san(&pos, m),
            };
            return Some((i + 1, exit, mover));
        }
        pos = after;
    }
    None
}

/// How much a position is worth looking at: frequency, weighted by what it cost
/// you in the analysed games.
fn cost(p: &TheoryExit) -> f64 {
    let errors = if p.analysed > 0 { p.errors_after as f64 / p.analysed as f64 } else { 0.0 };
    p.games as f64 * (1.0 + p.avg_loss.unwrap_or(0.0) / 5.0 + 2.0 * errors)
}

/// `games` newest first.
pub fn report(games: &[GameInfo], reviews: &HashMap<String, GameReview>, accounts: &[Account]) -> TheoryReport {
    let mut groups: HashMap<(&'static str, String), TheoryExit> = HashMap::new();
    let mut order: Vec<(&'static str, String)> = Vec::new();
    let (mut counted, mut you_first, mut opponent_first) = (0, 0, 0);
    let mut exit_moves = Vec::new();

    for game in games {
        let Some(color) = my_color(game, accounts) else { continue };
        counted += 1;
        let Some((ply, exit, mover)) = first_exit(game) else { continue };
        if mover != color {
            opponent_first += 1;
            continue;
        }
        you_first += 1;
        exit_moves.push(ply.div_ceil(2) as f64);
        let key = (color, exit.key.clone());
        let g = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key);
            let pos = analysis::parse_fen(&exit.fen).unwrap_or_default();
            let book_moves = book()
                .next
                .get(&exit.key)
                .map(|ms| {
                    ms.iter()
                        .filter_map(|u| coach::parse_uci(&pos, u).map(|m| coach::san(&pos, m)))
                        .take(MAX_BOOK)
                        .collect()
                })
                .unwrap_or_default();
            TheoryExit {
                color: color.into(),
                fen: exit.fen.clone(),
                ply: exit.ply,
                opening: game.opening.as_ref().map(|o| o.name.clone()),
                family: game.opening.as_ref().map(|o| openings::family_of(&o.name).to_string()),
                games: 0,
                wins: 0,
                draws: 0,
                losses: 0,
                played: vec![],
                book: book_moves,
                best: None,
                analysed: 0,
                avg_loss: None,
                errors_after: 0,
                game_id: game.id.clone(),
            }
        });
        g.games += 1;
        match game.winner.as_deref() {
            None => g.draws += 1,
            Some(w) if w == color => g.wins += 1,
            Some(_) => g.losses += 1,
        }
        match g.played.iter_mut().find(|m| m.san == exit.san) {
            Some(m) => m.count += 1,
            None => g.played.push(MoveCount { san: exit.san.clone(), count: 1 }),
        }

        if let Some(review) = reviews.get(&game.id) {
            let Some(mv) = review.moves.get(ply - 1).filter(|m| m.uci == exit.uci) else { continue };
            g.analysed += 1;
            // Running sum, turned into an average below.
            *g.avg_loss.get_or_insert(0.0) += (mv.win_before - mv.win_after).max(0.0);
            if g.best.is_none() {
                g.best = mv.best_san.clone();
            }
            let erred = review.moves.iter().any(|m| {
                m.color == color
                    && m.ply >= ply
                    && m.ply < ply + AFTER_PLIES
                    && matches!(m.classification, Class::Mistake | Class::Miss | Class::Blunder)
            });
            g.errors_after += erred as usize;
        }
    }

    let mut positions: Vec<TheoryExit> = order
        .into_iter()
        .filter_map(|k| groups.remove(&k))
        .filter(|g| g.games >= 2)
        .map(|mut g| {
            g.avg_loss = g.avg_loss.map(|sum| (sum / g.analysed as f64 * 10.0).round() / 10.0);
            g.played.sort_by_key(|m| std::cmp::Reverse(m.count));
            g
        })
        .collect();
    // Deviating is not bad in itself (the dataset only knows *named* lines):
    // what costs you comes first, then what you play most often.
    positions.sort_by(|a, b| cost(b).total_cmp(&cost(a)).then_with(|| b.games.cmp(&a.games)));
    positions.truncate(MAX_POSITIONS);

    TheoryReport {
        games: counted,
        you_first,
        opponent_first,
        avg_exit_move: (!exit_moves.is_empty())
            .then(|| (exit_moves.iter().sum::<f64>() / exit_moves.len() as f64 * 10.0).round() / 10.0),
        positions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::{Accuracy, MoveReview, REVIEW_VERSION};
    use crate::lichess::{Player, Source};

    fn game(id: &str, white: &str, black: &str, winner: Option<&str>, moves: &str) -> GameInfo {
        GameInfo {
            id: id.into(),
            source: Source::Lichess,
            url: None,
            white: Player { name: white.into(), rating: None },
            black: Player { name: black.into(), rating: None },
            winner: winner.map(Into::into),
            status: "mate".into(),
            speed: "blitz".into(),
            rated: true,
            time_control: None,
            created_at: 0,
            opening: None,
            moves: moves.split_whitespace().map(String::from).collect(),
            clocks: None,
        }
    }

    #[test]
    fn groups_positions_where_you_leave_theory() {
        // As White you play 1. e4 e5 2. Nf3 Nc6 3. h4?! twice – leaving theory at move 3.
        let a = game("a", "me", "x", Some("black"), "e4 e5 Nf3 Nc6 h4 Nf6 h5");
        let b = game("b", "me", "y", None, "e4 e5 Nf3 Nc6 h4 d5");
        // Here the opponent leaves theory first (2... Ke7?!) …
        let c = game("c", "me", "z", Some("white"), "e4 e5 Nf3 Ke7 d4");
        // … and here it's you, as Black (only once, so not listed).
        let d = game("d", "w", "me", Some("white"), "e4 e5 Nf3 Ke7 d4");
        let mut reviews = HashMap::new();
        let mv = |ply: usize, san: &str, uci: &str, class: Class, before: f64, after: f64| MoveReview {
            ply,
            color: if ply % 2 == 1 { "white".into() } else { "black".into() },
            san: san.into(),
            uci: uci.into(),
            classification: class,
            win_before: before,
            win_after: after,
            best_san: Some("Bb5".into()),
            best_uci: None,
            best_line: None,
            comment: String::new(),
            comment_en: None,
            theme: None,
        };
        let mut moves: Vec<MoveReview> = (1..=4).map(|p| mv(p, "x", "x", Class::Book, 50.0, 50.0)).collect();
        moves.push(mv(5, "h4", "h2h4", Class::Inaccuracy, 55.0, 45.0));
        moves.push(mv(6, "Nf6", "g8f6", Class::Best, 55.0, 55.0));
        moves.push(mv(7, "h5", "h4h5", Class::Blunder, 45.0, 10.0));
        reviews.insert(
            "a".to_string(),
            GameReview {
                version: REVIEW_VERSION,
                game_id: "a".into(),
                depth: 16,
                fens: vec![],
                evals: vec![],
                win_white: vec![],
                moves,
                accuracy: Accuracy { white: 50.0, black: 50.0 },
            },
        );

        let me = [Account::new(Source::Lichess, "me")];
        let r = report(&[a, b, c, d], &reviews, &me);
        assert_eq!((r.games, r.you_first, r.opponent_first), (4, 3, 1));
        assert_eq!(r.positions.len(), 1, "only positions seen at least twice");
        let p = &r.positions[0];
        assert_eq!((p.color.as_str(), p.ply, p.games), ("white", 5, 2));
        assert_eq!((p.wins, p.draws, p.losses), (0, 1, 1));
        assert_eq!(p.played[0].san, "h4");
        assert!(p.book.contains(&"Bb5".to_string()) && p.book.contains(&"Bc4".to_string()), "{:?}", p.book);
        assert_eq!((p.analysed, p.avg_loss, p.errors_after), (1, Some(10.0), 1));
        assert_eq!(p.best.as_deref(), Some("Bb5"));
        assert_eq!(p.game_id, "a", "newest game first");
        assert!(p.fen.starts_with("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2"));
    }
}

