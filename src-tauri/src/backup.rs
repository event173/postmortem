//! Backup and restore of the whole local database – games, analyses, flashcard
//! progress, puzzle history and settings – as one SQLite file.
//!
//! The personal Lichess token is never written into a backup, and restoring
//! keeps the token of this computer. The puzzle database is a separate file and
//! not part of it (it can be downloaded again).

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::db::Db;

/// Settings that stay on this computer.
const SECRETS: &[&str] = &["lichess_token", "lichess_token_user"];
/// The current database is copied here before a restore (one level of undo).
pub const BEFORE_RESTORE: &str = "postmortem-vor-wiederherstellung.db";

fn err(e: impl std::fmt::Display) -> String {
    tr!("Sicherung fehlgeschlagen: {e}", "Backup failed: {e}")
}

/// Write a backup to `target` (replacing it). Returns its size in bytes.
pub fn create(db: &Db, target: &Path) -> Result<u64, String> {
    let tmp = with_suffix(target, ".tmp");
    let _ = std::fs::remove_file(&tmp);
    db.copy_to(&tmp)?;
    let conn = Connection::open(&tmp).map_err(err)?;
    for key in SECRETS {
        conn.execute("DELETE FROM settings WHERE key = ?1", [key]).map_err(err)?;
    }
    drop(conn);
    std::fs::rename(&tmp, target).or_else(|_| std::fs::copy(&tmp, target).map(|_| ())).map_err(err)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(std::fs::metadata(target).map(|m| m.len()).unwrap_or(0))
}

/// Is this a postmortem backup this version can read? Returns its game count.
pub fn check(source: &Path) -> Result<u64, String> {
    let not_ours = || tr!("Das ist keine postmortem-Sicherung.", "This is not a postmortem backup.");
    let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| not_ours())?;
    let tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('games', 'reviews', 'settings')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| not_ours())?;
    if tables != 3 {
        return Err(not_ours());
    }
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).map_err(|_| not_ours())?;
    if version as usize > Db::schema_version() {
        return Err(tr!(
            "Diese Sicherung stammt von einer neueren postmortem-Version. Bitte zuerst postmortem aktualisieren.",
            "This backup comes from a newer postmortem version. Please update postmortem first."
        ));
    }
    let ok: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|_| not_ours())?;
    if ok != "ok" {
        return Err(tr!("Die Sicherung ist beschädigt.", "The backup is damaged."));
    }
    conn.query_row("SELECT count(*) FROM games", [], |r| r.get::<_, i64>(0)).map(|n| n as u64).map_err(|_| not_ours())
}

/// Replace the database in `data_dir` with the backup at `source`. The current
/// one is kept as `BEFORE_RESTORE`; the Lichess token of this computer stays.
pub fn restore(db: &mut Db, data_dir: &Path, source: &Path) -> Result<(), String> {
    check(source)?;
    let main = data_dir.join("postmortem.db");
    let before = data_dir.join(BEFORE_RESTORE);
    let incoming = data_dir.join("postmortem-wiederherstellung.tmp");
    let _ = std::fs::remove_file(&before);
    let _ = std::fs::remove_file(&incoming);

    let secrets: Vec<(&str, Option<String>)> = SECRETS.iter().map(|k| (*k, db.setting(k).ok().flatten())).collect();
    db.copy_to(&before)?;
    // A clean single-file copy of the backup (even if it was taken while in use).
    Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.execute("VACUUM INTO ?1", [incoming.to_string_lossy()]))
        .map_err(err)
        .or_else(|_| std::fs::copy(source, &incoming).map(|_| 0).map_err(err))?;

    // Close the current database, swap the files, open the new one.
    *db = Db::placeholder();
    let swap = || -> std::io::Result<()> {
        for ext in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(with_suffix(&main, ext));
        }
        std::fs::rename(&incoming, &main)
    };
    if let Err(e) = swap() {
        // Put the old database back.
        let _ = std::fs::copy(&before, &main);
        *db = Db::open(&main)?;
        return Err(err(e));
    }
    *db = match Db::open(&main) {
        Ok(d) => d,
        Err(e) => {
            let _ = std::fs::copy(&before, &main);
            *db = Db::open(&main)?;
            return Err(err(e));
        }
    };
    for (key, value) in secrets {
        db.set_setting(key, value.as_deref())?;
    }
    Ok(())
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("postmortem-backup-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn backup_leaves_out_the_token_and_restore_keeps_ours() {
        let dir = tmpdir("roundtrip");
        let main = dir.join("postmortem.db");
        let mut db = Db::open(&main).unwrap();
        db.set_setting("threads", Some("3")).unwrap();
        db.set_setting("lichess_token", Some("lip_secret")).unwrap();

        let file = dir.join("sicherung.sqlite");
        assert!(create(&db, &file).unwrap() > 0);
        assert_eq!(check(&file).unwrap(), 0);
        let copy = Db::open(&file).unwrap();
        assert_eq!(copy.setting("threads").unwrap().as_deref(), Some("3"));
        assert_eq!(copy.setting("lichess_token").unwrap(), None, "the token must not be in a backup");
        drop(copy);

        // Change things, then restore: settings come back, our token stays.
        db.set_setting("threads", Some("8")).unwrap();
        db.set_setting("lichess_token", Some("lip_new")).unwrap();
        restore(&mut db, &dir, &file).unwrap();
        assert_eq!(db.setting("threads").unwrap().as_deref(), Some("3"));
        assert_eq!(db.setting("lichess_token").unwrap().as_deref(), Some("lip_new"));
        assert!(dir.join(BEFORE_RESTORE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_other_files() {
        let dir = tmpdir("reject");
        let junk = dir.join("junk.sqlite");
        std::fs::write(&junk, b"not a database at all").unwrap();
        assert!(check(&junk).is_err());
        let other = dir.join("other.sqlite");
        Connection::open(&other).unwrap().execute_batch("CREATE TABLE x (a);").unwrap();
        assert!(check(&other).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
