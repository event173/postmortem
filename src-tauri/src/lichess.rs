//! Fetching games from the public Lichess API (no account or token needed).

use serde::{Deserialize, Serialize};

const API: &str = "https://lichess.org";
const USER_AGENT: &str = concat!("postmortem/", env!("CARGO_PKG_VERSION"), " (local game review tool)");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opening {
    pub eco: String,
    pub name: String,
    /// Number of plies that are covered by the named opening ("book" moves).
    pub ply: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub name: String,
    pub rating: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub id: String,
    pub white: Player,
    pub black: Player,
    /// "white", "black" or None for a draw / unfinished game.
    pub winner: Option<String>,
    pub status: String,
    pub speed: String,
    pub rated: bool,
    pub time_control: Option<String>,
    pub created_at: i64,
    pub opening: Option<Opening>,
    /// Moves in SAN.
    pub moves: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGame {
    id: String,
    #[serde(default)]
    rated: bool,
    variant: String,
    speed: String,
    created_at: i64,
    status: String,
    winner: Option<String>,
    players: RawPlayers,
    opening: Option<Opening>,
    #[serde(default)]
    moves: String,
    initial_fen: Option<String>,
    clock: Option<RawClock>,
}

#[derive(Deserialize)]
struct RawPlayers {
    white: RawPlayer,
    black: RawPlayer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlayer {
    user: Option<RawUser>,
    rating: Option<u32>,
    ai_level: Option<u8>,
}

#[derive(Deserialize)]
struct RawUser {
    name: String,
}

#[derive(Deserialize)]
struct RawClock {
    initial: u32,
    increment: u32,
}

impl RawPlayer {
    fn into_player(self) -> Player {
        let name = match (self.user, self.ai_level) {
            (Some(u), _) => u.name,
            (None, Some(level)) => format!("Stockfish Stufe {level}"),
            (None, None) => "Anonym".to_string(),
        };
        Player { name, rating: self.rating }
    }
}

impl RawGame {
    /// Only standard chess from the initial position is supported.
    fn into_game(self) -> Option<GameInfo> {
        if self.variant != "standard" || self.initial_fen.is_some() || self.moves.trim().is_empty() {
            return None;
        }
        Some(GameInfo {
            id: self.id,
            white: self.players.white.into_player(),
            black: self.players.black.into_player(),
            winner: self.winner,
            status: self.status,
            speed: self.speed,
            rated: self.rated,
            time_control: self.clock.map(|c| format!("{}+{}", c.initial / 60, c.increment)),
            created_at: self.created_at,
            opening: self.opening,
            moves: self.moves.split_whitespace().map(str::to_string).collect(),
        })
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())
}

fn check_status(resp: &reqwest::Response, what: &str) -> Result<(), String> {
    match resp.status().as_u16() {
        200..=299 => Ok(()),
        404 => Err(format!("{what} nicht gefunden.")),
        429 => Err("Lichess drosselt gerade die Anfragen. Bitte eine Minute warten.".into()),
        code => Err(format!("Lichess antwortete mit Fehler {code}.")),
    }
}

/// Most recent standard games of a user.
pub async fn fetch_user_games(username: &str, max: u32) -> Result<Vec<GameInfo>, String> {
    let username = username.trim();
    if username.is_empty() || !username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Ungültiger Benutzername.".into());
    }
    let url = format!("{API}/api/games/user/{username}");
    let resp = client()?
        .get(url)
        .query(&[("max", max.to_string().as_str()), ("opening", "true"), ("moves", "true")])
        .header("Accept", "application/x-ndjson")
        .send()
        .await
        .map_err(|e| format!("Keine Verbindung zu Lichess: {e}"))?;
    check_status(&resp, "Spieler")?;
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let games = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<RawGame>(l).ok())
        .filter_map(RawGame::into_game)
        .collect();
    Ok(games)
}

/// Extract an 8-character game id from a Lichess URL or id.
pub fn parse_game_id(input: &str) -> Option<String> {
    let input = input.trim().trim_end_matches('/');
    let path = match input.find("lichess.org/") {
        Some(i) => &input[i + "lichess.org/".len()..],
        None => input,
    };
    let first = path.split(['/', '?', '#']).next()?;
    let id: String = first.chars().take(8).collect();
    (id.len() == 8 && id.chars().all(|c| c.is_ascii_alphanumeric())).then_some(id)
}

/// A single game by URL or id.
pub async fn fetch_game(input: &str) -> Result<GameInfo, String> {
    let id = parse_game_id(input).ok_or("Das sieht nicht nach einem Lichess-Partielink aus.")?;
    let resp = client()?
        .get(format!("{API}/game/export/{id}"))
        .query(&[("opening", "true"), ("moves", "true")])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Keine Verbindung zu Lichess: {e}"))?;
    check_status(&resp, "Partie")?;
    let raw: RawGame = resp.json().await.map_err(|e| format!("Unerwartete Antwort: {e}"))?;
    raw.into_game()
        .ok_or_else(|| "Nur Standard-Schach ab der Grundstellung wird unterstützt.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_ids() {
        assert_eq!(parse_game_id("https://lichess.org/AbCd1234").as_deref(), Some("AbCd1234"));
        assert_eq!(parse_game_id("https://lichess.org/AbCd1234/black").as_deref(), Some("AbCd1234"));
        assert_eq!(parse_game_id("lichess.org/AbCd1234WxYz").as_deref(), Some("AbCd1234"));
        assert_eq!(parse_game_id("AbCd1234"), Some("AbCd1234".into()));
        assert_eq!(parse_game_id("https://lichess.org/@/foo"), None);
    }

    #[test]
    fn parses_raw_game() {
        let json = r#"{"id":"q7ZvsdUF","rated":true,"variant":"standard","speed":"blitz","perf":"blitz",
            "createdAt":1514505150384,"lastMoveAt":1514505592843,"status":"mate","winner":"white",
            "players":{"white":{"user":{"name":"Alice","id":"alice"},"rating":1500},
                       "black":{"aiLevel":3}},
            "opening":{"eco":"C20","name":"King's Pawn Game","ply":2},
            "moves":"e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#","clock":{"initial":300,"increment":3,"totalTime":420}}"#;
        let g = serde_json::from_str::<RawGame>(json).unwrap().into_game().unwrap();
        assert_eq!(g.white.name, "Alice");
        assert_eq!(g.black.name, "Stockfish Stufe 3");
        assert_eq!(g.moves.len(), 7);
        assert_eq!(g.time_control.as_deref(), Some("5+3"));
        assert_eq!(g.opening.unwrap().ply, 2);
    }
}
