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

pub fn epd(pos: &Chess) -> String {
    Epd::from_position(pos, EnPassantMode::Legal).to_string()
}

pub(crate) fn play_san_line(moves: impl IntoIterator<Item = impl AsRef<str>>) -> Option<Chess> {
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

/// One named line of the dataset, e.g. "Caro-Kann Defense: Advance Variation".
#[derive(Debug, Clone)]
pub struct Line {
    /// Stable id: ECO code + name (unique in the dataset).
    pub id: String,
    pub eco: String,
    pub name: String,
    /// The part before the colon, e.g. "Caro-Kann Defense".
    pub family: String,
    /// UCI moves from the starting position.
    pub moves: Vec<String>,
}

/// Family name of an opening name ("Sicilian Defense: Najdorf" -> "Sicilian Defense").
pub fn family_of(name: &str) -> &str {
    name.split(':').next().unwrap_or(name).trim()
}

impl Line {
    /// Variation group: "Caro-Kann Defense: Advance Variation, Short Variation"
    /// -> "Advance Variation"; lines without a sub-name are the main line.
    pub fn variation(&self) -> &str {
        match self.name.split_once(':') {
            Some((_, rest)) => rest.split(',').next().unwrap_or(rest).trim(),
            None => MAIN_LINE,
        }
    }

    /// Name without the family, e.g. "Advance Variation, Short Variation".
    pub fn short_name(&self) -> &str {
        self.name.split_once(':').map_or(MAIN_LINE, |(_, rest)| rest.trim())
    }
}

pub const MAIN_LINE: &str = "Hauptvariante";

/// All lines of the dataset (parsed once).
pub fn lines() -> &'static [Line] {
    static LINES: OnceLock<Vec<Line>> = OnceLock::new();
    LINES.get_or_init(|| {
        let mut out: Vec<Line> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for row in DATA.lines() {
            let mut cols = row.split('\t');
            let (Some(eco), Some(name), Some(pgn)) = (cols.next(), cols.next(), cols.next()) else { continue };
            let mut pos = Chess::default();
            let mut moves = Vec::new();
            for san in pgn.split_whitespace().filter(|t| !t.ends_with('.')) {
                let Some(m) = san.parse::<SanPlus>().ok().and_then(|s| s.san.to_move(&pos).ok()) else { break };
                moves.push(shakmaty::uci::UciMove::from_move(m, shakmaty::CastlingMode::Standard).to_string());
                pos.play_unchecked(m);
            }
            let mut id = format!("{eco} {name}");
            if !seen.insert(id.clone()) {
                id = format!("{id} #{}", out.len());
                seen.insert(id.clone());
            }
            out.push(Line { id, eco: eco.to_string(), family: family_of(name).to_string(), name: name.to_string(), moves });
        }
        out
    })
}

/// Every position on the way of a named line ("theory"), and the theory moves
/// from each of them.
pub struct Book {
    pub positions: std::collections::HashSet<String>,
    /// EPD -> UCI moves that stay in theory, the move with the most named lines
    /// behind it (≈ the main line) first.
    pub next: HashMap<String, Vec<String>>,
}

pub fn book() -> &'static Book {
    static BOOK: OnceLock<Book> = OnceLock::new();
    BOOK.get_or_init(|| {
        let mut positions = std::collections::HashSet::new();
        let mut counts: HashMap<String, Vec<(String, usize)>> = HashMap::new();
        let start = Chess::default();
        positions.insert(epd(&start));
        for line in lines() {
            let mut pos = start.clone();
            for uci in &line.moves {
                let Some(m) = uci.parse::<shakmaty::uci::UciMove>().ok().and_then(|u| u.to_move(&pos).ok()) else { break };
                let moves = counts.entry(epd(&pos)).or_default();
                match moves.iter_mut().find(|(u, _)| u == uci) {
                    Some((_, n)) => *n += 1,
                    None => moves.push((uci.clone(), 1)),
                }
                pos.play_unchecked(m);
                positions.insert(epd(&pos));
            }
        }
        let next = counts
            .into_iter()
            .map(|(k, mut moves)| {
                // Stable: equal counts keep the dataset order.
                moves.sort_by_key(|m| std::cmp::Reverse(m.1));
                (k, moves.into_iter().map(|(u, _)| u).collect())
            })
            .collect();
        Book { positions, next }
    })
}

/// Name of the opening of exactly this position, if it has one.
pub fn name_at(pos: &Chess) -> Option<String> {
    table().get(&epd(pos)).map(|(_, name)| name.clone())
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
    fn book_knows_main_lines_and_their_continuations() {
        let b = book();
        let start = epd(&Chess::default());
        // Most theory behind 1. e4 and 1. d4.
        let first: Vec<&str> = b.next[&start].iter().take(2).map(String::as_str).collect();
        assert!(first.contains(&"e2e4") && first.contains(&"d2d4"), "{first:?}");
        let after_e4 = play_san_line(["e4"]).unwrap();
        assert!(b.positions.contains(&epd(&after_e4)));
        // Nonsense is not theory.
        let silly = play_san_line(["h4", "h5", "a4", "a5", "b4", "b5"]).unwrap();
        assert!(!b.positions.contains(&epd(&silly)));
    }

    #[test]
    fn dataset_loads() {
        assert!(table().len() > 3000);
    }

    #[test]
    fn lines_have_ids_families_and_uci_moves() {
        let all = lines();
        assert!(all.len() > 3000);
        let ids: std::collections::HashSet<_> = all.iter().map(|l| &l.id).collect();
        assert_eq!(ids.len(), all.len(), "ids must be unique");
        let caro = all.iter().find(|l| l.name == "Caro-Kann Defense: Advance Variation").unwrap();
        assert_eq!(caro.family, "Caro-Kann Defense");
        assert_eq!(&caro.moves[..5], ["e2e4", "c7c6", "d2d4", "d7d5", "e4e5"]);
        assert_eq!(family_of("Sicilian Defense: Najdorf Variation"), "Sicilian Defense");
        let short = all.iter().find(|l| l.name == "Caro-Kann Defense: Advance Variation, Short Variation").unwrap();
        assert_eq!(short.variation(), "Advance Variation");
        assert_eq!(short.short_name(), "Advance Variation, Short Variation");
        let main = all.iter().find(|l| l.name == "Caro-Kann Defense").unwrap();
        assert_eq!(main.variation(), MAIN_LINE);
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
