//! Rule-based "coach": turns engine output into short human explanations.
//!
//! No language model involved: each detector inspects the position and the
//! engine's principal variations and fills a sentence template (German or
//! English, see `crate::i18n`).

use serde::{Deserialize, Serialize};
use shakmaty::{uci::UciMove, san::SanPlus, Chess, Color, Move, Position, Role, Square};

use crate::analysis::Class;
use crate::engine::{PvLine, Score};

/// How far (in plies) we follow engine lines when counting material.
const LINE_HORIZON: usize = 6;

pub fn piece_value(role: Role) -> i32 {
    match role {
        Role::Pawn => 1,
        Role::Knight | Role::Bishop => 3,
        Role::Rook => 5,
        Role::Queen => 9,
        Role::King => 0,
    }
}

pub fn material(pos: &Chess, color: Color) -> i32 {
    let m = pos.board().material_side(color);
    m.pawn as i32 + 3 * (m.knight as i32 + m.bishop as i32) + 5 * m.rook as i32 + 9 * m.queen as i32
}

/// Material balance from `color`'s point of view.
pub fn balance(pos: &Chess, color: Color) -> i32 {
    material(pos, color) - material(pos, !color)
}

pub fn parse_uci(pos: &Chess, uci: &str) -> Option<Move> {
    uci.parse::<UciMove>().ok()?.to_move(pos).ok()
}

/// Play up to `max` moves of a UCI line, returning each move and the position after it.
pub fn play_line(pos: &Chess, line: &[String], max: usize) -> Vec<(Move, Chess)> {
    let mut out = Vec::new();
    let mut cur = pos.clone();
    for uci in line.iter().take(max) {
        let Some(m) = parse_uci(&cur, uci) else { break };
        cur.play_unchecked(m);
        out.push((m, cur.clone()));
    }
    out
}

pub fn san(pos: &Chess, m: Move) -> String {
    SanPlus::from_move(pos.clone(), m).to_string()
}

/// Render a UCI line as numbered SAN, e.g. "12. Nf3 Nc6 13. Bb5" or "12... Nc6 13. Bb5".
pub fn san_line(pos: &Chess, line: &[String], max: usize) -> String {
    let mut out = Vec::new();
    let mut cur = pos.clone();
    for (i, uci) in line.iter().take(max).enumerate() {
        let Some(m) = parse_uci(&cur, uci) else { break };
        let n = cur.fullmoves();
        match cur.turn() {
            Color::White => out.push(format!("{n}. {}", san(&cur, m))),
            Color::Black if i == 0 => out.push(format!("{n}... {}", san(&cur, m))),
            Color::Black => out.push(san(&cur, m)),
        }
        cur.play_unchecked(m);
    }
    out.join(" ")
}

/// Material balance (for `color`) after following `line` from `pos`, measured
/// after an even number of plies so the side that started gets the last word
/// back (avoids counting a capture whose recapture is the very next move).
pub fn balance_after_line(pos: &Chess, line: &[String], color: Color) -> i32 {
    let played = play_line(pos, line, LINE_HORIZON);
    let k = played.len() - played.len() % 2;
    match k {
        0 => balance(pos, color),
        k => balance(&played[k - 1].1, color),
    }
}

/// Did the mover give up material that the opponent can take right away
/// (measured after the opponent's reply and the mover's follow-up)?
pub fn is_sacrifice(before: &Chess, after: &Chess, reply: Option<&PvLine>, mover: Color) -> bool {
    let Some(reply) = reply else { return false };
    let played = play_line(after, &reply.pv, 2);
    let Some((first, _)) = played.first() else { return false };
    if !first.is_capture() {
        return false;
    }
    let end = &played.last().unwrap().1;
    balance(before, mover) - balance(end, mover) >= 2
}

// ---------------------------------------------------------------------------
// Wording helpers (German grammar needs the case; English doesn't)

use crate::i18n::en;

