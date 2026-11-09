//! Free opening exploration ("Frei spielen"): the candidate moves of a position
//! from three sources –
//! - your own games (how often a move came up, by whom, and how it ended),
//! - opening theory (the embedded opening list),
//! - the Lichess opening explorer (how often it's played at your level), which
//!   needs a personal API token of the user (no scopes; stored locally only).
//!
//! Lichess asks for one request at a time and a minute's pause after a 429;
//! answers are cached for the session.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use shakmaty::{san::San, uci::UciMove, CastlingMode, Chess, Position};

use crate::db::{Account, Db};
use crate::lichess::Source;
use crate::openings::{self, epd};
use crate::repertoire::my_color;

const TOKEN_KEY: &str = "lichess_token";
const TOKEN_USER_KEY: &str = "lichess_token_user";
const EXPLORER: &str = "https://explorer.lichess.org/lichess";
/// Only the first moves of your games are indexed.
const INDEX_PLIES: usize = 30;
/// Lichess rating groups (the explorer's buckets).
const BUCKETS: [u32; 9] = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnStats {
    /// Games in which this move was played here.
    pub games: usize,
    /// … of them played by you (the rest by your opponents).
    pub by_you: usize,
    /// Results from your point of view.
    pub wins: usize,
    pub draws: usize,
    pub losses: usize,
    /// A few of those games, newest first: (game id, ply of the move).
    pub examples: Vec<(String, usize)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub uci: String,
    pub san: String,
    pub own: Option<OwnStats>,
    /// A move of the opening theory (the embedded list).
    pub book: bool,
    /// Name of the opening after this move, if it has one.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moves {
    /// Name of the opening in this position (the deepest named one on the way is the frontend's job).
    pub opening: Option<String>,
    pub moves: Vec<Candidate>,
    /// Your games in the index.
    pub games: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LichessMove {
    pub uci: String,
    pub san: String,
    pub white: u64,
    pub draws: u64,
    pub black: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LichessData {
    pub total: u64,
    pub moves: Vec<LichessMove>,
    /// "1600–2000" (the rating groups asked for).
    pub ratings: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    pub set: bool,
    /// The Lichess account the token belongs to.
    pub user: Option<String>,
}

#[derive(Deserialize)]
struct RawExplorer {
    white: u64,
    draws: u64,
    black: u64,
    moves: Vec<LichessMove>,
}

type OwnIndex = HashMap<String, HashMap<String, OwnStats>>;

#[derive(Default)]
pub struct Explorer {
    own: Mutex<(OwnIndex, usize)>,
    cache: Mutex<HashMap<String, LichessData>>,
    /// One Lichess request at a time.
    busy: tauri::async_runtime::Mutex<()>,
    /// After a 429: no requests before this time (ms).
    cooldown_until: Mutex<i64>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Explorer {
    /// Index the first moves of all stored games of the accounts.
    pub fn prepare(&self, db: &Db, accounts: &[Account]) -> Result<usize, String> {
        let games = db.games_of(accounts, 1_000_000)?;
        let mut index: OwnIndex = HashMap::new();
        for g in &games {
            let game = &g.game;
            let Some(me) = my_color(game, accounts) else { continue };
            let result = match game.winner.as_deref() {
                None => 0,
                Some(w) if w == me => 1,
                Some(_) => -1,
            };
            let mut pos = Chess::default();
            for (i, san) in game.moves.iter().take(INDEX_PLIES).enumerate() {
                let Some(m) = san.parse::<San>().ok().and_then(|s| s.to_move(&pos).ok()) else { break };
                let uci = UciMove::from_move(m, CastlingMode::Standard).to_string();
                let s = index.entry(epd(&pos)).or_default().entry(uci).or_default();
                s.games += 1;
                let mover = if i % 2 == 0 { "white" } else { "black" };
                s.by_you += (mover == me) as usize;
                match result {
                    1 => s.wins += 1,
                    -1 => s.losses += 1,
                    _ => s.draws += 1,
                }
                if s.examples.len() < 5 {
                    s.examples.push((game.id.clone(), i + 1));
                }
                pos.play_unchecked(m);
            }
        }
        let n = games.len();
        *self.own.lock().unwrap() = (index, n);
        Ok(n)
    }

    /// Candidates from your games and the theory, most relevant first.
    pub fn moves(&self, fen: &str) -> Result<Moves, String> {
        let pos = crate::analysis::parse_fen(fen)?;
        let key = epd(&pos);
        let (own, games) = {
            let g = self.own.lock().unwrap();
            (g.0.get(&key).cloned().unwrap_or_default(), g.1)
        };
        let book = openings::book().next.get(&key).cloned().unwrap_or_default();
        let mut ucis: Vec<String> = Vec::new();
        // Your games first (most played), then the remaining theory moves (main line first).
        let mut by_count: Vec<(&String, &OwnStats)> = own.iter().collect();
        by_count.sort_by(|a, b| b.1.games.cmp(&a.1.games).then_with(|| a.0.cmp(b.0)));
        ucis.extend(by_count.into_iter().map(|(u, _)| u.clone()));
        for u in &book {
            if !ucis.contains(u) {
                ucis.push(u.clone());
            }
        }
        let moves = ucis
            .into_iter()
            .filter_map(|uci| {
                let m = uci.parse::<UciMove>().ok()?.to_move(&pos).ok()?;
                let san = San::from_move(&pos, m).to_string();
                let mut after = pos.clone();
                after.play_unchecked(m);
                Some(Candidate {
                    san,
                    own: own.get(&uci).cloned(),
                    book: book.contains(&uci),
                    name: openings::name_at(&after),
                    uci,
                })
            })
            .collect();
        Ok(Moves { opening: openings::name_at(&pos), moves, games })
    }

    /// How often each move is played on Lichess at your level (None without a token).
    pub async fn lichess(&self, fen: &str, token: Option<String>, rating: Option<u32>) -> Result<Option<LichessData>, String> {
        let Some(token) = token else { return Ok(None) };
        let ratings = buckets(rating);
        let key = format!("{fen}|{ratings:?}");
        if let Some(hit) = self.cache.lock().unwrap().get(&key) {
            return Ok(Some(hit.clone()));
        }
        let _one_at_a_time = self.busy.lock().await;
        if let Some(hit) = self.cache.lock().unwrap().get(&key) {
            return Ok(Some(hit.clone()));
        }
        if now_ms() < *self.cooldown_until.lock().unwrap() {
            return Err(tr!("Lichess bremst gerade die Anfragen – in einer Minute geht es weiter.", "Lichess is rate-limiting – try again in a minute."));
        }
        let list = ratings.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let resp = crate::lichess::client()?
            .get(EXPLORER)
            .bearer_auth(&token)
            .query(&[
                ("variant", "standard"),
                ("speeds", "blitz,rapid,classical"),
                ("ratings", list.as_str()),
                ("fen", fen),
                ("moves", "12"),
                ("topGames", "0"),
                ("recentGames", "0"),
            ])
            .send()
            .await
            .map_err(|e| tr!("Lichess nicht erreichbar: {e}", "Lichess not reachable: {e}"))?;
        match resp.status().as_u16() {
            200 => {}
            401 => return Err(tr!("Der Lichess-Schlüssel gilt nicht (mehr). Trag in den Einstellungen einen neuen ein.", "The Lichess token is not valid (any more). Enter a new one in the settings.")),
            429 => {
                *self.cooldown_until.lock().unwrap() = now_ms() + 61_000;
                return Err(tr!("Lichess bremst gerade die Anfragen – in einer Minute geht es weiter.", "Lichess is rate-limiting – try again in a minute."));
            }
            code => return Err(tr!("Lichess antwortete mit Fehler {code}.", "Lichess answered with error {code}.")),
        }
        let raw: RawExplorer = resp.json().await.map_err(|e| e.to_string())?;
        let data = LichessData {
            total: raw.white + raw.draws + raw.black,
            moves: raw.moves,
            ratings: label(&ratings),
        };
        self.cache.lock().unwrap().insert(key, data.clone());
        Ok(Some(data))
    }
}

/// Your rating group and the one above (e.g. 1700 -> 1600, 1800).
fn buckets(rating: Option<u32>) -> Vec<u32> {
    let Some(r) = rating else { return vec![1400, 1600, 1800] };
    let i = BUCKETS.iter().rposition(|&b| b <= r).unwrap_or(0);
    BUCKETS[i..(i + 2).min(BUCKETS.len())].to_vec()
}

/// "1600–2000": from the lowest group to the start of the next one above.
fn label(ratings: &[u32]) -> String {
    let lo = ratings.first().copied().unwrap_or(0);
    let hi = ratings.last().and_then(|l| BUCKETS.iter().find(|&&b| b > *l)).copied();
    match hi {
        Some(hi) => format!("{lo}–{hi}"),
        None => format!("{lo}+"),
    }
}

pub fn token(db: &Db) -> Option<String> {
    db.setting(TOKEN_KEY).ok().flatten().filter(|t| !t.is_empty())
}

pub fn token_status(db: &Db) -> TokenStatus {
    TokenStatus { set: token(db).is_some(), user: db.setting(TOKEN_USER_KEY).ok().flatten() }
}

/// Check a token with Lichess (who does it belong to?) before storing it.
pub async fn check_token(token: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Account {
        username: String,
    }
    let resp = crate::lichess::client()?
        .get("https://lichess.org/api/account")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| tr!("Lichess nicht erreichbar: {e}", "Lichess not reachable: {e}"))?;
    if resp.status().as_u16() == 401 {
        return Err(tr!("Lichess kennt diesen Schlüssel nicht.", "Lichess doesn't know this token."));
    }
    crate::lichess::check_status(&resp, "Konto")?;
    Ok(resp.json::<Account>().await.map_err(|e| e.to_string())?.username)
}

pub fn store_token(db: &Db, token: Option<(&str, &str)>) -> Result<(), String> {
    db.set_setting(TOKEN_KEY, token.map(|t| t.0))?;
    db.set_setting(TOKEN_USER_KEY, token.map(|t| t.1))
}

/// Your current Lichess rating (from your newest stored rated game).
pub fn my_rating(db: &Db, accounts: &[Account]) -> Option<u32> {
    let lichess: Vec<Account> = accounts.iter().filter(|a| a.source == Source::Lichess).cloned().collect();
    if lichess.is_empty() {
        return None;
    }
    let games = db.games_of(&lichess, 30).ok()?;
    games.iter().filter(|g| g.game.rated).find_map(|g| {
        let me = my_color(&g.game, &lichess)?;
        if me == "white" { g.game.white.rating } else { g.game.black.rating }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rating_groups() {
        assert_eq!(buckets(Some(1700)), [1600, 1800]);
        assert_eq!(buckets(Some(900)), [0, 1000]);
        assert_eq!(buckets(Some(2700)), [2500]);
        assert_eq!(buckets(None), [1400, 1600, 1800]);
        assert_eq!(label(&[1600, 1800]), "1600–2000");
        assert_eq!(label(&[2500]), "2500+");
    }

    #[test]
    fn theory_candidates_without_games() {
        let ex = Explorer::default();
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let m = ex.moves(start).unwrap();
        assert!(m.moves.len() > 5);
        assert!(m.moves.iter().take(3).any(|c| c.san == "e4"), "{:?}", m.moves.iter().map(|c| &c.san).collect::<Vec<_>>());
        assert!(m.moves.iter().all(|c| c.book && c.own.is_none()));
        let after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        let sicilian = ex.moves(after_e4).unwrap().moves.into_iter().find(|c| c.san == "c5").unwrap();
        assert_eq!(sicilian.name.as_deref(), Some("Sicilian Defense"));
    }
}
