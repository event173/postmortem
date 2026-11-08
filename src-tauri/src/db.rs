//! Local SQLite store for games and reviews, so everything works offline.

use std::path::Path;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::analysis::{GameReview, REVIEW_VERSION};
use crate::lichess::{GameInfo, Source};

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
    // 2: games from several platforms
    "ALTER TABLE games ADD COLUMN source TEXT NOT NULL DEFAULT 'lichess';
     CREATE INDEX games_source ON games(source, created_at);",
    // 3: settings the backend needs (engine path, threads)
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    // 4: puzzle attempts (rating, mastery per theme, no repeats)
    "CREATE TABLE puzzle_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        puzzle_id TEXT NOT NULL,
        kind      TEXT NOT NULL,
        theme     TEXT,
        solved    INTEGER NOT NULL,
        rating    INTEGER,
        at        INTEGER NOT NULL
     );
     CREATE INDEX puzzle_log_puzzle ON puzzle_log(puzzle_id, at);
     CREATE INDEX puzzle_log_theme ON puzzle_log(theme, at);",
];

/// One puzzle attempt.
#[derive(Debug, Clone)]
pub struct Attempt {
    pub puzzle_id: String,
    /// "lichess" or "own"
    pub kind: String,
    /// Weakness theme the puzzle was chosen for (serde name), if any.
    pub theme: Option<String>,
    pub solved: bool,
    pub rating: Option<i64>,
    /// Unix milliseconds.
    pub at: i64,
}

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

/// A player account on one platform.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub source: Source,
    pub username: String,
}

impl Account {
    pub fn new(source: Source, username: &str) -> Account {
        Account { source, username: username.trim().to_string() }
    }
}

