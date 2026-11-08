//! Weakness statistics over all reviewed games of a player.

use std::collections::HashMap;

use serde::Serialize;
use shakmaty::{Position, Role};

use crate::analysis::{self, Class, GameReview};
use crate::coach::{piece_value, Theme};
use crate::db::Account;
use crate::lichess::GameInfo;

/// Moves 1–10 count as opening.
const OPENING_PLIES: usize = 20;
/// Total non-pawn material (both sides, Q=9 R=5 B=N=3) at or below which it's an endgame.
/// The starting position has 62.
const ENDGAME_MATERIAL: i32 = 26;
const MAX_EXAMPLES: usize = 12;
const TREND_GAMES: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Opening,
    Middlegame,
    Endgame,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub game_id: String,
    pub ply: usize,
    pub san: String,
    pub classification: Class,
    pub created_at: i64,
    pub opponent: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeStat {
    pub theme: Theme,
    pub count: usize,
    /// Occurrences per game across *all* analysed games, when the stats cover
    /// only the most recent ones – lets the UI show whether it got better.
    pub baseline_per_game: Option<f64>,
    /// Most recent occurrences first.
    pub examples: Vec<Example>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhaseStat {
    pub moves: usize,
    pub inaccuracies: usize,
    /// Mistakes, misses and blunders.
    pub mistakes: usize,
    pub blunders: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub game_id: String,
    pub created_at: i64,
    pub accuracy: f64,
    /// "win", "loss" or "draw" from the player's point of view.
    pub result: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaknessStats {
    pub games_total: usize,
    pub games_analysed: usize,
    /// The player's own moves across all analysed games.
    pub moves: usize,
    pub accuracy_avg: Option<f64>,
    pub classes: HashMap<Class, usize>,
    /// Sorted by count, most frequent first.
    pub themes: Vec<ThemeStat>,
    pub phases: HashMap<Phase, PhaseStat>,
    /// Accuracy per game, oldest first.
    pub trend: Vec<TrendPoint>,
}

fn phase_of(review: &GameReview, ply: usize) -> Phase {
    if ply <= OPENING_PLIES {
        return Phase::Opening;
    }
    let material = review
        .fens
        .get(ply - 1)
        .and_then(|f| analysis::parse_fen(f).ok())
        .map(|pos| {
            let board = pos.board();
            [Role::Knight, Role::Bishop, Role::Rook, Role::Queen]
                .into_iter()
                .map(|r| board.by_role(r).count() as i32 * piece_value(r))
                .sum::<i32>()
        })
        .unwrap_or(i32::MAX);
    if material <= ENDGAME_MATERIAL { Phase::Endgame } else { Phase::Middlegame }
}

/// `games` newest first, as returned by the database.
pub fn compute(accounts: &[Account], games_total: usize, games: &[(GameInfo, GameReview)]) -> WeaknessStats {
    let mut classes: HashMap<Class, usize> = HashMap::new();
    let mut themes: HashMap<Theme, ThemeStat> = HashMap::new();
    let mut phases: HashMap<Phase, PhaseStat> = HashMap::new();
    let mut trend = Vec::new();
    let mut moves = 0;
    let mut accuracy_sum = 0.0;
    let mut counted = 0;

    for (game, review) in games {
        let Some(me) = accounts.iter().find(|a| a.source == game.source).map(|a| a.username.to_lowercase()) else {
            continue;
        };
        let color = if game.white.name.to_lowercase() == me {
            "white"
        } else if game.black.name.to_lowercase() == me {
            "black"
        } else {
            continue;
        };
        counted += 1;
        let accuracy = if color == "white" { review.accuracy.white } else { review.accuracy.black };
        accuracy_sum += accuracy;
        let opponent = if color == "white" { &game.black.name } else { &game.white.name };
        if trend.len() < TREND_GAMES {
            let result = match game.winner.as_deref() {
                None => "draw",
                Some(w) if w == color => "win",
                Some(_) => "loss",
            };
            trend.push(TrendPoint {
                game_id: game.id.clone(),
                created_at: game.created_at,
                accuracy,
                result: result.into(),
            });
        }

        for m in review.moves.iter().filter(|m| m.color == color) {
            moves += 1;
            *classes.entry(m.classification).or_default() += 1;
            let phase = phases.entry(phase_of(review, m.ply)).or_default();
            phase.moves += 1;
            match m.classification {
                Class::Inaccuracy => phase.inaccuracies += 1,
                Class::Mistake | Class::Miss => phase.mistakes += 1,
                Class::Blunder => {
                    phase.mistakes += 1;
                    phase.blunders += 1;
                }
                _ => {}
            }
            // Themes only for real errors; inaccuracies are mostly noise.
            let serious = matches!(m.classification, Class::Mistake | Class::Miss | Class::Blunder);
            if let (true, Some(theme)) = (serious, m.theme) {
                let stat = themes
                    .entry(theme)
                    .or_insert_with(|| ThemeStat { theme, count: 0, baseline_per_game: None, examples: vec![] });
                stat.count += 1;
                if stat.examples.len() < MAX_EXAMPLES {
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
    }

    let mut themes: Vec<ThemeStat> = themes.into_values().collect();
    themes.sort_by_key(|t| std::cmp::Reverse(t.count));
    trend.reverse();
    WeaknessStats {
        games_total,
        games_analysed: counted,
        moves,
        accuracy_avg: (counted > 0).then(|| (accuracy_sum / counted as f64 * 10.0).round() / 10.0),
        classes,
        themes,
        phases,
        trend,
    }
}

/// Stats over the `last` most recent games (all if `None`), with each theme's
/// rate over all games as baseline. `games` newest first.
pub fn compute_window(
    accounts: &[Account],
    games_total: usize,
    games: &[(GameInfo, GameReview)],
    last: Option<usize>,
) -> WeaknessStats {
    let n = last.unwrap_or(games.len()).min(games.len());
    let mut stats = compute(accounts, games_total, &games[..n]);
    if n < games.len() {
        let all = compute(accounts, games_total, games);
        for t in &mut stats.themes {
            let base = all.themes.iter().find(|b| b.theme == t.theme).map_or(0, |b| b.count);
            t.baseline_per_game = (all.games_analysed > 0).then(|| base as f64 / all.games_analysed as f64);
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::{Accuracy, MoveReview, REVIEW_VERSION};
    use crate::lichess::Player;

    fn mv(ply: usize, class: Class, theme: Option<Theme>) -> MoveReview {
        MoveReview {
            ply,
            color: if ply % 2 == 1 { "white".into() } else { "black".into() },
            san: "e4".into(),
            uci: "e2e4".into(),
            classification: class,
            win_before: 50.0,
            win_after: 50.0,
            best_san: None,
            best_uci: None,
            best_line: None,
            comment: String::new(),
            theme,
        }
    }

    fn game(id: &str, white: &str, black: &str, winner: Option<&str>, at: i64) -> GameInfo {
        GameInfo {
            id: id.into(),
            source: Default::default(),
            url: None,
            white: Player { name: white.into(), rating: None },
            black: Player { name: black.into(), rating: None },
            winner: winner.map(Into::into),
            status: "mate".into(),
            speed: "blitz".into(),
            rated: true,
            time_control: None,
            created_at: at,
            opening: None,
            moves: vec![],
        }
    }

    fn review(id: &str, white_acc: f64, black_acc: f64, moves: Vec<MoveReview>) -> GameReview {
        GameReview {
            version: REVIEW_VERSION,
            game_id: id.into(),
            depth: 16,
            fens: vec![],
            evals: vec![],
            win_white: vec![],
            moves,
            accuracy: Accuracy { white: white_acc, black: black_acc },
        }
    }

    #[test]
    fn counts_only_the_players_own_moves() {
        let games = vec![
            (
                game("g2", "opp", "Me", Some("black"), 2),
                review(
                    "g2",
                    70.0,
                    80.0,
                    vec![
                        mv(1, Class::Blunder, Some(Theme::HangingPiece)), // opponent's
                        mv(2, Class::Blunder, Some(Theme::AllowedFork)),
                        mv(4, Class::Inaccuracy, Some(Theme::Positional)),
                    ],
                ),
            ),
            (
                game("g1", "me", "opp", None, 1),
                review(
                    "g1",
                    60.0,
                    50.0,
                    vec![mv(1, Class::Mistake, Some(Theme::AllowedFork)), mv(3, Class::Best, None)],
                ),
            ),
        ];
        let s = compute(&[Account::new(crate::lichess::Source::Lichess, "ME")], 5, &games);
        assert_eq!(s.games_total, 5);
        assert_eq!(s.games_analysed, 2);
        assert_eq!(s.moves, 4);
        assert_eq!(s.accuracy_avg, Some(70.0));
        assert_eq!(s.themes.len(), 1, "inaccuracy themes and opponent moves are ignored");
        assert_eq!(s.themes[0].theme, Theme::AllowedFork);
        assert_eq!(s.themes[0].count, 2);
        assert_eq!(s.themes[0].examples[0].game_id, "g2");
        let opening = &s.phases[&Phase::Opening];
        assert_eq!((opening.moves, opening.mistakes, opening.blunders, opening.inaccuracies), (4, 2, 1, 1));
        // Trend is chronological.
        assert_eq!(s.trend.iter().map(|t| t.result.as_str()).collect::<Vec<_>>(), ["draw", "win"]);

        // Only the newest game, compared with both.
        let me = [Account::new(crate::lichess::Source::Lichess, "me")];
        let w = compute_window(&me, 5, &games, Some(1));
        assert_eq!(w.games_analysed, 1);
        assert_eq!(w.themes[0].count, 1);
        assert_eq!(w.themes[0].baseline_per_game, Some(1.0)); // 2 forks in 2 games
        assert_eq!(compute_window(&me, 5, &games, None).themes[0].baseline_per_game, None);
    }
}