fn name(role: Role) -> &'static str {
    match (role, en()) {
        (Role::Pawn, false) => "Bauer",
        (Role::Knight, false) => "Springer",
        (Role::Bishop, false) => "Läufer",
        (Role::Rook, false) => "Turm",
        (Role::Queen, false) => "Dame",
        (Role::King, false) => "König",
        (Role::Pawn, true) => "pawn",
        (Role::Knight, true) => "knight",
        (Role::Bishop, true) => "bishop",
        (Role::Rook, true) => "rook",
        (Role::Queen, true) => "queen",
        (Role::King, true) => "king",
    }
}

/// "dein Springer" / "deine Dame" – "your knight"
fn your_nom(role: Role) -> String {
    match role {
        _ if en() => format!("your {}", name(role)),
        Role::Queen => "deine Dame".into(),
        r => format!("dein {}", name(r)),
    }
}

/// "deinen Springer" / "deine Dame" / "deinen Bauern" – "your knight"
fn your_acc(role: Role) -> String {
    match role {
        _ if en() => format!("your {}", name(role)),
        Role::Queen => "deine Dame".into(),
        Role::Pawn => "deinen Bauern".into(),
        r => format!("deinen {}", name(r)),
    }
}

/// "einen Springer" / "die Dame" / "einen Bauern" – "a knight" / "the queen"
fn a_acc(role: Role) -> String {
    match role {
        Role::Queen if en() => "the queen".into(),
        _ if en() => format!("a {}", name(role)),
        Role::Queen => "die Dame".into(),
        Role::Pawn => "einen Bauern".into(),
        r => format!("einen {}", name(r)),
    }
}

/// Pronoun for the captured piece: "ihn" / "sie" – "it".
fn pronoun(role: Role) -> &'static str {
    if en() {
        "it"
    } else if role == Role::Queen {
        "sie"
    } else {
        "ihn"
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Describe a net material swing of `points` in words, using the pieces that
/// actually disappeared from `from` to `to` for `color`.
fn describe_material(from: &Chess, to: &Chess, color: Color, points: i32) -> String {
    let lost = |c: Color| {
        let a = from.board().material_side(c);
        let b = to.board().material_side(c);
        [Role::Queen, Role::Rook, Role::Bishop, Role::Knight, Role::Pawn]
            .into_iter()
            .filter(move |&r| a[r] > b[r])
            .collect::<Vec<_>>()
    };
    let ours = lost(color);
    let theirs = lost(!color);
    let minor = |v: &[Role]| v.iter().any(|r| matches!(r, Role::Knight | Role::Bishop));
    if ours.contains(&Role::Rook) && minor(&theirs) && !theirs.contains(&Role::Rook) && points <= 3 {
        return tr!("die Qualität", "the exchange");
    }
    match ours.first() {
        Some(&r) if piece_value(r) <= points + 1 => a_acc(r),
        _ if points == 1 => a_acc(Role::Pawn),
        _ if points == 2 => tr!("zwei Bauern", "two pawns"),
        _ => tr!("Material", "material"),
    }
}

// ---------------------------------------------------------------------------

/// Why a bad move was bad – used for the weakness statistics and, later,
/// to pick matching puzzles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    /// The move lets the opponent mate.
    AllowedMate,
    /// A forced mate was available and not played.
    MissedMate,
    /// The move allows a fork.
    AllowedFork,
    /// A piece is left undefended (or insufficiently defended) and gets taken.
    HangingPiece,
    /// Material is lost to a combination.
    LostMaterial,
    /// A material-winning tactic was available and not played.
    MissedTactic,
    /// The opponent just erred and the chance was not used (no concrete tactic found).
    MissedChance,
    /// No concrete tactic: the position simply got worse.
    Positional,
}

pub struct MoveContext<'a> {
    pub before: &'a Chess,
    pub after: &'a Chess,
    pub played: Move,
    pub played_san: &'a str,
    pub mover: Color,
    /// Engine's best line in `before` (mover's perspective).
    pub best: Option<&'a PvLine>,
    /// Engine's best line in `after` (opponent's perspective).
    pub reply: Option<&'a PvLine>,
    pub class: Class,
    pub win_before: f64,
    pub win_after: f64,
    pub opponent_blundered: bool,
    pub opening: Option<&'a str>,
}

