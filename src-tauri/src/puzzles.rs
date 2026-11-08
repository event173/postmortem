//! Local copy of the Lichess puzzle database (https://database.lichess.org/#puzzles, CC0).
//!
//! Download (~300 MB, zstd-compressed CSV) -> stream-decompress -> import into
//! `puzzles.db`. The new database is built next to the old one and only swapped
//! in when complete, so an interrupted update never breaks the existing copy.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::lichess::{check_status, client, network_error, FetchError};

pub const URL: &str = "https://database.lichess.org/lichess_db_puzzle.csv.zst";
const DB_FILE: &str = "puzzles.db";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleStatus {
    pub installed: bool,
    pub count: u64,
    /// `Last-Modified` of the imported file, as sent by Lichess.
    pub version: Option<String>,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub offline: bool,
    pub remote_version: Option<String>,
    pub remote_size: Option<u64>,
    /// True if nothing is installed yet or Lichess has a newer file.
    pub available: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// "download", "import", "index", "done", "error", "cancelled"
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub message: Option<String>,
}

pub fn db_path(dir: &Path) -> PathBuf {
    dir.join(DB_FILE)
}

fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

pub fn status(dir: &Path) -> PuzzleStatus {
    let path = db_path(dir);
    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let Ok(conn) = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return PuzzleStatus { installed: false, count: 0, version: None, size_bytes: 0 };
    };
    let count = meta(&conn, "count").and_then(|c| c.parse().ok()).unwrap_or(0);
    PuzzleStatus { installed: count > 0, count, version: meta(&conn, "last_modified"), size_bytes }
}

pub async fn check_update(dir: &Path) -> UpdateCheck {
    let local = status(dir);
    let resp = match client() {
        Ok(c) => c.head(URL).send().await,
        Err(_) => return UpdateCheck { offline: true, remote_version: None, remote_size: None, available: false },
    };
    let resp = match resp {
        Ok(r) if r.status().is_success() => r,
        _ => return UpdateCheck { offline: true, remote_version: None, remote_size: None, available: false },
    };
    let header = |name| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let remote_version = header("last-modified");
    let remote_size = header("content-length").and_then(|s| s.parse().ok());
    let available = !local.installed || (remote_version.is_some() && remote_version != local.version);
    UpdateCheck { offline: false, remote_version, remote_size, available }
}

fn emit(app: &AppHandle, phase: &str, done: u64, total: u64, message: Option<String>) {
    let _ = app.emit("puzzle-progress", Progress { phase: phase.into(), done, total, message });
}

/// Download the current file into `dir` and return (path, Last-Modified).
async fn download(app: &AppHandle, dir: &Path, cancel: &AtomicBool) -> Result<(PathBuf, Option<String>), String> {
    let part = dir.join("lichess_db_puzzle.csv.zst.part");
    let mut resp = client()?
        .get(URL)
        .send()
        .await
        .map_err(|e| match network_error(e) {
            FetchError::Offline => "Keine Internetverbindung.".to_string(),
            FetchError::Other(e) => e,
        })?;
    check_status(&resp, "Puzzle-Datenbank")?;
    let total = resp.content_length().unwrap_or(0);
    let version = resp.headers().get("last-modified").and_then(|v| v.to_str().ok()).map(str::to_string);

    let mut file = std::io::BufWriter::new(File::create(&part).map_err(|e| e.to_string())?);
    let mut done = 0u64;
    let mut last_emit = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download abgebrochen: {e}"))? {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err("cancelled".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done - last_emit > 2_000_000 {
            emit(app, "download", done, total, None);
            last_emit = done;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if total > 0 && done != total {
        let _ = std::fs::remove_file(&part);
        return Err("Download unvollständig – bitte nochmal versuchen.".into());
    }
    let finished = dir.join("lichess_db_puzzle.csv.zst");
    std::fs::rename(&part, &finished).map_err(|e| e.to_string())?;
    Ok((finished, version))
}

/// Counts compressed bytes read, for import progress.
struct Counting<R> {
    inner: R,
    read: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/// One CSV row: PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
/// (no field contains a comma, so a plain split is exact).
struct Row<'a> {
    id: &'a str,
    fen: &'a str,
    moves: &'a str,
    rating: i64,
    popularity: i64,
    plays: i64,
    themes: &'a str,
    game_url: &'a str,
}

fn parse_row(line: &str) -> Option<Row<'_>> {
    let f: Vec<&str> = line.split(',').collect();
    if f.len() < 9 {
        return None;
    }
    Some(Row {
        id: f[0],
        fen: f[1],
        moves: f[2],
        rating: f[3].parse().ok()?,
        popularity: f[5].parse().ok()?,
        plays: f[6].parse().ok()?,
        themes: f[7],
        game_url: f[8],
    })
}

