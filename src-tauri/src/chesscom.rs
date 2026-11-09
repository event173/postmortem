//! Fetching games from chess.com's official Published-Data API
//! (https://www.chess.com/news/view/published-data-api): public, read-only,
//! no account needed. Requests are made one after another, as chess.com asks.

use serde::Deserialize;

use crate::lichess::{check_status, client, network_error, FetchError, GameInfo, GameQuery, Opening, Player, Source};
use crate::openings;

const API: &str = "https://api.chess.com/pub";
const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

#[derive(Deserialize)]
struct Archives {
    archives: Vec<String>,
}

#[derive(Deserialize)]
struct Month {
    games: Vec<RawGame>,
}

#[derive(Deserialize)]
struct RawGame {
    url: String,
    #[serde(default)]
    pgn: String,
    #[serde(default)]
    time_control: String,
    end_time: i64,
    #[serde(default)]
    rated: bool,
    #[serde(default)]
    time_class: String,
    #[serde(default)]
    rules: String,
    #[serde(default)]
    initial_setup: String,
    white: RawPlayer,
    black: RawPlayer,
}

#[derive(Deserialize)]
struct RawPlayer {
    username: String,
    rating: Option<u32>,
    result: String,
}

/// "180+2" -> "3+2", "600" -> "10+0"; daily games ("1/259200") -> None.
fn time_control(tc: &str) -> Option<String> {
    if tc.contains('/') {
        return None;
    }
    let mut parts = tc.split('+');
    let base: u32 = parts.next()?.parse().ok()?;
    let inc: u32 = parts.next().and_then(|i| i.parse().ok()).unwrap_or(0);
    let base = if base.is_multiple_of(60) { (base / 60).to_string() } else { format!("{:.1}", base as f64 / 60.0) };
    Some(format!("{base}+{inc}"))
}

impl RawGame {
    /// Only standard chess from the initial position is supported.
    fn into_game(self) -> Option<GameInfo> {
        if self.rules != "chess" || (!self.initial_setup.is_empty() && self.initial_setup != START_FEN) {
            return None;
        }
        let parsed = crate::pgn::parse(&self.pgn);
        let clocks = parsed.full_clocks();
        let moves = parsed.moves;
        if moves.is_empty() {
            return None;
        }
        let number = self.url.trim_end_matches('/').rsplit('/').next()?.to_string();
        let winner = match (self.white.result.as_str(), self.black.result.as_str()) {
            ("win", _) => Some("white".to_string()),
            (_, "win") => Some("black".to_string()),
            _ => None,
        };
        // The loser's result says how the game ended ("checkmated", "resigned", "timeout" …);
        // for draws both sides carry the reason ("agreed", "repetition" …).
        let status = match winner.as_deref() {
            Some("white") => self.black.result.clone(),
            _ => self.white.result.clone(),
        };
        let opening: Option<Opening> = openings::identify(&moves);
        Some(GameInfo {
            id: format!("cc{number}"),
            source: Source::Chesscom,
            url: Some(self.url),
            white: Player { name: self.white.username, rating: self.white.rating },
            black: Player { name: self.black.username, rating: self.black.rating },
            winner,
            status,
            speed: if self.time_class == "daily" { "correspondence".into() } else { self.time_class },
            rated: self.rated,
            time_control: time_control(&self.time_control),
            created_at: self.end_time * 1000,
            opening,
            moves,
            clocks,
        })
    }
}

pub fn valid_username(username: &str) -> bool {
    !username.is_empty()
        && username.len() <= 30
        && username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// (year, month) in UTC of a millisecond timestamp.
fn year_month(ms: i64) -> (i64, u32) {
    // Civil-from-days (Howard Hinnant), valid for all dates we care about.
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m)
}

/// (year, month) from an archive URL ending in ".../YYYY/MM".
fn archive_month(url: &str) -> Option<(i64, u32)> {
    let mut parts = url.trim_end_matches('/').rsplit('/');
    let m = parts.next()?.parse().ok()?;
    let y = parts.next()?.parse().ok()?;
    Some((y, m))
}

async fn get<T: serde::de::DeserializeOwned>(url: &str, what: &str) -> Result<T, FetchError> {
    let resp = client()?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(network_error)?;
    check_status(&resp, what)?;
    resp.json::<T>()
        .await
        .map_err(|e| FetchError::Other(crate::tr!("Unerwartete Antwort von chess.com: {e}", "Unexpected answer from chess.com: {e}")))
}

