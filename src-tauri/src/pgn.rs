//! PGN reading: headers, main-line moves and clock comments (`{[%clk 0:04:59.8]}`),
//! and turning pasted PGN into games that can be reviewed like any other.

use shakmaty::{san::SanPlus, Chess, Position};

use crate::lichess::{GameInfo, Player, Source};
use crate::openings;

const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/// Name used for "your" side in games stored locally (bot and imported games).
pub const LOCAL_PLAYER: &str = "Du";

#[derive(Debug, Default)]
pub struct Parsed {
    pub headers: Vec<(String, String)>,
    /// Main-line moves as written (SAN, without move numbers / annotations).
    pub moves: Vec<String>,
    /// Remaining clock after each move in centiseconds, where a `[%clk]` was given.
    pub clocks: Vec<Option<u32>>,
}

impl Parsed {
    pub fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty() && !v.chars().all(|c| c == '?' || c == '-'))
    }

    /// Clocks for every ply, or None if any is missing.
    pub fn full_clocks(&self) -> Option<Vec<u32>> {
        if self.moves.is_empty() || self.clocks.len() != self.moves.len() {
            return None;
        }
        self.clocks.iter().copied().collect()
    }
}

/// `[%clk 1:02:03.4]` inside a comment -> centiseconds.
fn clock_in(comment: &str) -> Option<u32> {
    let rest = &comment[comment.find("[%clk")? + 5..];
    let value = rest.trim_start().split([']', ' ']).next()?;
    let mut secs = 0f64;
    for part in value.split(':') {
        secs = secs * 60.0 + part.parse::<f64>().ok()?;
    }
    Some((secs * 100.0).round() as u32)
}

fn is_move_token(tok: &str) -> bool {
    !tok.is_empty() && !tok.starts_with('$') && !matches!(tok, "1-0" | "0-1" | "1/2-1/2" | "½-½" | "*")
}

/// "12." / "12..." / "12.e4" -> "e4"; trailing !? annotations removed.
fn clean_token(tok: &str) -> &str {
    let tok = match tok.find('.') {
        Some(i) if tok[..i].chars().all(|c| c.is_ascii_digit()) => tok[i..].trim_start_matches('.'),
        _ => tok,
    };
    tok.trim_end_matches(['!', '?'])
}

/// Parse a single game.
pub fn parse(pgn: &str) -> Parsed {
    let mut out = Parsed::default();
    let mut body = String::new();
    for line in pgn.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') && body.trim().is_empty() {
            if let Some((k, v)) = header_line(t) {
                out.headers.push((k, v));
            }
        } else if !t.starts_with('%') {
            body.push_str(line);
            body.push('\n');
        }
    }

    let (mut brace, mut paren, mut line_comment) = (false, 0u32, false);
    let mut comment = String::new();
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut Parsed| {
        let t = clean_token(token.trim());
        if is_move_token(t) {
            out.moves.push(t.to_string());
            out.clocks.push(None);
        }
        token.clear();
    };
    for c in body.chars() {
        if line_comment {
            line_comment = c != '\n';
            continue;
        }
        if brace {
            if c == '}' {
                brace = false;
                if paren == 0 {
                    if let (Some(clk), Some(last)) = (clock_in(&comment), out.clocks.last_mut()) {
                        *last = Some(clk);
                    }
                }
                comment.clear();
            } else {
                comment.push(c);
            }
            continue;
        }
        match c {
            '{' => {
                flush(&mut token, &mut out);
                brace = true;
            }
            ';' => {
                flush(&mut token, &mut out);
                line_comment = true;
            }
            '(' => {
                if paren == 0 {
                    flush(&mut token, &mut out);
                }
                paren += 1;
            }
            ')' => paren = paren.saturating_sub(1),
            _ if paren > 0 => {}
            c if c.is_whitespace() => flush(&mut token, &mut out),
            c => token.push(c),
        }
    }
    flush(&mut token, &mut out);
    out
}

fn header_line(t: &str) -> Option<(String, String)> {
    let inner = t.strip_prefix('[')?.strip_suffix(']')?.trim();
    let (key, rest) = inner.split_once(char::is_whitespace)?;
    let value = rest.trim().strip_prefix('"')?.strip_suffix('"')?;
    Some((key.to_string(), value.replace("\\\"", "\"")))
}