/// Build a fresh database from the compressed CSV. Returns the number of puzzles.
fn import(
    progress: &dyn Fn(&str, u64, u64),
    zst: &Path,
    target: &Path,
    version: Option<&str>,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    let total = std::fs::metadata(zst).map(|m| m.len()).unwrap_or(0);
    let read = Arc::new(AtomicU64::new(0));
    let counting = Counting { inner: BufReader::new(File::open(zst).map_err(|e| e.to_string())?), read: read.clone() };
    let decoder = zstd::Decoder::new(counting).map_err(|e| e.to_string())?;
    let reader = BufReader::with_capacity(1 << 20, decoder);

    let _ = std::fs::remove_file(target);
    let mut conn = Connection::open(target).map_err(|e| e.to_string())?;
    // A throwaway file while building: durability doesn't matter, speed does.
    conn.execute_batch(
        "PRAGMA journal_mode = OFF;
         PRAGMA synchronous = OFF;
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE puzzles (
            id         TEXT PRIMARY KEY,
            fen        TEXT NOT NULL,
            moves      TEXT NOT NULL,
            rating     INTEGER NOT NULL,
            popularity INTEGER NOT NULL,
            plays      INTEGER NOT NULL,
            themes     TEXT NOT NULL,
            game_url   TEXT NOT NULL
         ) WITHOUT ROWID;",
    )
    .map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut count = 0u64;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO puzzles (id, fen, moves, rating, popularity, plays, themes, game_url)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| e.to_string())?;
        for (i, line) in reader.lines().enumerate() {
            let line = line.map_err(|e| format!("Datei beschädigt: {e}"))?;
            if i == 0 && line.starts_with("PuzzleId") {
                continue;
            }
            let Some(r) = parse_row(&line) else { continue };
            stmt.execute(params![r.id, r.fen, r.moves, r.rating, r.popularity, r.plays, r.themes, r.game_url])
                .map_err(|e| e.to_string())?;
            count += 1;
            if count.is_multiple_of(50_000) {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                progress("import", read.load(Ordering::Relaxed), total);
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    progress("index", total, total);
    conn.execute_batch("CREATE INDEX puzzles_rating ON puzzles(rating);")
        .map_err(|e| e.to_string())?;
    let mut set = conn.prepare("INSERT INTO meta (key, value) VALUES (?1, ?2)").map_err(|e| e.to_string())?;
    set.execute(params!["count", count.to_string()]).map_err(|e| e.to_string())?;
    if let Some(v) = version {
        set.execute(params!["last_modified", v]).map_err(|e| e.to_string())?;
    }
    set.execute(params!["source", URL]).map_err(|e| e.to_string())?;
    drop(set);
    conn.close().map_err(|(_, e)| e.to_string())?;
    Ok(count)
}

/// Download and import, replacing the existing database only on success.
pub async fn install(app: AppHandle, dir: PathBuf, cancel: Arc<AtomicBool>) -> Result<PuzzleStatus, String> {
    let result = async {
        let (zst, version) = download(&app, &dir, &cancel).await?;
        let app2 = app.clone();
        let dir2 = dir.clone();
        let cancel2 = cancel.clone();
        let count = tauri::async_runtime::spawn_blocking(move || {
            let tmp = dir2.join("puzzles.db.new");
            let progress = |phase: &str, done, total| emit(&app2, phase, done, total, None);
            let res = import(&progress, &zst, &tmp, version.as_deref(), &cancel2);
            let _ = std::fs::remove_file(&zst);
            match res {
                Ok(count) => {
                    std::fs::rename(&tmp, db_path(&dir2)).map_err(|e| e.to_string())?;
                    Ok(count)
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    Err(e)
                }
            }
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok::<u64, String>(count)
    }
    .await;

    match result {
        Ok(count) => {
            emit(&app, "done", count, count, None);
            Ok(status(&dir))
        }
        Err(e) if e == "cancelled" => {
            emit(&app, "cancelled", 0, 0, None);
            Err(e)
        }
        Err(e) => {
            emit(&app, "error", 0, 0, Some(e.clone()));
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_csv_row() {
        let line = "00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,\
                    1913,75,95,8722,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#47,";
        let r = parse_row(line).unwrap();
        assert_eq!(r.id, "00008");
        assert_eq!(r.rating, 1913);
        assert_eq!(r.popularity, 95);
        assert_eq!(r.plays, 8722);
        assert!(r.themes.contains("hangingPiece"));
        assert!(r.game_url.ends_with("#47"));
        assert!(parse_row("PuzzleId,FEN,Moves,Rating").is_none());
    }

    #[test]
    fn imports_compressed_csv() {
        let dir = std::env::temp_dir().join(format!("postmortem-puzzle-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let csv = "PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags\n\
            00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1913,75,95,8722,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#47,\n\
            0000D,5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27,d3d6 f8d8 d6d8 f6d8,1580,73,97,26773,advantage endgame short,https://lichess.org/F8M8OS71#53,\n\
            broken line\n";
        let zst = dir.join("p.csv.zst");
        std::fs::write(&zst, zstd::encode_all(csv.as_bytes(), 3).unwrap()).unwrap();
        let target = db_path(&dir);
        let phases = std::cell::RefCell::new(Vec::new());
        let progress = |phase: &str, _: u64, _: u64| phases.borrow_mut().push(phase.to_string());
        let count = import(&progress, &zst, &target, Some("Sun, 01 Nov 2026 07:57:40 GMT"), &AtomicBool::new(false)).unwrap();
        assert_eq!(count, 2);
        assert!(phases.borrow().contains(&"index".to_string()));

        let st = status(&dir);
        assert!(st.installed);
        assert_eq!(st.count, 2);
        assert_eq!(st.version.as_deref(), Some("Sun, 01 Nov 2026 07:57:40 GMT"));
        let conn = Connection::open(&target).unwrap();
        let rating: i64 = conn.query_row("SELECT rating FROM puzzles WHERE id = '0000D'", [], |r| r.get(0)).unwrap();
        assert_eq!(rating, 1580);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_database_is_not_installed() {
        let st = status(Path::new("/nonexistent/postmortem"));
        assert!(!st.installed);
    }

    /// Run with: cargo test puzzles::tests::update_check_live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn update_check_live() {
        let check = tauri::async_runtime::block_on(check_update(Path::new("/nonexistent/postmortem")));
        println!("{:?} {:?} {}", check.remote_version, check.remote_size, check.available);
        assert!(!check.offline);
        assert!(check.available, "nothing installed -> download offered");
        assert!(check.remote_size.unwrap_or(0) > 100_000_000);
    }
}