/// SQL condition matching games of any of the accounts (table alias `g`),
/// with numbered placeholders starting at `first`. No accounts matches nothing.
fn account_filter(accounts: &[Account], first: usize) -> (String, Vec<String>) {
    if accounts.is_empty() {
        return ("0".into(), vec![]);
    }
    let mut args = Vec::new();
    let parts: Vec<String> = accounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let (s, u) = (first + 2 * i, first + 2 * i + 1);
            args.push(a.source.as_str().to_string());
            args.push(a.username.clone());
            format!("(g.source = ?{s} AND (g.white = ?{u} OR g.black = ?{u}))")
        })
        .collect();
    (parts.join(" OR "), args)
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
                    "INSERT INTO games (id, source, created_at, white, black, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                )
                .map_err(sql_err)?;
            let mut exists = tx.prepare("SELECT 1 FROM games WHERE id = ?1").map_err(sql_err)?;
            for g in games {
                let known = exists.exists([&g.id]).map_err(sql_err)?;
                let json = serde_json::to_string(g).map_err(|e| e.to_string())?;
                stmt.execute(params![g.id, g.source.as_str(), g.created_at, g.white.name, g.black.name, json])
                    .map_err(sql_err)?;
                if !known {
                    inserted += 1;
                }
            }
        }
        tx.commit().map_err(sql_err)?;
        Ok(inserted)
    }

    /// Games of the given accounts, newest first.
    pub fn games_of(&self, accounts: &[Account], limit: u32) -> Result<Vec<StoredGame>, String> {
        let (filter, mut args) = account_filter(accounts, 2);
        args.insert(0, REVIEW_VERSION.to_string());
        let sql = format!(
            "SELECT g.data, EXISTS(SELECT 1 FROM reviews r WHERE r.game_id = g.id AND r.version = ?1)
             FROM games g WHERE {filter}
             ORDER BY g.created_at DESC LIMIT {limit}"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(sql_err)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))
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

    /// All games of the accounts that have a current review (deepest one), newest first.
    pub fn reviewed_games_of(&self, accounts: &[Account]) -> Result<Vec<(GameInfo, GameReview)>, String> {
        let (filter, mut args) = account_filter(accounts, 2);
        args.insert(0, REVIEW_VERSION.to_string());
        let sql = format!(
            "SELECT g.data, r.data FROM games g
             JOIN reviews r ON r.game_id = g.id AND r.version = ?1
             WHERE ({filter})
               AND r.depth = (SELECT MAX(depth) FROM reviews WHERE game_id = g.id AND version = ?1)
             ORDER BY g.created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(sql_err)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (g, r) = row.map_err(sql_err)?;
            if let (Ok(g), Ok(r)) = (serde_json::from_str(&g), serde_json::from_str(&r)) {
                out.push((g, r));
            }
        }
        Ok(out)
    }

    /// Games of the accounts without a current review, newest first.
    pub fn unreviewed_games_of(&self, accounts: &[Account], limit: u32) -> Result<Vec<GameInfo>, String> {
        Ok(self
            .games_of(accounts, u32::MAX)?
            .into_iter()
            .filter(|g| !g.analysed)
            .take(limit as usize)
            .map(|g| g.game)
            .collect())
    }

    pub fn count_games_of(&self, accounts: &[Account]) -> Result<usize, String> {
        let (filter, args) = account_filter(accounts, 1);
        self.conn
            .query_row(&format!("SELECT COUNT(*) FROM games g WHERE {filter}"), params_from_iter(args.iter()), |r| {
                r.get::<_, i64>(0)
            })
            .map(|n| n as usize)
            .map_err(sql_err)
    }

    /// (newest, oldest) `created_at` of an account's stored games.
    pub fn time_range(&self, account: &Account) -> Result<Option<(i64, i64)>, String> {
        let (filter, args) = account_filter(std::slice::from_ref(account), 1);
        self.conn
            .query_row(
                &format!("SELECT MAX(created_at), MIN(created_at) FROM games g WHERE {filter}"),
                params_from_iter(args.iter()),
                |r| Ok(r.get::<_, Option<i64>>(0)?.zip(r.get::<_, Option<i64>>(1)?)),
            )
            .map_err(sql_err)
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .map_err(sql_err)
    }

    /// `None` removes the setting.
    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        match value {
            Some(v) => self.conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, v],
            ),
            None => self.conn.execute("DELETE FROM settings WHERE key = ?1", [key]),
        }
        .map_err(sql_err)?;
        Ok(())
    }

    pub fn log_attempt(&self, a: &Attempt) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO puzzle_log (puzzle_id, kind, theme, solved, rating, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![a.puzzle_id, a.kind, a.theme, a.solved, a.rating, a.at],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Ids of all puzzles of a kind that were ever attempted.
    pub fn attempted_ids(&self, kind: &str) -> Result<std::collections::HashSet<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT puzzle_id FROM puzzle_log WHERE kind = ?1")
            .map_err(sql_err)?;
        let rows = stmt.query_map([kind], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        rows.collect::<Result<_, _>>().map_err(sql_err)
    }

    /// Own-mistake puzzles solved after `since` (ms): those rest for a while.
    pub fn solved_since(&self, kind: &str, since: i64) -> Result<std::collections::HashSet<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT puzzle_id FROM puzzle_log WHERE kind = ?1 AND solved = 1 AND at >= ?2")
            .map_err(sql_err)?;
        let rows = stmt.query_map(params![kind, since], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        rows.collect::<Result<_, _>>().map_err(sql_err)
    }

    /// (theme, attempts, solved) over the last `n` attempts of each theme.
    pub fn theme_mastery(&self, n: usize) -> Result<Vec<(String, u32, u32)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT theme, COUNT(*), SUM(solved) FROM (
                    SELECT theme, solved, ROW_NUMBER() OVER (PARTITION BY theme ORDER BY at DESC) AS rn
                    FROM puzzle_log WHERE theme IS NOT NULL
                 ) WHERE rn <= ?1 GROUP BY theme",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([n as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?, r.get::<_, u32>(2)?)))
            .map_err(sql_err)?;
        rows.collect::<Result<_, _>>().map_err(sql_err)
    }

    /// (attempts, solved) overall and since `since` (ms).
    pub fn attempt_counts(&self, since: i64) -> Result<(u32, u32, u32, u32), String> {
        self.conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(solved), 0),
                        COALESCE(SUM(at >= ?1), 0), COALESCE(SUM(solved AND at >= ?1), 0)
                 FROM puzzle_log",
                [since],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(sql_err)
    }

    /// Number of stored games and reviews (for the settings dialog).
    pub fn counts(&self) -> Result<(u64, u64), String> {
        self.conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM games), (SELECT COUNT(DISTINCT game_id) FROM reviews WHERE version = ?1)",
                [REVIEW_VERSION],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)),
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
            source: Default::default(),
            url: None,
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

        let alice = Account::new(Source::Lichess, "ALICE");
        let games = db.games_of(std::slice::from_ref(&alice), 10).unwrap();
        let ids: Vec<_> = games.iter().map(|g| g.game.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(db.time_range(&alice).unwrap(), Some((3, 1)));
        assert_eq!(db.time_range(&Account::new(Source::Lichess, "nobody")).unwrap(), None);
        // Same name on another platform is a different account.
        assert_eq!(db.time_range(&Account::new(Source::Chesscom, "alice")).unwrap(), None);
        assert_eq!(db.count_games_of(&[]).unwrap(), 0);
    }

    #[test]
    fn combines_accounts_across_platforms() {
        let mut db = Db::in_memory();
        let mut cc = game("cc1", "me_cc", "x", 5);
        cc.source = Source::Chesscom;
        db.save_games(&[game("l1", "me_li", "y", 4), cc, game("l2", "other", "z", 6)]).unwrap();
        let both = [Account::new(Source::Lichess, "me_li"), Account::new(Source::Chesscom, "me_cc")];
        let ids: Vec<_> = db.games_of(&both, 10).unwrap().into_iter().map(|g| g.game.id).collect();
        assert_eq!(ids, ["cc1", "l1"]);
        assert_eq!(db.count_games_of(&both).unwrap(), 2);
    }

    #[test]
    fn puzzle_log_and_mastery() {
        let db = Db::in_memory();
        let attempt = |id: &str, theme: Option<&str>, solved, at| Attempt {
            puzzle_id: id.into(),
            kind: "lichess".into(),
            theme: theme.map(Into::into),
            solved,
            rating: Some(1500),
            at,
        };
        db.log_attempt(&attempt("a", Some("allowedFork"), true, 1)).unwrap();
        db.log_attempt(&attempt("b", Some("allowedFork"), false, 2)).unwrap();
        db.log_attempt(&attempt("c", Some("allowedFork"), true, 3)).unwrap();
        db.log_attempt(&attempt("d", None, true, 4)).unwrap();
        assert_eq!(db.attempted_ids("lichess").unwrap().len(), 4);
        assert!(db.attempted_ids("own").unwrap().is_empty());
        // Only the 2 most recent fork attempts: c (solved), b (failed).
        assert_eq!(db.theme_mastery(2).unwrap(), vec![("allowedFork".to_string(), 2, 1)]);
        assert_eq!(db.attempt_counts(3).unwrap(), (4, 3, 2, 2));
        assert_eq!(db.solved_since("lichess", 3).unwrap().len(), 2);
    }

    #[test]
    fn settings_roundtrip() {
        let db = Db::in_memory();
        assert_eq!(db.setting("threads").unwrap(), None);
        db.set_setting("threads", Some("4")).unwrap();
        db.set_setting("threads", Some("6")).unwrap();
        assert_eq!(db.setting("threads").unwrap().as_deref(), Some("6"));
        db.set_setting("threads", None).unwrap();
        assert_eq!(db.setting("threads").unwrap(), None);
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
        assert!(db.games_of(&[Account::new(Source::Lichess, "alice")], 10).unwrap()[0].analysed);
    }
}
