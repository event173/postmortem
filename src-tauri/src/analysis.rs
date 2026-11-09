//! Game review: move classification and accuracy, built from per-position engine evals.

use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Move, Position};

use crate::i18n::{self, Lang};
use crate::coach::{self, MoveContext};
use crate::engine::{PvLine, Score};
use crate::lichess::GameInfo;

/// Bump when classification logic changes so cached reviews are recomputed.
pub const REVIEW_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Class {
    Brilliant,
    Great,
    Best,
    Excellent,
    Good,
    Book,
    Forced,
    Inaccuracy,
    Mistake,
    Miss,
    Blunder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReview {
    pub ply: usize,
    pub color: String,
    pub san: String,
    pub uci: String,
    pub classification: Class,
    /// Winning chances of the mover before and after the move (0..=100).
    pub win_before: f64,
    pub win_after: f64,
    pub best_san: Option<String>,
    pub best_uci: Option<String>,
    pub best_line: Option<String>,
    /// Coach comment in German …
    pub comment: String,
    /// … and in English (missing in reviews made before 0.2.0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_en: Option<String>,
    /// Why the move was bad (only for inaccuracies, mistakes, misses and blunders).
    #[serde(default)]
    pub theme: Option<coach::Theme>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Accuracy {
    pub white: f64,
    pub black: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameReview {
    pub version: u32,
    pub game_id: String,
    pub depth: u32,
    /// FEN of every position, starting with the initial one (len = moves + 1).
    pub fens: Vec<String>,
    /// Evaluation of every position from White's point of view.
    pub evals: Vec<Score>,
    /// White's winning chances for every position.
    pub win_white: Vec<f64>,
    pub moves: Vec<MoveReview>,
    pub accuracy: Accuracy,
}

impl MoveReview {
    /// The coach comment in the current UI language (German for old reviews).
    pub fn localized_comment(&self) -> String {
        match &self.comment_en {
            Some(en) if i18n::en() => en.clone(),
            _ => self.comment.clone(),
        }
    }
}

/// Replay SAN moves from the initial position.
pub fn replay(moves: &[String]) -> Result<(Vec<Chess>, Vec<Move>), String> {
    let mut pos = Chess::default();
    let mut positions = vec![pos.clone()];
    let mut played = Vec::with_capacity(moves.len());
    for (i, san) in moves.iter().enumerate() {
        let m = san
            .parse::<SanPlus>()
            .ok()
            .and_then(|s| s.san.to_move(&pos).ok())
            .ok_or_else(|| { let n = i / 2 + 1; crate::tr!("Ungültiger Zug {n} ({san})", "Invalid move {n} ({san})") })?;
        pos.play_unchecked(m);
        positions.push(pos.clone());
        played.push(m);
    }
    Ok((positions, played))
}

pub fn parse_fen(fen: &str) -> Result<Chess, String> {
    fen.parse::<Fen>()
        .map_err(|e| crate::tr!("Ungültige FEN: {e}", "Invalid FEN: {e}"))?
        .into_position(CastlingMode::Standard)
        .map_err(|e| crate::tr!("Ungültige Stellung: {e}", "Invalid position: {e}"))
}

pub fn fen(pos: &Chess) -> String {
    Fen::from_position(pos, EnPassantMode::Legal).to_string()
}

/// Evaluation for positions where the game is over (no engine needed).
pub fn terminal_eval(pos: &Chess) -> Option<Vec<PvLine>> {
    let score = if pos.is_checkmate() {
        Score::Mated
    } else if pos.is_stalemate() || pos.is_insufficient_material() {
        Score::Cp(0)
    } else {
        return None;
    };
    Some(vec![PvLine { score, depth: 0, pv: vec![] }])
}

fn top_score(lines: &[PvLine]) -> Score {
    lines.first().map(|l| l.score).unwrap_or(Score::Cp(0))
}

struct Classified {
    class: Class,
    loss: f64,
}

#[allow(clippy::too_many_arguments)]
fn classify(
    ply: usize,
    book_plies: usize,
    before: &Chess,
    after: &Chess,
    played_uci: &str,
    lines_before: &[PvLine],
    lines_after: &[PvLine],
    opponent_blundered: bool,
) -> Classified {
    let mover = before.turn();
    let win_before = top_score(lines_before).win_percent();
    let win_after = top_score(lines_after).negate().win_percent();
    let loss = (win_before - win_after).max(0.0);
    let best = lines_before.first();
    let second = lines_before.get(1);

    let class = if before.legal_moves().len() == 1 {
        Class::Forced
    } else if ply < book_plies && loss < 5.0 {
        Class::Book
    } else {
        let best_uci = best.and_then(|l| l.pv.first()).map(String::as_str);
        let second_uci = second.and_then(|l| l.pv.first()).map(String::as_str);
        let is_best = best_uci == Some(played_uci) || (second_uci == Some(played_uci) && loss < 0.5);

        let reply = lines_after.first();
        let sacrifice = coach::is_sacrifice(before, after, reply, mover);

        // "Only move": the second-best alternative is far worse.
        let only_move = match (best, second) {
            (Some(b), Some(s)) => b.score.win_percent() - s.score.win_percent() >= 20.0,
            _ => false,
        };
        // Taking a freely offered piece is not a "great find".
        let obvious_capture = {
            let m = coach::parse_uci(before, played_uci);
            m.is_some_and(|m| m.is_capture())
                && reply.is_some_and(|r| {
                    coach::balance_after_line(after, &r.pv, mover) - coach::balance(before, mover) >= 2
                })
        };
        let opportunity = opponent_blundered || best.is_some_and(|b| b.score.mate_for().is_some());

        if (is_best || loss < 1.0) && sacrifice && win_before < 95.0 && win_after >= 45.0 {
            Class::Brilliant
        } else if is_best && only_move && !obvious_capture && win_before < 97.0 {
            Class::Great
        } else if is_best {
            Class::Best
        } else if loss >= 8.0 && opportunity && win_after >= 30.0 {
            Class::Miss
        } else if loss < 2.0 {
            Class::Excellent
        } else if loss < 5.0 {
            Class::Good
        } else if loss < 10.0 {
            Class::Inaccuracy
        } else if loss < 20.0 {
            Class::Mistake
        } else {
            Class::Blunder
        }
    };
    Classified { class, loss }
}

/// Lichess-style per-move accuracy from the drop in winning chances.
fn move_accuracy(loss: f64) -> f64 {
    (103.166_810_071_164_9 * (-0.043_544_153_867_539_51 * loss).exp() - 3.166_924_740_191_411 + 1.0).clamp(0.0, 100.0)
}

fn std_dev(xs: &[f64]) -> f64 {
    let n = xs.len() as f64;
    let mean = xs.iter().sum::<f64>() / n;
    (xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n).sqrt()
}

/// Game accuracy per colour: mean of a volatility-weighted mean and a harmonic
/// mean of per-move accuracies (the approach Lichess uses).
fn game_accuracy(win_white: &[f64], losses: &[f64]) -> Accuracy {
    let n_moves = losses.len();
    if n_moves == 0 {
        return Accuracy { white: 100.0, black: 100.0 };
    }
    let window = (n_moves / 10).clamp(2, 8).min(win_white.len());
    let mut weights = Vec::with_capacity(n_moves);
    for _ in 0..window.saturating_sub(2) {
        weights.push(std_dev(&win_white[..window]).clamp(0.5, 12.0));
    }
    for w in win_white.windows(window) {
        weights.push(std_dev(w).clamp(0.5, 12.0));
    }
    weights.resize(n_moves, 0.5);

    let for_color = |parity: usize| {
        let items: Vec<(f64, f64)> = losses
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 2 == parity)
            .map(|(i, &l)| (move_accuracy(l), weights[i]))
            .collect();
        if items.is_empty() {
            return 100.0;
        }
        let wsum: f64 = items.iter().map(|(_, w)| w).sum();
        let weighted = items.iter().map(|(a, w)| a * w).sum::<f64>() / wsum;
        let harmonic = items.len() as f64 / items.iter().map(|(a, _)| 1.0 / a.max(1.0)).sum::<f64>();
        ((weighted + harmonic) / 2.0 * 10.0).round() / 10.0
    };
    Accuracy { white: for_color(0), black: for_color(1) }
}

/// Positions whose classification needs the engine's second-best line.
///
/// The second line only matters when the played move was the engine's choice
/// ("Great" = only good move) or practically as good (it might be the engine's
/// second choice). Analysing everything with one line first and only these
/// positions again with two saves a large part of the work, with identical results.
pub fn needs_second_line(positions: &[Chess], moves: &[Move], lines: &[Vec<PvLine>]) -> Vec<usize> {
    (0..moves.len())
        .filter(|&i| {
            let before = &positions[i];
            if lines[i].len() >= 2 || terminal_eval(before).is_some() || before.legal_moves().len() < 2 {
                return false;
            }
            let played = UciMove::from_move(moves[i], CastlingMode::Standard).to_string();
            let best = lines[i].first().and_then(|l| l.pv.first());
            let loss = top_score(&lines[i]).win_percent() - top_score(&lines[i + 1]).negate().win_percent();
            best == Some(&played) || loss < 0.5
        })
        .collect()
}

pub struct MoveInput<'a> {
    /// 1-based ply number of this move within the game.
    pub ply: usize,
    pub book_plies: usize,
    pub opening: Option<&'a str>,
    pub before: &'a Chess,
    pub after: &'a Chess,
    pub played: Move,
    pub lines_before: &'a [PvLine],
    pub lines_after: &'a [PvLine],
    pub opponent_blundered: bool,
}

/// Classify and explain a single move. Returns the review and the mover's loss in win%.
pub fn review_move(input: &MoveInput) -> (MoveReview, f64) {
    let MoveInput { ply, before, after, played, lines_before, lines_after, opponent_blundered, .. } = *input;
    let mover = before.turn();
    let played_uci = UciMove::from_move(played, CastlingMode::Standard).to_string();
    let played_san = coach::san(before, played);

    let c = classify(ply - 1, input.book_plies, before, after, &played_uci, lines_before, lines_after, opponent_blundered);
    let win_before = top_score(lines_before).win_percent();
    let win_after = top_score(lines_after).negate().win_percent();

    let best = lines_before.first();
    let best_move = best.and_then(|l| l.pv.first()).and_then(|u| coach::parse_uci(before, u));
    let ctx = MoveContext {
        before,
        after,
        played,
        played_san: &played_san,
        mover,
        best,
        reply: lines_after.first(),
        class: c.class,
        win_before,
        win_after,
        opponent_blundered,
        opening: input.opening,
    };
    // Both languages, so switching the UI language doesn't need a new analysis.
    let (comment, theme) = i18n::with(Lang::De, || coach::explain(&ctx));
    let (comment_en, _) = i18n::with(Lang::En, || coach::explain(&ctx));

    let review = MoveReview {
        ply,
        color: if mover == Color::White { "white".into() } else { "black".into() },
        san: played_san,
        uci: played_uci,
        classification: c.class,
        win_before,
        win_after,
        best_san: best_move.map(|bm| coach::san(before, bm)),
        best_uci: best.and_then(|l| l.pv.first().cloned()),
        best_line: best.map(|l| coach::san_line(before, &l.pv, 8)),
        comment,
        comment_en: Some(comment_en),
        theme,
    };
    (review, c.loss)
}

/// Build the full review from replayed positions and their engine lines
/// (`lines[i]` belongs to `positions[i]`, from the side to move's perspective).
pub fn build_review(
    game: &GameInfo,
    depth: u32,
    positions: &[Chess],
    moves: &[Move],
    lines: &[Vec<PvLine>],
) -> GameReview {
    let book_plies = game.opening.as_ref().map(|o| o.ply).unwrap_or(0);
    let opening_name = game.opening.as_ref().map(|o| o.name.as_str());

    let evals: Vec<Score> = positions
        .iter()
        .zip(lines)
        .map(|(p, l)| {
            let s = top_score(l);
            if p.turn() == Color::White { s } else { s.negate() }
        })
        .collect();
    let win_white: Vec<f64> = evals.iter().map(|s| s.win_percent()).collect();

    let mut reviews = Vec::with_capacity(moves.len());
    let mut losses = Vec::with_capacity(moves.len());
    let mut prev_loss = 0.0;
    for (i, &m) in moves.iter().enumerate() {
        let (review, loss) = review_move(&MoveInput {
            ply: i + 1,
            book_plies,
            opening: opening_name,
            before: &positions[i],
            after: &positions[i + 1],
            played: m,
            lines_before: &lines[i],
            lines_after: &lines[i + 1],
            opponent_blundered: prev_loss >= 10.0,
        });
        reviews.push(review);
        losses.push(loss);
        prev_loss = loss;
    }

    GameReview {
        version: REVIEW_VERSION,
        game_id: game.id.clone(),
        depth,
        fens: positions.iter().map(fen).collect(),
        evals,
        accuracy: game_accuracy(&win_white, &losses),
        win_white,
        moves: reviews,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lichess::{GameInfo, Player};

    fn game(moves: &str) -> GameInfo {
        GameInfo {
            id: "test0001".into(),
            source: Default::default(),
            url: None,
            white: Player { name: "W".into(), rating: None },
            black: Player { name: "B".into(), rating: None },
            winner: None,
            status: "mate".into(),
            speed: "blitz".into(),
            rated: false,
            time_control: None,
            created_at: 0,
            opening: None,
            moves: moves.split_whitespace().map(String::from).collect(),
            clocks: None,
        }
    }

    fn line(score: Score, pv: &str) -> Vec<PvLine> {
        vec![PvLine { score, depth: 10, pv: pv.split_whitespace().map(String::from).collect() }]
    }

    #[test]
    fn replays_and_detects_mate() {
        let (pos, moves) = replay(&game("e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#").moves).unwrap();
        assert_eq!(moves.len(), 7);
        assert!(pos.last().unwrap().is_checkmate());
        assert!(terminal_eval(pos.last().unwrap()).is_some());
    }

    #[test]
    fn flags_blunder_that_allows_mate() {
        // Scholar's mate: 3...Nf6?? allows Qxf7#.
        let g = game("e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#");
        let (pos, moves) = replay(&g.moves).unwrap();
        let lines = vec![
            line(Score::Cp(30), "e2e4"),
            line(Score::Cp(-30), "e7e5"),
            line(Score::Cp(30), "d1h5"),
            line(Score::Cp(-40), "b8c6"),
            line(Score::Cp(40), "f1c4"),
            line(Score::Cp(-40), "g7g6 h5f3 g8f6"),
            line(Score::Mate(1), "h5f7"),
            terminal_eval(&pos[7]).unwrap(),
        ];
        let r = build_review(&g, 10, &pos, &moves, &lines);
        let nf6 = &r.moves[5];
        assert_eq!(nf6.san, "Nf6");
        assert_eq!(nf6.classification, Class::Blunder);
        assert!(nf6.comment.contains("Matt in 1"), "{}", nf6.comment);
        assert_eq!(nf6.comment_en.as_deref(), Some("This allows mate in 1: 4. Qxf7#."));
        assert_eq!(nf6.theme, Some(coach::Theme::AllowedMate));
        assert_eq!(r.moves[0].theme, None);
        assert_eq!(r.moves[6].comment, "Schachmatt!");
        assert_eq!(r.moves[6].comment_en.as_deref(), Some("Checkmate!"));
        assert_eq!(r.moves[6].classification, Class::Best);
        assert!(r.accuracy.black < r.accuracy.white, "{:?}", r.accuracy);
    }

    #[test]
    fn explains_hanging_piece() {
        // 2. Ba6?? leaves the bishop en prise with nothing defending a6.
        let g = game("e4 e5 Ba6 Nxa6");
        let (pos, moves) = replay(&g.moves).unwrap();
        let lines = vec![
            line(Score::Cp(30), "e2e4"),
            line(Score::Cp(-30), "e7e5"),
            line(Score::Cp(30), "g1f3"),
            line(Score::Cp(300), "b8a6 d2d4"),
            line(Score::Cp(-300), "d2d4"),
        ];
        let r = build_review(&g, 10, &pos, &moves, &lines);
        let ba6 = &r.moves[2];
        assert_eq!(ba6.classification, Class::Blunder);
        assert!(ba6.comment.contains("ungedeckt") || ba6.comment.contains("Läufer"), "{}", ba6.comment);
        let en = ba6.comment_en.as_deref().unwrap();
        assert!(en.contains("your bishop on a6") && en.contains("Nxa6"), "{en}");
        assert_eq!(ba6.theme, Some(coach::Theme::HangingPiece));
    }

    #[test]
    fn second_line_only_where_classification_needs_it() {
        let g = game("e4 e5 Ba6 Nxa6");
        let (pos, moves) = replay(&g.moves).unwrap();
        let lines = vec![
            line(Score::Cp(30), "e2e4"),   // played = best -> needed
            line(Score::Cp(-30), "e7e5"),  // played = best -> needed
            line(Score::Cp(30), "g1f3"),   // Ba6?? loses a piece -> not needed
            line(Score::Cp(300), "b8a6"),  // played = best -> needed
            line(Score::Cp(-300), "d2d4"),
        ];
        assert_eq!(needs_second_line(&pos, &moves, &lines), vec![0, 1, 3]);
    }

    #[test]
    fn accuracy_is_perfect_without_losses() {
        let acc = game_accuracy(&[50.0, 50.0, 50.0, 50.0, 50.0], &[0.0, 0.0, 0.0, 0.0]);
        assert!(acc.white > 99.0 && acc.black > 99.0);
    }
}
