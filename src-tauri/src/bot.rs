//! Playing against Stockfish at different strengths.
//!
//! Levels 1–3 use Stockfish's "Skill Level" (it picks weaker moves on purpose)
//! with a shallow search; from ~1400 Elo its built-in Elo limit
//! (UCI_LimitStrength, minimum 1320); level 8 plays at full strength.

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
        1 => (0, None, "depth 1"),
        2 => (3, None, "depth 3"),
        3 => (6, None, "depth 5"),
        4 => (20, Some(1400), "movetime 300"),
        5 => (20, Some(1700), "movetime 400"),
        6 => (20, Some(2000), "movetime 500"),
        7 => (20, Some(2400), "movetime 700"),
        _ => (20, None, "movetime 1000"),
    }
}

pub fn levels() -> Vec<Level> {
    [
        (1, 800, "Anfänger"),
        (2, 1000, "Einsteiger"),
        (3, 1200, "Gelegenheitsspieler"),
        (4, 1400, "Vereinsspieler"),
        (5, 1700, "Fortgeschritten"),
        (6, 2000, "Experte"),
        (7, 2400, "Meister"),
        (8, 2800, "Großmeister+"),
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
        let mut guard = self.engine.lock().unwrap();
        if guard.is_none() {
            let path = engine::find_stockfish()
                .ok_or("Stockfish wurde nicht gefunden. Installiere es z. B. mit: sudo apt install stockfish")?;
            // Strong levels may use more threads; weak ones are limited anyway.
            let threads = if level >= 8 { engine::threads(true) } else { 1 };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_ordered_and_configured() {
        let l = levels();
        assert_eq!(l.len(), 8);
        assert!(l.windows(2).all(|w| w[0].elo < w[1].elo));
        // The Elo limit only works from 1320 upwards.
        for lv in 1..=8 {
            if let (_, Some(elo), _) = config(lv) {
                assert!(elo >= 1320);
            }
        }
        assert_eq!(level_elo(3), 1200);
    }
}