/// Split a text with several games (e.g. a whole export) into single games.
pub fn split_games(text: &str) -> Vec<String> {
    let mut games = Vec::new();
    let mut cur = String::new();
    let mut has_moves = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') && has_moves {
            games.push(std::mem::take(&mut cur));
            has_moves = false;
        }
        if !t.is_empty() && !t.starts_with('[') {
            has_moves = true;
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        games.push(cur);
    }
    games
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2024.03.15" (+ optional "14:05:00") -> ms since epoch.
fn timestamp(date: &str, time: Option<&str>) -> Option<i64> {
    let mut p = date.split(['.', '-', '/']);
    let y: i64 = p.next()?.parse().ok()?;
    let m: u32 = p.next().and_then(|m| m.parse().ok()).filter(|m| (1..=12).contains(m)).unwrap_or(1);
    let d: u32 = p.next().and_then(|d| d.parse().ok()).filter(|d| (1..=31).contains(d)).unwrap_or(1);
    let secs = time
        .and_then(|t| {
            let mut p = t.split(':').map(|x| x.parse::<i64>().ok());
            Some(p.next()?? * 3600 + p.next().flatten().unwrap_or(0) * 60 + p.next().flatten().unwrap_or(0))
        })
        .unwrap_or(12 * 3600);
    Some((days_from_civil(y, m, d) * 86_400 + secs) * 1000)
}

/// "600+5" -> "10+5"; "-" / "?" / unknown -> None. Also the base seconds and increment.
fn time_control(tc: &str) -> Option<(String, u32, u32)> {
    let tc = tc.split(':').next()?; // "40/7200:3600" -> first period
    let tc = tc.rsplit('/').next()?;
    let mut parts = tc.split('+');
    let base: u32 = parts.next()?.trim().parse().ok()?;
    let inc: u32 = parts.next().and_then(|i| i.trim().parse().ok()).unwrap_or(0);
    let label = if base.is_multiple_of(60) { (base / 60).to_string() } else { format!("{:.1}", base as f64 / 60.0) };
    Some((format!("{label}+{inc}"), base, inc))
}

/// Lichess' speed categories from the estimated game duration.
fn speed(base: u32, inc: u32) -> &'static str {
    match base + 40 * inc {
        0..30 => "ultraBullet",
        30..180 => "bullet",
        180..480 => "blitz",
        480..1500 => "rapid",
        _ => "classical",
    }
}

