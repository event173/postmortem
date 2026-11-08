//! Rule-based "coach": turns engine output into short human explanations.
//!
//! No language model involved: each detector inspects the position and the
//! engine's principal variations and fills a German sentence template.

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
// German wording helpers

fn name(role: Role) -> &'static str {
    match role {
        Role::Pawn => "Bauer",
        Role::Knight => "Springer",
        Role::Bishop => "Läufer",
        Role::Rook => "Turm",
        Role::Queen => "Dame",
        Role::King => "König",
    }
}

/// "dein Springer" / "deine Dame"
fn your_nom(role: Role) -> String {
    match role {
        Role::Queen => "deine Dame".into(),
        r => format!("dein {}", name(r)),
    }
}

/// "deinen Springer" / "deine Dame" / "deinen Bauern"
fn your_acc(role: Role) -> String {
    match role {
        Role::Queen => "deine Dame".into(),
        Role::Pawn => "deinen Bauern".into(),
        r => format!("deinen {}", name(r)),
    }
}

/// "einen Springer" / "die Dame" / "einen Bauern"
fn a_acc(role: Role) -> String {
    match role {
        Role::Queen => "die Dame".into(),
        Role::Pawn => "einen Bauern".into(),
        r => format!("einen {}", name(r)),
    }
}

/// Pronoun for the captured piece: "ihn" / "sie".
fn pronoun(role: Role) -> &'static str {
    if role == Role::Queen { "sie" } else { "ihn" }
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
        return "die Qualität".into();
    }
    match ours.first() {
        Some(&r) if piece_value(r) <= points + 1 => a_acc(r),
        _ if points == 1 => "einen Bauern".into(),
        _ if points == 2 => "zwei Bauern".into(),
        _ => "Material".into(),
    }
}

// ---------------------------------------------------------------------------

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

pub fn explain(ctx: &MoveContext) -> String {
    if ctx.after.is_checkmate() {
        return "Schachmatt!".into();
    }
    match ctx.class {
        Class::Book => match ctx.opening {
            Some(o) => format!("Theoriezug: {o}."),
            None => "Theoriezug.".into(),
        },
        Class::Forced => "Der einzige legale Zug.".into(),
        Class::Brilliant => {
            let what = ctx
                .reply
                .and_then(|r| play_line(ctx.after, &r.pv, 1).first().and_then(|(m, _)| m.capture()))
                .map(a_acc)
                .unwrap_or_else(|| "Material".into());
            format!("Brillant! {} opfert {what} – und ist trotzdem der stärkste Zug.", ctx.played_san)
        }
        Class::Great => {
            let goal = if ctx.win_after >= 60.0 {
                "den Vorteil behält"
            } else if ctx.win_after >= 40.0 {
                "die Stellung hält"
            } else {
                "dich im Spiel hält"
            };
            format!("Stark gefunden! {} ist der einzige Zug, der {goal}.", ctx.played_san)
        }
        Class::Best => good_move_note(ctx).unwrap_or_else(|| "Der beste Zug.".into()),
        Class::Excellent => good_move_note(ctx).unwrap_or_else(|| "Ausgezeichnet – praktisch so gut wie der beste Zug.".into()),
        Class::Good => match ctx.best_san() {
            Some(b) => format!("Ein solider Zug, aber {b} war etwas genauer."),
            None => "Ein solider Zug.".into(),
        },
        Class::Inaccuracy | Class::Mistake | Class::Miss | Class::Blunder => bad_move_reason(ctx),
    }
}

/// Positive notes for good moves: delivering mate soon, winning material.
fn good_move_note(ctx: &MoveContext) -> Option<String> {
    let reply = ctx.reply?;
    if let Some(n) = reply.score.negate().mate_for() {
        return Some(format!("Stark! Damit erzwingst du Matt in {n}."));
    }
    if ctx.played.is_capture() {
        let gain = balance_after_line(ctx.after, &reply.pv, ctx.mover) - balance(ctx.before, ctx.mover);
        if gain >= 2 {
            let end = play_line(ctx.after, &reply.pv, LINE_HORIZON);
            let end = end.last().map(|(_, p)| p).unwrap_or(ctx.after);
            return Some(format!("Gut gesehen – du gewinnst {}.", describe_material(ctx.before, end, !ctx.mover, gain)));
        }
    }
    None
}

fn bad_move_reason(ctx: &MoveContext) -> String {
    allows_mate(ctx)
        .or_else(|| missed_mate(ctx))
        .or_else(|| allows_fork(ctx))
        .or_else(|| hanging_piece(ctx))
        .or_else(|| loses_material(ctx))
        .or_else(|| missed_material(ctx))
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
    Some(format!("Das erlaubt Matt in {n}: {line}."))
}

fn missed_mate(ctx: &MoveContext) -> Option<String> {
    let best = ctx.best?;
    let n = best.score.mate_for()?;
    let line = san_line(ctx.before, &best.pv, (2 * n as usize).saturating_sub(1).max(1));
    Some(format!("Du hattest Matt in {n}: {line}."))
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
    let mut names: Vec<String> = targets.iter().map(|&(t, r)| format!("{} auf {t}", your_acc(r))).collect();
    let last = names.pop()?;
    let list = format!("{} und {last}", names.join(", "));
    let reply_san = san(ctx.after, m);
    Some(format!("Das erlaubt eine Gabel: {reply_san} greift {list} gleichzeitig an."))
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
        if sq == ctx.played.to() {
            Some(format!(
                "Nach {} steht {} auf {sq} ungedeckt – {reply_san} schlägt {it} einfach.",
                ctx.played_san,
                your_nom(captured)
            ))
        } else {
            Some(format!("{} auf {sq} hängt – {reply_san} schlägt {it} einfach.", capitalize(&your_nom(captured))))
        }
    } else if piece_value(m.role()) < piece_value(captured) {
        Some(format!(
            "{reply_san} schlägt {} auf {sq}. Die Deckung reicht nicht, du verlierst {}.",
            your_acc(captured),
            describe_material(ctx.before, &end, ctx.mover, loss)
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
    Some(format!("Das verliert {}: {line}.", describe_material(ctx.before, &end, ctx.mover, loss)))
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
    let prefix = if ctx.opponent_blundered { "Dein Gegner hat gerade gepatzt. " } else { "" };
    Some(format!(
        "{prefix}Mit {} hättest du {what} gewonnen: {}.",
        ctx.best_san()?,
        san_line(ctx.before, &best.pv, 4)
    ))
}

fn positional(ctx: &MoveContext) -> String {
    let base = if ctx.class == Class::Miss || (ctx.opponent_blundered && ctx.win_before >= 60.0) {
        "Dein Gegner hat gerade einen Fehler gemacht, aber dieser Zug nutzt ihn nicht aus."
    } else if ctx.win_before >= 70.0 && ctx.win_after < 55.0 {
        "Damit gibst du deinen Vorteil aus der Hand."
    } else if ctx.win_before >= 40.0 && ctx.win_after < 30.0 {
        "Danach steht deine Stellung deutlich schlechter."
    } else if ctx.win_after < 15.0 {
        "Das macht eine schwierige Stellung noch schwieriger."
    } else {
        match ctx.class {
            Class::Inaccuracy => "Etwas ungenau – es gab einen besseren Plan.",
            _ => "Das verschlechtert deine Stellung spürbar.",
        }
    };
    match (ctx.best_san(), ctx.best) {
        (Some(b), Some(line)) => format!("{base} Besser war {b} ({}).", san_line(ctx.before, &line.pv, 4)),
        _ => base.to_string(),
    }
}