impl MoveContext<'_> {
    fn best_san(&self) -> Option<String> {
        let m = parse_uci(self.before, self.best?.pv.first()?)?;
        Some(san(self.before, m))
    }
}

/// Coach comment for a move, plus the theme if it was a bad move.
pub fn explain(ctx: &MoveContext) -> (String, Option<Theme>) {
    if ctx.after.is_checkmate() {
        return (tr!("Schachmatt!", "Checkmate!"), None);
    }
    if matches!(ctx.class, Class::Inaccuracy | Class::Mistake | Class::Miss | Class::Blunder) {
        let (text, theme) = bad_move_reason(ctx);
        return (text, Some(theme));
    }
    (good_move_comment(ctx), None)
}

fn good_move_comment(ctx: &MoveContext) -> String {
    match ctx.class {
        Class::Book => match ctx.opening {
            Some(o) => tr!("Theoriezug: {o}.", "Book move: {o}."),
            None => tr!("Theoriezug.", "Book move."),
        },
        Class::Forced => tr!("Der einzige legale Zug.", "The only legal move."),
        Class::Brilliant => {
            let what = ctx
                .reply
                .and_then(|r| play_line(ctx.after, &r.pv, 1).first().and_then(|(m, _)| m.capture()))
                .map(a_acc)
                .unwrap_or_else(|| tr!("Material", "material"));
            let mv = ctx.played_san;
            tr!("Brillant! {mv} opfert {what} – und ist trotzdem der stärkste Zug.", "Brilliant! {mv} sacrifices {what} – and is still the strongest move.")
        }
        Class::Great => {
            let mv = ctx.played_san;
            if ctx.win_after >= 60.0 {
                tr!("Stark gefunden! {mv} ist der einzige Zug, der den Vorteil behält.", "Great find! {mv} is the only move that keeps the advantage.")
            } else if ctx.win_after >= 40.0 {
                tr!("Stark gefunden! {mv} ist der einzige Zug, der die Stellung hält.", "Great find! {mv} is the only move that holds the position.")
            } else {
                tr!("Stark gefunden! {mv} ist der einzige Zug, der dich im Spiel hält.", "Great find! {mv} is the only move that keeps you in the game.")
            }
        }
        Class::Best => good_move_note(ctx).unwrap_or_else(|| tr!("Der beste Zug.", "The best move.")),
        Class::Excellent => good_move_note(ctx)
            .unwrap_or_else(|| tr!("Ausgezeichnet – praktisch so gut wie der beste Zug.", "Excellent – practically as good as the best move.")),
        Class::Good => match ctx.best_san() {
            Some(b) => tr!("Ein solider Zug, aber {b} war etwas genauer.", "A solid move, but {b} was a little more precise."),
            None => tr!("Ein solider Zug.", "A solid move."),
        },
        Class::Inaccuracy | Class::Mistake | Class::Miss | Class::Blunder => unreachable!(),
    }
}

/// Positive notes for good moves: delivering mate soon, winning material.
fn good_move_note(ctx: &MoveContext) -> Option<String> {
    let reply = ctx.reply?;
    if let Some(n) = reply.score.negate().mate_for() {
        return Some(tr!("Stark! Damit erzwingst du Matt in {n}.", "Strong! This forces mate in {n}."));
    }
    if ctx.played.is_capture() {
        let gain = balance_after_line(ctx.after, &reply.pv, ctx.mover) - balance(ctx.before, ctx.mover);
        if gain >= 2 {
            let end = play_line(ctx.after, &reply.pv, LINE_HORIZON);
            let end = end.last().map(|(_, p)| p).unwrap_or(ctx.after);
            let what = describe_material(ctx.before, end, !ctx.mover, gain);
            return Some(tr!("Gut gesehen – du gewinnst {what}.", "Well spotted – you win {what}."));
        }
    }
    None
}

