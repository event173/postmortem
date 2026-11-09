//! Playing against Stockfish at different strengths.
//!
//! Levels 1–3 (below ~800) play part of their moves at random – even
//! Stockfish's weakest setting is too strong for real beginners; levels 4–6
//! use Stockfish's "Skill Level" (it picks weaker moves on purpose) with a
//! shallow search; from ~1400 Elo its built-in Elo limit (UCI_LimitStrength,
//! minimum 1320); level 11 plays at full strength.

use std::sync::Mutex;

use serde::Serialize;

use crate::engine::{self, Engine};

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub level: u8,
    /// Approximate playing strength.
    pub elo: u32,
    pub label: &'static str,
}

/// How a level plays: (Skill Level, Elo limit, search limit).
fn config(level: u8) -> (u8, Option<u32>, &'static str) {
    match level {
        1..=4 => (0, None, "depth 1"),
        5 => (3, None, "depth 3"),
        6 => (6, None, "depth 5"),
        7 => (20, Some(1400), "movetime 300"),
        8 => (20, Some(1700), "movetime 400"),
        9 => (20, Some(2000), "movetime 500"),
        10 => (20, Some(2400), "movetime 700"),
        _ => (20, None, "movetime 1000"),
    }
}

/// Share of moves played at random (the weakest levels).
fn random_share(level: u8) -> f64 {
    match level {
        1 => 0.6,
        2 => 0.35,
        3 => 0.15,
        _ => 0.0,
    }
}

pub fn levels() -> Vec<Level> {
    [
        (1, 400, "Erste Schritte"),
        (2, 550, "Neuling"),
        (3, 700, "Lernt noch"),
        (4, 800, "Anfänger"),
        (5, 1000, "Einsteiger"),
        (6, 1200, "Gelegenheitsspieler"),
        (7, 1400, "Vereinsspieler"),
        (8, 1700, "Fortgeschritten"),
        (9, 2000, "Experte"),
        (10, 2400, "Meister"),
        (11, 2800, "Großmeister+"),
    ]
    .into_iter()
    .map(|(level, elo, label)| Level { level, elo, label })
    .collect()
}

pub fn level_elo(level: u8) -> u32 {
    levels().iter().find(|l| l.level == level).map_or(1500, |l| l.elo)
}

/// One engine process for bot games, kept alive between moves (loading the
/// network takes a moment).
#[derive(Default)]
pub struct Bot {
    engine: Mutex<Option<Engine>>,
}

impl Bot {
    pub fn reset(&self) {
        *self.engine.lock().unwrap() = None;
    }

    /// The bot's move in `fen` at `level`, or None if it has no legal move.
    pub fn play(&self, fen: &str, level: u8) -> Result<Option<String>, String> {
        if fastrand::f64() < random_share(level)
            && let Some(m) = random_move(fen)?
        {
            return Ok(Some(m));
        }
        let mut guard = self.engine.lock().unwrap();
        if guard.is_none() {
            let path = engine::find_stockfish()
                .ok_or_else(crate::i18n::no_stockfish)?;
            // Strong levels may use more threads; weak ones are limited anyway.
            let threads = if level >= 11 { engine::threads(true) } else { 1 };
            *guard = Some(Engine::start(&path, threads, 64, 1)?);
        }
        let sf = guard.as_mut().unwrap();
        let (skill, elo, go) = config(level);
        sf.set_option("Skill Level", &skill.to_string())?;
        sf.set_option("UCI_LimitStrength", if elo.is_some() { "true" } else { "false" })?;
        if let Some(elo) = elo {
            sf.set_option("UCI_Elo", &elo.to_string())?;
        }
        sf.sync()?;
        let result = sf.best_move(fen, go);
        if result.is_err() {
            *guard = None; // engine died: start fresh next time
        }
        result
    }
}

/// A random legal move (UCI), as a beginner might play it.
fn random_move(fen: &str) -> Result<Option<String>, String> {
    use shakmaty::{uci::UciMove, CastlingMode, Position};
    let pos = crate::analysis::parse_fen(fen)?;
    let moves = pos.legal_moves();
    if moves.is_empty() {
        return Ok(None);
    }
    let m = moves[fastrand::usize(..moves.len())];
    Ok(Some(UciMove::from_move(m, CastlingMode::Standard).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_ordered_and_configured() {
        let l = levels();
        assert_eq!(l.len(), 11);
        assert!(l.windows(2).all(|w| w[0].elo < w[1].elo));
        assert!(l.iter().enumerate().all(|(i, x)| x.level as usize == i + 1));
        // The Elo limit only works from 1320 upwards.
        for lv in 1..=11 {
            if let (_, Some(elo), _) = config(lv) {
                assert!(elo >= 1320);
            }
        }
        assert_eq!(level_elo(6), 1200);
        // Only the weakest levels play at random, and less so the stronger they get.
        assert!(random_share(1) > random_share(2) && random_share(2) > random_share(3));
        assert_eq!(random_share(4), 0.0);
    }

    #[test]
    fn random_moves_are_legal() {
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        for _ in 0..20 {
            let m = random_move(start).unwrap().unwrap();
            assert!(crate::explore::play_move(start, &m[0..2], &m[2..4], None).is_ok(), "{m}");
        }
        // Checkmated: no move.
        assert_eq!(random_move("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1").unwrap(), None);
    }
}