/// Standard games of a user, newest first. chess.com serves games per month,
/// so we walk the monthly archives from newest to oldest.
pub async fn fetch_user_games(username: &str, q: GameQuery) -> Result<Vec<GameInfo>, FetchError> {
    let username = username.trim().to_lowercase();
    if !valid_username(&username) {
        return Err(crate::tr!("Ungültiger Benutzername.", "Invalid username.").into());
    }
    let archives: Archives = get(&format!("{API}/player/{username}/games/archives"), "Spieler").await?;
    let since_month = q.since.map(year_month);
    let until_month = q.until.map(year_month);

    let mut out: Vec<GameInfo> = Vec::new();
    for url in archives.archives.iter().rev() {
        let Some(month) = archive_month(url) else { continue };
        if since_month.is_some_and(|s| month < s) {
            break;
        }
        if until_month.is_some_and(|u| month > u) {
            continue;
        }
        let data: Month = get(url, "Archiv").await?;
        out.extend(
            data.games
                .into_iter()
                .filter_map(RawGame::into_game)
                .filter(|g| q.since.is_none_or(|s| g.created_at >= s))
                .filter(|g| q.until.is_none_or(|u| g.created_at <= u)),
        );
        if q.since.is_none() && q.max.is_some_and(|max| out.len() >= max as usize) {
            break;
        }
    }
    out.sort_by_key(|g| std::cmp::Reverse(g.created_at));
    if let Some(max) = q.max {
        out.truncate(max as usize);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PGN: &str = r#"[Event "Live Chess"]
[Site "Chess.com"]
[White "erik"]
[Black "Riphyak"]
[Result "1-0"]

1. e4 {[%clk 0:00:00.3]} 1... d5 {[%clk 2:12:37.1]} 2. exd5 {[%clk 0:00:07.4]} 2... Qxd5 3. Nc3 Qa5 4. g3!? (4. d4 Nf6) 4... Nf6 $1 5. Bg2 c6 6. Nge2 Bf5 7. O-O e6 8. d3 Qxa2?? 9. Rxa2 1-0"#;

    #[test]
    fn parses_pgn_moves() {
        let moves = crate::pgn::parse(PGN).moves;
        assert_eq!(
            moves,
            ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5", "g3", "Nf6", "Bg2", "c6", "Nge2", "Bf5", "O-O", "e6", "d3", "Qxa2", "Rxa2"]
        );
        assert!(crate::analysis::replay(&moves).is_ok());
    }

    #[test]
    fn converts_raw_game() {
        let json = r#"{"url":"https://www.chess.com/game/live/1051690676","pgn":"1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
            "time_control":"180+2","end_time":1793980009,"rated":true,"time_class":"blitz","rules":"chess",
            "initial_setup":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "white":{"rating":1502,"result":"win","username":"erik"},
            "black":{"rating":1419,"result":"checkmated","username":"Riphyak"}}"#;
        let g = serde_json::from_str::<RawGame>(json).unwrap().into_game().unwrap();
        assert_eq!(g.id, "cc1051690676");
        assert_eq!(g.source, Source::Chesscom);
        assert_eq!(g.winner.as_deref(), Some("white"));
        assert_eq!(g.status, "checkmated");
        assert_eq!(g.time_control.as_deref(), Some("3+2"));
        assert_eq!(g.created_at, 1_793_980_009_000);
        assert_eq!(g.moves.len(), 7);
        assert!(g.opening.is_some());
    }

    #[test]
    fn skips_variants() {
        let json = r#"{"url":"https://www.chess.com/game/live/1","pgn":"1. e4 e5","end_time":1,"rules":"chess960",
            "white":{"result":"win","username":"a"},"black":{"result":"resigned","username":"b"}}"#;
        assert!(serde_json::from_str::<RawGame>(json).unwrap().into_game().is_none());
    }

    #[test]
    fn months() {
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(1_793_980_009_000), (2026, 11));
        assert_eq!(year_month(951_782_400_000), (2000, 2)); // 2000-02-29
        assert_eq!(archive_month("https://api.chess.com/pub/player/erik/games/2026/11"), Some((2026, 11)));
        assert_eq!(time_control("600"), Some("10+0".into()));
        assert_eq!(time_control("90+1"), Some("1.5+1".into()));
        assert_eq!(time_control("1/259200"), None);
    }
}

#[cfg(test)]
mod live_api {
    use super::*;

    /// Run with: cargo test chesscom::live_api -- --ignored --nocapture
    #[test]
    #[ignore]
    fn fetches_recent_games_and_slices_by_time() {
        let run = |q| tauri::async_runtime::block_on(fetch_user_games("erik", q)).unwrap();
        let latest = run(GameQuery { max: Some(5), ..Default::default() });
        assert!(!latest.is_empty());
        for g in &latest {
            println!("{} {} vs {} {:?} {:?} {} moves", g.id, g.white.name, g.black.name, g.time_control,
                g.opening.as_ref().map(|o| &o.name), g.moves.len());
            crate::analysis::replay(&g.moves).expect("moves must replay");
        }
        assert!(latest.windows(2).all(|w| w[0].created_at >= w[1].created_at));
        let newest = latest[0].created_at;
        assert!(run(GameQuery { since: Some(newest + 1), max: Some(10), ..Default::default() }).is_empty());
        let older = run(GameQuery { until: Some(newest - 1), max: Some(3), ..Default::default() });
        assert!(older.iter().all(|g| g.created_at < newest));
    }
}