fn bad_move_reason(ctx: &MoveContext) -> (String, Theme) {
    let tag = |theme| move |text| (text, theme);
    allows_mate(ctx)
        .map(tag(Theme::AllowedMate))
        .or_else(|| missed_mate(ctx).map(tag(Theme::MissedMate)))
        .or_else(|| allows_fork(ctx).map(tag(Theme::AllowedFork)))
        .or_else(|| hanging_piece(ctx).map(tag(Theme::HangingPiece)))
        .or_else(|| loses_material(ctx).map(tag(Theme::LostMaterial)))
        .or_else(|| missed_material(ctx).map(tag(Theme::MissedTactic)))
        .unwrap_or_else(|| positional(ctx))
}

fn allows_mate(ctx: &MoveContext) -> Option<String> {
    let reply = ctx.reply?;
    let n = reply.score.mate_for()?;
    // Already getting mated before this move? Then it is not this move's fault.
    if ctx.best.is_some_and(|b| matches!(b.score, Score::Mate(m) if m < 0)) {
        return None;
    }
    let line = san_line(ctx.after, &reply.pv, (2 * n as usize).saturating_sub(1).max(1));
    Some(tr!("Das erlaubt Matt in {n}: {line}.", "This allows mate in {n}: {line}."))
}

fn missed_mate(ctx: &MoveContext) -> Option<String> {
    let best = ctx.best?;
    let n = best.score.mate_for()?;
    let line = san_line(ctx.before, &best.pv, (2 * n as usize).saturating_sub(1).max(1));
    Some(tr!("Du hattest Matt in {n}: {line}.", "You had mate in {n}: {line}."))
}

/// Net material the mover loses along the opponent's best reply line.
fn material_loss(ctx: &MoveContext) -> Option<(i32, Chess)> {
    let reply = ctx.reply?;
    let loss = balance(ctx.before, ctx.mover) - balance_after_line(ctx.after, &reply.pv, ctx.mover);
    let line = play_line(ctx.after, &reply.pv, LINE_HORIZON);
    let end = line.last().map(|(_, p)| p.clone()).unwrap_or_else(|| ctx.after.clone());
    Some((loss, end))
}

fn allows_fork(ctx: &MoveContext) -> Option<String> {
    let reply = ctx.reply?;
    let (loss, _) = material_loss(ctx)?;
    if loss < 2 {
        return None;
    }
    let (m, pos) = play_line(ctx.after, &reply.pv, 1).into_iter().next()?;
    let sq = m.to();
    let board = pos.board();
    let attacker_value = piece_value(m.role());
    let targets: Vec<(Square, Role)> = (board.attacks_from(sq) & board.by_color(ctx.mover))
        .into_iter()
        .filter_map(|t| board.role_at(t).map(|r| (t, r)))
        .filter(|&(_, r)| r == Role::King || (piece_value(r) >= 3 && piece_value(r) > attacker_value) || piece_value(r) >= 5)
        .collect();
    if targets.len() < 2 {
        return None;
    }
    let mut names: Vec<String> = targets
        .iter()
        .map(|&(t, r)| {
            let piece = your_acc(r);
            tr!("{piece} auf {t}", "{piece} on {t}")
        })
        .collect();
    let last = names.pop()?;
    let rest = names.join(", ");
    let list = tr!("{rest} und {last}", "{rest} and {last}");
    let reply_san = san(ctx.after, m);
    Some(tr!("Das erlaubt eine Gabel: {reply_san} greift {list} gleichzeitig an.", "This allows a fork: {reply_san} attacks {list} at once."))
}

