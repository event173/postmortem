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
        .ok_or_else(|| crate::tr!("Illegaler Zug", "Illegal move"))?;
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
    let m = coach::parse_uci(&before, uci).ok_or_else(|| crate::tr!("Illegaler Zug", "Illegal move"))?;
    let mut after = before.clone();
    after.play_unchecked(m);

    let path = engine::find_stockfish()
        .ok_or_else(crate::i18n::no_stockfish)?;
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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LineMove {
    pub uci: String,
    pub san: String,
    /// Position after this move.
    pub fen: String,
    pub check: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Refutation {
    /// Your move first, then the engine's best continuation.
    pub moves: Vec<LineMove>,
    /// Evaluation after your move, from White's point of view.
    pub score: Option<crate::engine::Score>,
    /// Numbered SAN of the whole line, e.g. "14. Nf3 Qxf2+ 15. Kh1 Qxf3".
    pub text: String,
}

/// How many engine moves to show after the user's move.
const REFUTATION_PLIES: usize = 6;

/// Build the line (with positions) from `fen` for a sequence of UCI moves.
pub fn line_moves(fen: &str, ucis: &[String]) -> Result<Vec<LineMove>, String> {
    let mut pos = analysis::parse_fen(fen)?;
    let mut out = Vec::new();
    for uci in ucis {
        let Some(m) = coach::parse_uci(&pos, uci) else { break };
        let san = coach::san(&pos, m);
        pos.play_unchecked(m);
        out.push(LineMove { uci: uci.clone(), san, fen: analysis::fen(&pos), check: pos.is_check() });
    }
    Ok(out)
}

/// What happens after a move: the engine's best continuation for both sides.
pub fn refutation(fen: &str, uci: &str, depth: u32) -> Result<Refutation, String> {
    let before = analysis::parse_fen(fen)?;
    let m = coach::parse_uci(&before, uci).ok_or_else(|| crate::tr!("Illegaler Zug", "Illegal move"))?;
    let mut after = before.clone();
    after.play_unchecked(m);

    let (pv, score) = match analysis::terminal_eval(&after) {
        Some(lines) => (vec![], Some(lines[0].score)),
        None => {
            let path = engine::find_stockfish()
                .ok_or_else(crate::i18n::no_stockfish)?;
            let mut sf = engine::Engine::start(&path, engine::threads(true), 64, 1)?;
            let lines = sf.analyse(&analysis::fen(&after), depth)?;
            let best = lines.into_iter().next();
            (
                best.as_ref().map(|l| l.pv.iter().take(REFUTATION_PLIES).cloned().collect()).unwrap_or_default(),
                best.map(|l| l.score),
            )
        }
    };
    // Engine scores are from the side to move after your move; report White's view.
    let score = score.map(|s| if after.turn() == Color::White { s } else { s.negate() });
    let mut ucis = vec![uci.to_string()];
    ucis.extend(pv);
    Ok(Refutation {
        moves: line_moves(fen, &ucis)?,
        score,
        text: coach::san_line(&before, &ucis, ucis.len()),
    })
}

/// The engine's best line from a position (e.g. "let the engine move").
pub fn engine_line(fen: &str, depth: u32, plies: usize) -> Result<Refutation, String> {
    let pos = analysis::parse_fen(fen)?;
    if let Some(lines) = analysis::terminal_eval(&pos) {
        let score = if pos.turn() == Color::White { lines[0].score } else { lines[0].score.negate() };
        return Ok(Refutation { moves: vec![], score: Some(score), text: String::new() });
    }
    let path = engine::find_stockfish()
        .ok_or_else(crate::i18n::no_stockfish)?;
    let mut sf = engine::Engine::start(&path, engine::threads(true), 64, 1)?;
    let best = sf.analyse(fen, depth)?.into_iter().next().ok_or_else(|| crate::tr!("Die Engine hat keinen Zug gefunden.", "The engine found no move."))?;
    let pv: Vec<String> = best.pv.into_iter().take(plies).collect();
    let score = if pos.turn() == Color::White { best.score } else { best.score.negate() };
    Ok(Refutation { moves: line_moves(fen, &pv)?, score: Some(score), text: coach::san_line(&pos, &pv, pv.len()) })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameStatus {
    pub over: bool,
    /// "white", "black" or None (draw / still running).
    pub winner: Option<String>,
    /// Why it ended, in German.
    pub reason: Option<String>,
}

/// Is the game over after the last of `fens` (all positions so far, in order)?
pub fn game_status(fens: &[String]) -> Result<GameStatus, String> {
    let Some(last) = fens.last() else {
        return Ok(GameStatus { over: false, winner: None, reason: None });
    };
    let pos = analysis::parse_fen(last)?;
    let end = |winner: Option<Color>, reason: &str| GameStatus {
        over: true,
        winner: winner.map(color_name),
        reason: Some(reason.to_string()),
    };
    if pos.is_checkmate() {
        return Ok(end(Some(!pos.turn()), &crate::tr!("Schachmatt", "Checkmate")));
    }
    if pos.is_stalemate() {
        return Ok(end(None, &crate::tr!("Patt", "Stalemate")));
    }
    if pos.is_insufficient_material() {
        return Ok(end(None, &crate::tr!("Zu wenig Material", "Insufficient material")));
    }
    if pos.halfmoves() >= 100 {
        return Ok(end(None, &crate::tr!("50-Züge-Regel", "50-move rule")));
    }
    // Threefold repetition: same placement, side to move, castling and en passant.
    let key = |f: &str| f.split_whitespace().take(4).collect::<Vec<_>>().join(" ");
    let k = key(last);
    if fens.iter().filter(|f| key(f) == k).count() >= 3 {
        return Ok(end(None, &crate::tr!("Dreifache Stellungswiederholung", "Threefold repetition")));
    }
    Ok(GameStatus { over: false, winner: None, reason: None })
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
    fn builds_lines_with_positions() {
        let line = line_moves(START, &["e2e4".into(), "e7e5".into(), "d1h5".into(), "zzzz".into()]).unwrap();
        assert_eq!(line.iter().map(|m| m.san.as_str()).collect::<Vec<_>>(), ["e4", "e5", "Qh5"]);
        assert!(line[2].fen.starts_with("rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b"));
    }

    #[test]
    fn refutation_of_a_mating_move_needs_no_engine() {
        // 4. Qxf7# – the game is over, so the line is just the move itself.
        let fen = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
        let r = refutation(fen, "h5f7", 12).unwrap();
        assert_eq!(r.moves.len(), 1);
        assert_eq!(r.moves[0].san, "Qxf7#");
        assert_eq!(r.text, "4. Qxf7#");
        assert_eq!(r.score.unwrap().win_percent(), 100.0);
    }

    #[test]
    fn engine_line_on_finished_game_is_empty() {
        // Fool's mate: White is checkmated, nothing to play.
        let fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
        let r = engine_line(fen, 10, 4).unwrap();
        assert!(r.moves.is_empty());
        assert_eq!(r.score.unwrap().win_percent(), 0.0);
    }

    #[test]
    fn detects_game_endings() {
        let start = START.to_string();
        assert!(!game_status(std::slice::from_ref(&start)).unwrap().over);
        // Fool's mate
        let mate = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3".to_string();
        let s = game_status(&[mate]).unwrap();
        assert_eq!((s.over, s.winner.as_deref(), s.reason.as_deref()), (true, Some("black"), Some("Schachmatt")));
        let stalemate = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1".to_string();
        assert_eq!(game_status(&[stalemate]).unwrap().reason.as_deref(), Some("Patt"));
        let kings = "8/8/4k3/8/8/3K4/8/8 w - - 0 1".to_string();
        assert_eq!(game_status(&[kings]).unwrap().reason.as_deref(), Some("Zu wenig Material"));
        // The same position three times (move counters differ) = repetition.
        let a = "4k3/8/8/8/8/8/8/R3K3 w - - 0 1";
        let b = "4k3/8/8/8/8/8/8/R3K3 w - - 4 3";
        let c = "4k3/8/8/8/8/8/8/R3K3 w - - 8 5";
        let three: Vec<String> = [a, b, c].iter().map(|s| s.to_string()).collect();
        assert_eq!(game_status(&three).unwrap().reason.as_deref(), Some("Dreifache Stellungswiederholung"));
        assert!(!game_status(&three[..2]).unwrap().over, "twice is not enough");
    }

    #[test]
    fn rejects_illegal_moves() {
        assert!(play_move(START, "e2", "e5", None).is_err());
    }
}
