//! Free exploration on the board: legal moves, playing moves, judging your own tries.

use std::collections::BTreeMap;

use serde::Serialize;
use shakmaty::{uci::UciMove, CastlingMode, Color, Position};

use crate::analysis::{self, MoveInput, MoveReview};
use crate::coach;
use crate::engine;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionInfo {
    pub turn: String,
    /// Legal destinations per origin square, as chessground expects them.
    pub dests: BTreeMap<String, Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayedMove {
    pub fen: String,
    pub san: String,
    pub uci: String,
    pub check: bool,
}

fn color_name(c: Color) -> String {
    if c == Color::White { "white".into() } else { "black".into() }
}

pub fn position_info(fen: &str) -> Result<PositionInfo, String> {
    let pos = analysis::parse_fen(fen)?;
    let mut dests: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for m in pos.legal_moves() {
        // Standard UCI gives castling as king to g/c-file (e1g1), which is what the board drags.
        let uci = UciMove::from_move(m, CastlingMode::Standard).to_string();
        let (from, to) = (uci[0..2].to_string(), uci[2..4].to_string());
        let list = dests.entry(from).or_default();
        if !list.contains(&to) {
            list.push(to);
        }
    }
    Ok(PositionInfo { turn: color_name(pos.turn()), dests })
}

/// Play a move given by its squares. Promotions default to a queen unless `promotion` is set.
pub fn play_move(fen: &str, from: &str, to: &str, promotion: Option<&str>) -> Result<PlayedMove, String> {
    let pos = analysis::parse_fen(fen)?;
    let prefix = format!("{from}{to}");
    let wanted = format!("{prefix}{}", promotion.unwrap_or("q"));
    let m = pos
        .legal_moves()
        .into_iter()
        .map(|m| (m, UciMove::from_move(m, CastlingMode::Standard).to_string()))
        .filter(|(_, u)| u.starts_with(&prefix))
        .find(|(_, u)| u.len() == 4 || *u == wanted)
        .map(|(m, _)| m)
        .ok_or("Illegaler Zug")?;
    let san = coach::san(&pos, m);
    let mut after = pos.clone();
    after.play_unchecked(m);
    Ok(PlayedMove {
        fen: analysis::fen(&after),
        san,
        uci: UciMove::from_move(m, CastlingMode::Standard).to_string(),
        check: after.is_check(),
    })
}

/// Analyse the position before and after a move and classify it like a game move.
pub fn evaluate_move(fen: &str, uci: &str, depth: u32) -> Result<MoveReview, String> {
    let before = analysis::parse_fen(fen)?;
    let m = coach::parse_uci(&before, uci).ok_or("Illegaler Zug")?;
    let mut after = before.clone();
    after.play_unchecked(m);

    let path = engine::find_stockfish()
        .ok_or("Stockfish wurde nicht gefunden. Installiere es z. B. mit: sudo apt install stockfish")?;
    let threads = engine::threads(true);
    let mut sf = engine::Engine::start(&path, threads, 64, 2)?;
    let mut eval = |p: &shakmaty::Chess| match analysis::terminal_eval(p) {
        Some(l) => Ok(l),
        None => sf.analyse(&analysis::fen(p), depth),
    };
    let lines_before = eval(&before)?;
    let lines_after = eval(&after)?;

    let ply = (before.fullmoves().get() as usize - 1) * 2 + if before.turn() == Color::White { 1 } else { 2 };
    let (review, _) = analysis::review_move(&MoveInput {
        ply,
        book_plies: 0,
        opening: None,
        before: &before,
        after: &after,
        played: m,
        lines_before: &lines_before,
        lines_after: &lines_after,
        opponent_blundered: false,
    });
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    #[test]
    fn start_position_has_twenty_moves() {
        let info = position_info(START).unwrap();
        assert_eq!(info.turn, "white");
        assert_eq!(info.dests.values().map(Vec::len).sum::<usize>(), 20);
        assert_eq!(info.dests["g1"], vec!["f3", "h3"]);
    }

    #[test]
    fn castling_uses_king_destination() {
        let fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
        let info = position_info(fen).unwrap();
        assert!(info.dests["e1"].contains(&"g1".to_string()));
        assert!(info.dests["e1"].contains(&"c1".to_string()));
        let played = play_move(fen, "e1", "g1", None).unwrap();
        assert_eq!(played.san, "O-O");
    }

    #[test]
    fn promotion_defaults_to_queen() {
        let fen = "8/P6k/8/8/8/8/8/K7 w - - 0 1";
        let played = play_move(fen, "a7", "a8", None).unwrap();
        assert_eq!(played.san, "a8=Q");
        let knight = play_move(fen, "a7", "a8", Some("n")).unwrap();
        assert_eq!(knight.san, "a8=N");
    }

    #[test]
    fn rejects_illegal_moves() {
        assert!(play_move(START, "e2", "e5", None).is_err());
    }
}