fn hanging_piece(ctx: &MoveContext) -> Option<String> {
    let reply = ctx.reply?;
    let (loss, end) = material_loss(ctx)?;
    let m = parse_uci(ctx.after, reply.pv.first()?)?;
    let captured = m.capture()?;
    if loss < 1 || (loss < 2 && captured != Role::Pawn) {
        return None;
    }
    let sq = m.to();
    let board = ctx.after.board();
    let defenders = board.attacks_to(sq, ctx.mover, board.occupied());
    let reply_san = san(ctx.after, m);
    if defenders.is_empty() {
        let it = pronoun(captured);
        let mv = ctx.played_san;
        let piece = your_nom(captured);
        if sq == ctx.played.to() {
            Some(tr!(
                "Nach {mv} steht {piece} auf {sq} ungedeckt – {reply_san} schlägt {it} einfach.",
                "After {mv}, {piece} on {sq} is undefended – {reply_san} simply takes {it}."
            ))
        } else {
            let piece = capitalize(&piece);
            Some(tr!("{piece} auf {sq} hängt – {reply_san} schlägt {it} einfach.", "{piece} on {sq} is hanging – {reply_san} simply takes {it}."))
        }
    } else if piece_value(m.role()) < piece_value(captured) {
        let piece = your_acc(captured);
        let what = describe_material(ctx.before, &end, ctx.mover, loss);
        Some(tr!(
            "{reply_san} schlägt {piece} auf {sq}. Die Deckung reicht nicht, du verlierst {what}.",
            "{reply_san} takes {piece} on {sq}. It is not defended enough – you lose {what}."
        ))
    } else {
        None
    }
}

fn loses_material(ctx: &MoveContext) -> Option<String> {
    let reply = ctx.reply?;
    let (loss, end) = material_loss(ctx)?;
    if loss < 1 {
        return None;
    }
    let line = san_line(ctx.after, &reply.pv, 4);
    let what = describe_material(ctx.before, &end, ctx.mover, loss);
    Some(tr!("Das verliert {what}: {line}.", "This loses {what}: {line}."))
}

fn missed_material(ctx: &MoveContext) -> Option<String> {
    let best = ctx.best?;
    let gain = balance_after_line(ctx.before, &best.pv, ctx.mover) - balance(ctx.before, ctx.mover);
    if gain < 2 {
        return None;
    }
    let line = play_line(ctx.before, &best.pv, LINE_HORIZON);
    let end = line.last().map(|(_, p)| p)?;
    let what = describe_material(ctx.before, end, !ctx.mover, gain);
    let prefix = if ctx.opponent_blundered { tr!("Dein Gegner hat gerade gepatzt. ", "Your opponent just blundered. ") } else { String::new() };
    let best_san = ctx.best_san()?;
    let line = san_line(ctx.before, &best.pv, 4);
    Some(tr!("{prefix}Mit {best_san} hättest du {what} gewonnen: {line}.", "{prefix}With {best_san} you would have won {what}: {line}."))
}

fn positional(ctx: &MoveContext) -> (String, Theme) {
    let missed_chance = ctx.class == Class::Miss || (ctx.opponent_blundered && ctx.win_before >= 60.0);
    let theme = if missed_chance { Theme::MissedChance } else { Theme::Positional };
    let base = if missed_chance {
        tr!(
            "Dein Gegner hat gerade einen Fehler gemacht, aber dieser Zug nutzt ihn nicht aus.",
            "Your opponent just made a mistake, but this move does not take advantage of it."
        )
    } else if ctx.win_before >= 70.0 && ctx.win_after < 55.0 {
        tr!("Damit gibst du deinen Vorteil aus der Hand.", "This throws away your advantage.")
    } else if ctx.win_before >= 40.0 && ctx.win_after < 30.0 {
        tr!("Danach steht deine Stellung deutlich schlechter.", "After this your position is clearly worse.")
    } else if ctx.win_after < 15.0 {
        tr!("Das macht eine schwierige Stellung noch schwieriger.", "This makes a difficult position even harder.")
    } else {
        match ctx.class {
            Class::Inaccuracy => tr!("Etwas ungenau – es gab einen besseren Plan.", "Slightly inaccurate – there was a better plan."),
            _ => tr!("Das verschlechtert deine Stellung spürbar.", "This noticeably worsens your position."),
        }
    };
    let text = match (ctx.best_san(), ctx.best) {
        (Some(b), Some(line)) => {
            let line = san_line(ctx.before, &line.pv, 4);
            tr!("{base} Besser war {b} ({line}).", "{base} Better was {b} ({line}).")
        }
        _ => base,
    };
    (text, theme)
}
