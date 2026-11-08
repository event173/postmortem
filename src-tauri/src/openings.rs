//! Opening names for games that don't come with one (chess.com), from the
//! Lichess `chess-openings` dataset (CC0), embedded so it works offline.
//!
//! Positions are matched (not move orders), so transpositions are recognised.

use std::collections::HashMap;
use std::sync::OnceLock;

use shakmaty::{fen::Epd, san::SanPlus, Chess, EnPassantMode, Position};

use crate::lichess::Opening;

const DATA: &str = include_str!("../data/openings.tsv");
/// Openings in the dataset are at most this long; no need to look further.
const MAX_PLIES: usize = 40;

fn epd(pos: &Chess) -> String {
    Epd::from_position(pos, EnPassantMode::Legal).to_string()
}

fn play_san_line(moves: impl IntoIterator<Item = impl AsRef<str>>) -> Option<Chess> {
    let mut pos = Chess::default();
    for san in moves {
        let m = san.as_ref().parse::<SanPlus>().ok()?.san.to_move(&pos).ok()?;
        pos.play_unchecked(m);
    }
    Some(pos)
}

fn table() -> &'static HashMap<String, (String, String)> {
    static TABLE: OnceLock<HashMap<String, (String, String)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut map = HashMap::new();
        for line in DATA.lines() {
            let mut cols = line.split('\t');
            let (Some(eco), Some(name), Some(pgn)) = (cols.next(), cols.next(), cols.next()) else { continue };
            // "1. e4 e5 2. Nf3" -> ["e4", "e5", "Nf3"]
            let sans = pgn.split_whitespace().filter(|t| !t.ends_with('.'));
            if let Some(pos) = play_san_line(sans) {
                // Keep the first (most general) name if two entries reach the same position.
                map.entry(epd(&pos)).or_insert_with(|| (eco.to_string(), name.to_string()));
            }
        }
        map
    })
}

/// The deepest named opening position reached in the game.
pub fn identify(moves: &[String]) -> Option<Opening> {
    let table = table();
    let mut pos = Chess::default();
    let mut found = None;
    for (i, san) in moves.iter().take(MAX_PLIES).enumerate() {
        let Some(m) = san.parse::<SanPlus>().ok().and_then(|s| s.san.to_move(&pos).ok()) else { break };
        pos.play_unchecked(m);
        if let Some((eco, name)) = table.get(&epd(&pos)) {
            found = Some(Opening { eco: eco.clone(), name: name.clone(), ply: i + 1 });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moves(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn dataset_loads() {
        assert!(table().len() > 3000);
    }

    #[test]
    fn identifies_ruy_lopez() {
        let o = identify(&moves("e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Qe2 d6 h3")).unwrap();
        assert!(o.name.starts_with("Ruy Lopez"), "{}", o.name);
        assert!(o.eco.starts_with('C'));
        assert!(o.ply >= 6 && o.ply <= 11, "{}", o.ply);
    }

    #[test]
    fn recognises_transpositions() {
        // Italian Game reached via 1. Nf3 move order.
        let o = identify(&moves("Nf3 Nc6 e4 e5 Bc4")).unwrap();
        assert!(o.name.contains("Italian"), "{}", o.name);
        assert_eq!(o.ply, 5);
    }

    #[test]
    fn scandinavian_from_chesscom_example() {
        let o = identify(&moves("e4 d5 exd5 Qxd5 Nc3 Qa5 g3 Nf6 Bg2 c6 Nge2 Bf5")).unwrap();
        assert!(o.name.starts_with("Scandinavian Defense"), "{}", o.name);
        assert_eq!(o.eco, "B01");
    }
}
