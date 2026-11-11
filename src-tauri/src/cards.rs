//! Your own flashcards: a position from a review, from free play or from a game
//! against the bot, with Stockfish's best moves. They live in the same
//! flashcard box as the opening lines (progress in `opening_progress` under
//! "card:<id>") and come back under "Wiederholen".

use serde::{Deserialize, Serialize};
use shakmaty::Position;

use crate::analysis;
use crate::coach;
use crate::db::Db;
use crate::engine::{self, Score};

/// Candidate moves stored with a card.
const BEST: usize = 3;
const DEPTH: u32 = 18;
/// Plies of the continuation shown after each best move.
const LINE_PLIES: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BestMove {
    pub uci: String,
    pub san: String,
    /// From the point of view of the side to move (you).
    pub score: Score,
    /// The move and Stockfish's continuation, e.g. "14. Nf3 Qxf2+ 15. Kh1".
    pub line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub fen: String,
    /// The side to move – yours on this card.
    pub color: String,
    pub best: Vec<BestMove>,
    /// What was played there (SAN), if the card comes from a game.
    pub played: Option<String>,
    /// "review", "explore" or "play".
    pub source: String,
    pub game_id: Option<String>,
    pub ply: Option<usize>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    #[serde(flatten)]
    pub card: Card,
    /// 0 = not practised yet, 1..=5 = box.
    pub box_level: u8,
    pub due: bool,
    pub due_at: i64,
}

pub fn progress_id(card_id: &str) -> String {
    format!("card:{card_id}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Same position (pieces, side to move, castling, en passant) = same card.
fn card_id(pos: &shakmaty::Chess) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    crate::openings::epd(pos).hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Stockfish's `n` best moves in a position (fewer if there are fewer legal moves).
pub fn best_moves(pos: &shakmaty::Chess, n: usize, depth: u32) -> Result<Vec<BestMove>, String> {
    use shakmaty::Position;
    let n = n.min(pos.legal_moves().len());
    if n == 0 {
        return Ok(Vec::new());
    }
    let path = engine::find_stockfish().ok_or_else(crate::i18n::no_stockfish)?;
    let mut sf = engine::Engine::start(&path, engine::threads(true), 64, n)?;
    let lines = sf.analyse(&analysis::fen(pos), depth)?;
    Ok(lines
        .into_iter()
        .filter_map(|l| {
            let first = l.pv.first()?.clone();
            let m = coach::parse_uci(pos, &first)?;
            Some(BestMove { san: coach::san(pos, m), score: l.score, line: coach::san_line(pos, &l.pv, LINE_PLIES), uci: first })
        })
        .collect())
}

/// Analyse the position and build a card (doesn't store it; this takes a few seconds).
pub fn build(fen: &str, played: Option<&str>, source: &str, game_id: Option<String>, ply: Option<usize>) -> Result<Card, String> {
    let pos = analysis::parse_fen(fen)?;
    if pos.legal_moves().is_empty() {
        return Err(crate::tr!("In dieser Stellung gibt es keinen Zug mehr.", "There is no move left in this position."));
    }
    let best = best_moves(&pos, BEST, DEPTH)?;
    if best.is_empty() {
        return Err(crate::tr!("Stockfish hat keinen Zug gefunden.", "Stockfish found no move."));
    }
    let played = played.and_then(|uci| coach::parse_uci(&pos, uci).map(|m| coach::san(&pos, m)));
    Ok(Card {
        id: card_id(&pos),
        fen: analysis::fen(&pos),
        color: if pos.turn() == shakmaty::Color::White { "white" } else { "black" }.into(),
        best,
        played,
        source: source.into(),
        game_id,
        ply,
        created_at: now_ms(),
    })
}

/// All cards with their place in the flashcard box, newest first.
pub fn list(db: &Db) -> Result<Vec<CardInfo>, String> {
    let now = now_ms();
    let (w, b) = (db.opening_progress("white")?, db.opening_progress("black")?);
    Ok(db
        .cards()?
        .into_iter()
        .map(|card| {
            let p = (if card.color == "white" { &w } else { &b }).get(&progress_id(&card.id)).copied();
            CardInfo {
                box_level: p.map_or(0, |p| p.box_),
                // A new card is due right away.
                due: p.is_none_or(|p| p.due <= now),
                due_at: p.map_or(0, |p| p.due),
                card,
            }
        })
        .collect())
}

/// Due cards, the longest overdue first (new cards count as due since they were made).
pub fn due(db: &Db) -> Result<Vec<CardInfo>, String> {
    let mut cards: Vec<CardInfo> = list(db)?.into_iter().filter(|c| c.due).collect();
    cards.sort_by_key(|c| if c.box_level == 0 { c.card.created_at } else { c.due_at });
    Ok(cards)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, color: &str) -> Card {
        Card {
            id: id.into(),
            fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1".into(),
            color: color.into(),
            best: vec![BestMove { uci: "c7c5".into(), san: "c5".into(), score: Score::Cp(20), line: "1... c5".into() }],
            played: Some("a6".into()),
            source: "review".into(),
            game_id: Some("g1".into()),
            ply: Some(2),
            created_at: 5,
        }
    }

    #[test]
    fn store_list_practise_delete() {
        let db = Db::in_memory();
        db.save_card(&card("a", "black")).unwrap();
        // Saving the same position again replaces it instead of adding a second card.
        db.save_card(&card("a", "black")).unwrap();
        let all = list(&db).unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].due && all[0].box_level == 0, "a new card is due");
        assert_eq!(all[0].card.best[0].san, "c5");

        crate::repertoire::record(&db, &progress_id("a"), "black", true).unwrap();
        let after = list(&db).unwrap();
        assert_eq!(after[0].box_level, 1);
        assert!(!after[0].due, "comes back in 10 minutes");
        assert!(due(&db).unwrap().is_empty());

        db.delete_card("a").unwrap();
        assert!(list(&db).unwrap().is_empty());
    }

    #[test]
    fn same_position_same_id() {
        let a = analysis::parse_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1").unwrap();
        let b = analysis::parse_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 3 7").unwrap();
        assert_eq!(card_id(&a), card_id(&b), "move counters don't matter");
    }
}