/// A game from Lichess / chess.com (or with a time control) without a result
/// and not over on the board is most likely still being played. Studies, books
/// and analysis PGNs often have "*" too – they are not affected.
fn still_running(p: &Parsed, result: &str, end: &Chess) -> bool {
    if result != "*" || end.is_game_over() {
        return false;
    }
    let site = p.header("Site").unwrap_or("").to_ascii_lowercase();
    let online = (site.contains("lichess.org") && !site.contains("/study/") && !site.contains("/analysis"))
        || site.contains("chess.com")
        || p.header("TimeControl").is_some_and(|tc| tc != "-" && tc != "?");
    online || p.header("CurrentPosition").is_some()
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// Turn one parsed PGN into a stored game. `you` = "white" / "black" renames that
/// side to "Du", so the game counts as yours (game list, statistics, puzzles).
pub fn to_game(p: &Parsed, you: Option<&str>, now_ms: i64) -> Result<GameInfo, String> {
    if let Some(v) = p.header("Variant") {
        if !matches!(v.to_ascii_lowercase().as_str(), "standard" | "chess" | "normal") {
            return Err(crate::tr!("Variante „{v}“ wird nicht unterstützt.", "Variant “{v}” is not supported."));
        }
    }
    if let Some(fen) = p.header("FEN") {
        if fen.trim() != START_FEN {
            return Err(crate::tr!("Nur Partien ab der Grundstellung werden unterstützt.", "Only games from the initial position are supported."));
        }
    }
    if p.moves.is_empty() {
        return Err(crate::tr!("Keine Züge gefunden.", "No moves found."));
    }
    // Validate and normalise ("0-0" -> "O-O", missing "+" …).
    let mut pos = Chess::default();
    let mut moves = Vec::with_capacity(p.moves.len());
    for (i, san) in p.moves.iter().enumerate() {
        let normalised = san.replace('0', "O");
        let candidate = if san.starts_with('0') { normalised.as_str() } else { san.as_str() };
        let m = candidate
            .parse::<SanPlus>()
            .ok()
            .and_then(|s| s.san.to_move(&pos).ok())
            .ok_or_else(|| { let n = format!("{}{}", i / 2 + 1, if i % 2 == 0 { "." } else { "..." }); crate::tr!("Ungültiger Zug {n} {san}", "Invalid move {n} {san}") })?;
        moves.push(SanPlus::from_move_and_play_unchecked(&mut pos, m).to_string());
    }

    let player = |name: &str, elo: &str, fallback: &str| Player {
        name: p.header(name).unwrap_or(fallback).to_string(),
        rating: p.header(elo).and_then(|r| r.parse().ok()),
    };
    let mut white = player("White", "WhiteElo", "Weiß");
    let mut black = player("Black", "BlackElo", "Schwarz");

    let result = p.header("Result").unwrap_or("*");
    if still_running(p, result, &pos) {
        return Err(crate::i18n::still_running());
    }
    let winner = match result {
        "1-0" => Some("white".to_string()),
        "0-1" => Some("black".to_string()),
        _ => None,
    };
    let termination = p.header("Termination").unwrap_or("").to_ascii_lowercase();
    let status = if pos.is_checkmate() {
        "mate"
    } else if termination.contains("time") {
        "outoftime"
    } else if result == "1/2-1/2" {
        "draw"
    } else if winner.is_some() {
        "resign"
    } else {
        "unknown"
    };

    let date = p.header("UTCDate").or(p.header("Date"));
    let created_at = date.and_then(|d| timestamp(d, p.header("UTCTime").or(p.header("Time")))).unwrap_or(now_ms);
    let tc = p.header("TimeControl").and_then(time_control);
    let id = format!(
        "pgn{:016x}",
        fnv(&format!("{}|{}|{}|{}", white.name, black.name, date.unwrap_or(""), moves.join(" ")))
    );
    match you {
        Some("white") => white.name = LOCAL_PLAYER.into(),
        Some("black") => black.name = LOCAL_PLAYER.into(),
        _ => {}
    }
    Ok(GameInfo {
        id,
        source: Source::Local,
        url: p.header("Site").filter(|s| s.starts_with("http")).map(str::to_string),
        white,
        black,
        winner,
        status: status.into(),
        speed: tc.as_ref().map_or("import", |(_, b, i)| speed(*b, *i)).into(),
        rated: false,
        time_control: tc.map(|(label, _, _)| label),
        created_at,
        opening: openings::identify(&moves),
        clocks: p.full_clocks(),
        moves,
    })
}

/// A game as PGN text (for copying out of the app).
pub fn export(g: &GameInfo) -> String {
    let date = {
        let days = g.created_at.div_euclid(86_400_000);
        let (y, m, d) = civil_from_days(days);
        format!("{y:04}.{m:02}.{d:02}")
    };
    let result = match g.winner.as_deref() {
        Some("white") => "1-0",
        Some("black") => "0-1",
        _ if g.status == "draw" || g.status == "stalemate" || g.status == "agreed" || g.status == "repetition" => "1/2-1/2",
        _ => "*",
    };
    let esc = |s: &str| s.replace('"', "\\\"");
    let mut out = String::new();
    let site = g.url.clone().unwrap_or_else(|| "postmortem".into());
    out += &format!("[Event \"{}\"]\n[Site \"{}\"]\n[Date \"{date}\"]\n", if g.rated { "Rated game" } else { "Casual game" }, esc(&site));
    out += &format!("[White \"{}\"]\n[Black \"{}\"]\n[Result \"{result}\"]\n", esc(&g.white.name), esc(&g.black.name));
    if let Some(r) = g.white.rating {
        out += &format!("[WhiteElo \"{r}\"]\n");
    }
    if let Some(r) = g.black.rating {
        out += &format!("[BlackElo \"{r}\"]\n");
    }
    if let Some(o) = &g.opening {
        out += &format!("[ECO \"{}\"]\n[Opening \"{}\"]\n", esc(&o.eco), esc(&o.name));
    }
    out.push('\n');
    let mut line = String::new();
    for (i, san) in g.moves.iter().enumerate() {
        let mut tok = if i % 2 == 0 { format!("{}. {san}", i / 2 + 1) } else { san.clone() };
        if let Some(c) = g.clocks.as_ref().and_then(|c| c.get(i)) {
            let s = c / 100;
            tok += &format!(" {{[%clk {}:{:02}:{:02}]}}", s / 3600, s / 60 % 60, s % 60);
        }
        if line.len() + tok.len() > 79 {
            out += line.trim_end();
            out.push('\n');
            line.clear();
        }
        line += &tok;
        line.push(' ');
    }
    out += &line;
    out += result;
    out.push('\n');
    out
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[Event "Vereinsmeisterschaft"]
[Site "Berlin"]
[Date "2024.03.15"]
[White "Meier, Anna"]
[Black "Schulz, Ben"]
[Result "1-0"]
[WhiteElo "1650"]
[TimeControl "5400+30"]

1. e4 {[%clk 1:30:00]} e5 {[%clk 1:29:50.5]} 2. Bc4 (2. Nf3 Nc6) Nc6 3. Qh5 Nf6?? 4. Qxf7# 1-0

[Event "Zweite"]
[White "A"]
[Black "B"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 0-0-0? 1/2-1/2
"#;

    #[test]
    fn parses_headers_moves_and_clocks() {
        let games = split_games(SAMPLE);
        assert_eq!(games.len(), 2);
        let p = parse(&games[0]);
        assert_eq!(p.header("White"), Some("Meier, Anna"));
        assert_eq!(p.moves, ["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"]);
        assert_eq!(p.clocks[0], Some(540_000));
        assert_eq!(p.clocks[1], Some(539_050));
        assert_eq!(p.clocks[2], None);
        assert!(p.full_clocks().is_none());
    }

    #[test]
    fn builds_a_game() {
        let p = parse(&split_games(SAMPLE)[0]);
        let g = to_game(&p, Some("black"), 0).unwrap();
        assert_eq!(g.white.name, "Meier, Anna");
        assert_eq!(g.white.rating, Some(1650));
        assert_eq!(g.black.name, LOCAL_PLAYER);
        assert_eq!(g.winner.as_deref(), Some("white"));
        assert_eq!(g.status, "mate");
        assert_eq!(g.speed, "classical");
        assert_eq!(g.time_control.as_deref(), Some("90+30"));
        assert_eq!(g.source, Source::Local);
        assert_eq!(civil_from_days(g.created_at.div_euclid(86_400_000)), (2024, 3, 15));
        // same game again -> same id (no duplicates on re-import)
        assert_eq!(g.id, to_game(&p, Some("black"), 0).unwrap().id);
    }

    #[test]
    fn refuses_games_that_are_still_running() {
        let game = |headers: &str, result: &str| format!("{headers}\n[Result \"{result}\"]\n\n1. e4 e5 2. Nf3 Nc6 {result}\n");
        let running = |pgn: &str| to_game(&parse(pgn), Some("white"), 0).err().is_some_and(|e| e.contains("läuft noch") || e.contains("still running"));
        // chess.com daily game copied mid-game
        assert!(running(&game("[Site \"Chess.com\"]\n[TimeControl \"1/86400\"]\n[CurrentPosition \"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -\"]", "*")));
        // Lichess game in progress
        assert!(running(&game("[Site \"https://lichess.org/abcdefgh\"]\n[TimeControl \"300+3\"]", "*")));
        // finished: fine
        assert!(!running(&game("[Site \"https://lichess.org/abcdefgh\"]\n[TimeControl \"300+3\"]", "1-0")));
        // studies, books, own analysis with "*": fine
        assert!(!running(&game("[Site \"https://lichess.org/study/abcdefgh/ijklmnop\"]", "*")));
        assert!(!running(&game("[Event \"Lehrbuch\"]", "*")));
        // "*" but mate on the board: over
        let mate = "[Site \"Chess.com\"]\n[Result \"*\"]\n\n1. f3 e5 2. g4 Qh4# *\n";
        assert!(!running(mate));
    }

    #[test]
    fn rejects_illegal_moves_with_move_number() {
        let p = parse(&split_games(SAMPLE)[1]);
        let e = to_game(&p, None, 0).unwrap_err();
        assert!(e.contains("2..."), "{e}");
    }

    #[test]
    fn export_roundtrips() {
        let p = parse(&split_games(SAMPLE)[0]);
        let g = to_game(&p, None, 0).unwrap();
        let back = parse(&export(&g));
        assert_eq!(back.moves, g.moves);
        assert_eq!(back.header("Result"), Some("1-0"));
        assert_eq!(back.header("White"), Some("Meier, Anna"));
    }

    #[test]
    fn castling_with_zeros() {
        let p = parse("1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. 0-0 *");
        let g = to_game(&p, None, 0).unwrap();
        assert_eq!(g.moves[6], "O-O");
    }
}
