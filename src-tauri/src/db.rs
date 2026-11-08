//! Local SQLite store for games and reviews, so everything works offline.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::analysis::{GameReview, REVIEW_VERSION};
use crate::lichess::GameInfo;

/// Bump together with a new entry in `MIGRATIONS`.
const MIGRATIONS: &[&str] = &[
    // 1: games and reviews
    "CREATE TABLE games (
        id         TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        white      TEXT NOT NULL COLLATE NOCASE,
        black      TEXT NOT NULL COLLATE NOCASE,
        data       TEXT NOT NULL
     );
     CREATE INDEX games_white ON games(white, created_at);
     CREATE INDEX games_black ON games(black, created_at);
     CREATE TABLE reviews (
        game_id    TEXT NOT NULL,
        depth      INTEGER NOT NULL,
        version    INTEGER NOT NULL,
        data       TEXT NOT NULL,
        PRIMARY KEY (game_id, depth, version)
     );",
];

pub struct Db {
    conn: Connection,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredGame {
    #[serde(flatten)]
    pub game: GameInfo,
    /// A review with the current classification logic exists (any depth).
    pub analysed: bool,
}

fn sql_err(e: rusqlite::Error) -> String {
    format!("Datenbankfehler: {e}")
}

impl Db {
    pub fn open(path: &Path) -> Result<Db, String> {
        let conn = Connection::open(path).map_err(sql_err)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn in_memory() -> Db {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn init(conn: Connection) -> Result<Db, String> {
        conn.pragma_update(None, "journal_mode", "WAL").map_err(sql_err)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(sql_err)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(sql_err)?;
        for (i, migration) in MIGRATIONS.iter().enumerate().skip(version.max(0) as usize) {
            conn.execute_batch(&format!("BEGIN; {migration} PRAGMA user_version = {}; COMMIT;", i + 1))
                .map_err(sql_err)?;
        }
        Ok(Db { conn })
    }

    pub fn save_games(&mut self, games: &[GameInfo]) -> Result<usize, String> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        let mut inserted = 0;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO games (id, created_at, white, black, data) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                )
                .map_err(sql_err)?;
            let mut exists = tx.prepare("SELECT 1 FROM games WHERE id = ?1").map_err(sql_err)?;
            for g in games {
                let known = exists.exists([&g.id]).map_err(sql_err)?;
                let json = serde_json::to_string(g).map_err(|e| e.to_string())?;
                stmt.execute(params![g.id, g.created_at, g.white.name, g.black.name, json])
                    .map_err(sql_err)?;
                if !known {
                    inserted += 1;
                }
            }
        }
        tx.commit().map_err(sql_err)?;
        Ok(inserted)
    }

    /// Games of a player, newest first.
    pub fn games_of(&self, username: &str, limit: u32) -> Result<Vec<StoredGame>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT g.data, EXISTS(SELECT 1 FROM reviews r WHERE r.game_id = g.id AND r.version = ?3)
                 FROM games g WHERE g.white = ?1 OR g.black = ?1
                 ORDER BY g.created_at DESC LIMIT ?2",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![username, limit, REVIEW_VERSION], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
            })
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (json, analysed) = row.map_err(sql_err)?;
            if let Ok(game) = serde_json::from_str(&json) {
                out.push(StoredGame { game, analysed });
            }
        }
        Ok(out)
    }

    /// (newest, oldest) `created_at` of a player's stored games.
    pub fn time_range(&self, username: &str) -> Result<Option<(i64, i64)>, String> {
        self.conn
            .query_row(
                "SELECT MAX(created_at), MIN(created_at) FROM games WHERE white = ?1 OR black = ?1",
                [username],
                |r| Ok(r.get::<_, Option<i64>>(0)?.zip(r.get::<_, Option<i64>>(1)?)),
            )
            .map_err(sql_err)
    }

    /// Best stored review for a game: the requested depth, or any deeper one.
    pub fn review(&self, game_id: &str, min_depth: u32) -> Result<Option<GameReview>, String> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT data FROM reviews WHERE game_id = ?1 AND version = ?2 AND depth >= ?3
                 ORDER BY depth = ?3 DESC, depth DESC LIMIT 1",
                params![game_id, REVIEW_VERSION, min_depth],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
    }

    pub fn save_review(&self, review: &GameReview) -> Result<(), String> {
        let json = serde_json::to_string(review).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO reviews (game_id, depth, version, data) VALUES (?1, ?2, ?3, ?4)",
                params![review.game_id, review.depth, review.version, json],
            )
            .map_err(sql_err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::Accuracy;
    use crate::lichess::Player;

    fn game(id: &str, white: &str, black: &str, at: i64) -> GameInfo {
        GameInfo {
            id: id.into(),
            white: Player { name: white.into(), rating: Some(1500) },
            black: Player { name: black.into(), rating: None },
            winner: Some("white".into()),
            status: "mate".into(),
            speed: "blitz".into(),
            rated: true,
            time_control: Some("3+2".into()),
            created_at: at,
            opening: None,
            moves: vec!["e4".into(), "e5".into()],
        }
    }

    fn review(id: &str, depth: u32) -> GameReview {
        GameReview {
            version: REVIEW_VERSION,
            game_id: id.into(),
            depth,
            fens: vec![],
            evals: vec![],
            win_white: vec![],
            moves: vec![],
            accuracy: Accuracy { white: 90.0, black: 80.0 },
        }
    }

    #[test]
    fn stores_games_case_insensitively_newest_first() {
        let mut db = Db::in_memory();
        let n = db
            .save_games(&[game("a", "Alice", "Bob", 1), game("b", "Carol", "alice", 3), game("c", "X", "Y", 2)])
            .unwrap();
        assert_eq!(n, 3);
        // Saving again does not count as new.
        assert_eq!(db.save_games(&[game("a", "Alice", "Bob", 1)]).unwrap(), 0);

        let games = db.games_of("ALICE", 10).unwrap();
        let ids: Vec<_> = games.iter().map(|g| g.game.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(db.time_range("alice").unwrap(), Some((3, 1)));
        assert_eq!(db.time_range("nobody").unwrap(), None);
    }

    #[test]
    fn reviews_prefer_exact_depth_then_deeper() {
        let mut db = Db::in_memory();
        db.save_games(&[game("a", "Alice", "Bob", 1)]).unwrap();
        assert!(db.review("a", 16).unwrap().is_none());
        db.save_review(&review("a", 20)).unwrap();
        assert_eq!(db.review("a", 16).unwrap().unwrap().depth, 20);
        db.save_review(&review("a", 16)).unwrap();
        assert_eq!(db.review("a", 16).unwrap().unwrap().depth, 16);
        assert!(db.review("a", 24).unwrap().is_none());
        assert!(db.games_of("alice", 10).unwrap()[0].analysed);
    }
}
