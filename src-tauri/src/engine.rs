//! Minimal UCI client for a local Stockfish binary.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde::{Deserialize, Serialize};

/// Engine score from the point of view of the side to move.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum Score {
    /// Centipawns.
    Cp(i32),
    /// Mate in N moves; positive = side to move mates, negative = gets mated.
    Mate(i32),
    /// Game over: the side to move is checkmated.
    Mated,
    /// Game over: the side to move's opponent is checkmated (negation of `Mated`).
    Won,
}

impl Score {
    pub fn negate(self) -> Score {
        match self {
            Score::Cp(cp) => Score::Cp(-cp),
            Score::Mate(n) => Score::Mate(-n),
            Score::Mated => Score::Won,
            Score::Won => Score::Mated,
        }
    }

    /// Winning chances (0..=100) for the side whose perspective this score is in.
    /// Same logistic curve Lichess uses for its accuracy metric.
    pub fn win_percent(self) -> f64 {
        match self {
            Score::Cp(cp) => {
                let cp = cp.clamp(-1000, 1000) as f64;
                50.0 + 50.0 * (2.0 / (1.0 + (-0.003_682_08 * cp).exp()) - 1.0)
            }
            Score::Mate(n) if n > 0 => 100.0,
            Score::Won => 100.0,
            Score::Mate(_) | Score::Mated => 0.0,
        }
    }

    /// Mate distance if this score is a forced mate *for* the perspective side.
    pub fn mate_for(self) -> Option<i32> {
        match self {
            Score::Mate(n) if n > 0 => Some(n),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PvLine {
    pub score: Score,
    /// Search depth this line was reported at (0 for terminal positions).
    #[serde(default)]
    pub depth: u32,
    /// Principal variation in UCI notation.
    pub pv: Vec<String>,
}

pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// User overrides from the settings dialog.
#[derive(Debug, Clone, Default)]
pub struct EngineConfig {
    pub path: Option<PathBuf>,
    /// Threads for the main analysis; background work uses half.
    pub threads: Option<usize>,
}

static CONFIG: std::sync::RwLock<EngineConfig> = std::sync::RwLock::new(EngineConfig { path: None, threads: None });

pub fn configure(config: EngineConfig) {
    *CONFIG.write().unwrap() = config;
}

pub fn config() -> EngineConfig {
    CONFIG.read().unwrap().clone()
}

pub fn cpu_count() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// Engine threads: all but one core for the analysis you're looking at,
/// half of that for background work (live engine, batch, own moves).
pub fn threads(background: bool) -> usize {
    let main = config().threads.unwrap_or_else(|| cpu_count().saturating_sub(1)).max(1);
    if background { (main / 2).max(1) } else { main }
}

/// Stockfish found without user override (env var, PATH, common dirs).
pub fn detect_stockfish() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("POSTMORTEM_STOCKFISH") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = if cfg!(windows) { "stockfish.exe" } else { "stockfish" };
    // Bundled with the app (Windows installer, Flatpak): next to our executable.
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let bundled = dir.join(exe);
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // Debian/Ubuntu install to /usr/games, which GUI sessions often lack in PATH.
    [
        "/usr/games/stockfish",
        "/usr/bin/stockfish",
        "/usr/local/bin/stockfish",
        "/opt/homebrew/bin/stockfish",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

/// The Stockfish binary to use: the path from the settings, else auto-detected.
pub fn find_stockfish() -> Option<PathBuf> {
    config().path.filter(|p| p.is_file()).or_else(detect_stockfish)
}

/// Check that a file really is a UCI engine (handshake only).
pub fn verify(path: &Path) -> Result<(), String> {
    Engine::start(path, 1, 16, 1).map(drop)
}

/// Start a Stockfish process with piped stdio and low CPU priority, so long
/// analyses never make the rest of the system sluggish. When the machine is
/// otherwise idle, low priority costs no speed.
pub fn spawn_stockfish(path: &Path) -> Result<Child, String> {
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Stockfish konnte nicht gestartet werden ({}): {e}", path.display()))?;
    #[cfg(unix)]
    // SAFETY: plain syscall on the child's pid; failure only means normal priority.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, child.id() as libc::id_t, 10);
    }
    Ok(child)
}

impl Engine {
    pub fn start(path: &Path, threads: usize, hash_mb: usize, multipv: usize) -> Result<Engine, String> {
        let mut child = spawn_stockfish(path)?;
        let stdin = child.stdin.take().ok_or("kein stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("kein stdout")?);
        let mut engine = Engine { child, stdin, stdout };

        engine.send("uci")?;
        engine.wait_for("uciok")?;
        engine.send(&format!("setoption name Threads value {threads}"))?;
        engine.send(&format!("setoption name Hash value {hash_mb}"))?;
        engine.send(&format!("setoption name MultiPV value {multipv}"))?;
        engine.send("ucinewgame")?;
        engine.send("isready")?;
        engine.wait_for("readyok")?;
        Ok(engine)
    }

    fn send(&mut self, cmd: &str) -> Result<(), String> {
        writeln!(self.stdin, "{cmd}").map_err(|e| format!("Stockfish-Pipe: {e}"))?;
        self.stdin.flush().map_err(|e| format!("Stockfish-Pipe: {e}"))
    }

    fn read_line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        let n = self
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("Stockfish-Pipe: {e}"))?;
        if n == 0 {
            return Err("Stockfish wurde unerwartet beendet".into());
        }
        Ok(line.trim_end().to_string())
    }

    fn wait_for(&mut self, token: &str) -> Result<(), String> {
        loop {
            if self.read_line()? == token {
                return Ok(());
            }
        }
    }

    /// Change the number of lines reported per search.
    pub fn set_multipv(&mut self, n: usize) -> Result<(), String> {
        self.send(&format!("setoption name MultiPV value {n}"))?;
        self.send("isready")?;
        self.wait_for("readyok")
    }

    pub fn set_option(&mut self, name: &str, value: &str) -> Result<(), String> {
        self.send(&format!("setoption name {name} value {value}"))
    }

    /// Wait until the engine has processed everything sent so far.
    pub fn sync(&mut self) -> Result<(), String> {
        self.send("isready")?;
        self.wait_for("readyok")
    }

    /// Let the engine pick a move: `go` is the search limit, e.g. "depth 5" or "movetime 500".
    pub fn best_move(&mut self, fen: &str, go: &str) -> Result<Option<String>, String> {
        self.send(&format!("position fen {fen}"))?;
        self.send(&format!("go {go}"))?;
        loop {
            let line = self.read_line()?;
            if let Some(rest) = line.strip_prefix("bestmove") {
                let mv = rest.split_whitespace().next().unwrap_or("(none)");
                return Ok((mv != "(none)").then(|| mv.to_string()));
            }
        }
    }

    /// Analyse a position to a fixed depth. Returns lines ordered by MultiPV rank.
    pub fn analyse(&mut self, fen: &str, depth: u32) -> Result<Vec<PvLine>, String> {
        self.send(&format!("position fen {fen}"))?;
        self.send(&format!("go depth {depth}"))?;
        let mut lines: Vec<Option<PvLine>> = Vec::new();
        loop {
            let line = self.read_line()?;
            if line.starts_with("bestmove") {
                break;
            }
            if let Some((rank, pv)) = parse_info(&line) {
                if lines.len() < rank {
                    lines.resize(rank, None);
                }
                lines[rank - 1] = Some(pv);
            }
        }
        Ok(lines.into_iter().flatten().collect())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.send("quit");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Parse an `info ... score ... pv ...` line into (multipv rank, line).
pub(crate) fn parse_info(line: &str) -> Option<(usize, PvLine)> {
    let mut tokens = line.split_whitespace();
    if tokens.next()? != "info" {
        return None;
    }
    let mut rank = 1;
    let mut depth = 0;
    let mut score = None;
    let mut pv = Vec::new();
    while let Some(tok) = tokens.next() {
        match tok {
            "multipv" => rank = tokens.next()?.parse().ok()?,
            "depth" => depth = tokens.next()?.parse().ok()?,
            "score" => {
                let kind = tokens.next()?;
                let value: i32 = tokens.next()?.parse().ok()?;
                score = Some(match kind {
                    "cp" => Score::Cp(value),
                    "mate" if value == 0 => Score::Mated,
                    "mate" => Score::Mate(value),
                    _ => return None,
                });
            }
            // Partial results from an aspiration window are not trustworthy.
            "lowerbound" | "upperbound" => return None,
            "pv" => {
                pv = tokens.by_ref().map(str::to_string).collect();
                break;
            }
            _ => {}
        }
    }
    if pv.is_empty() || rank == 0 {
        return None;
    }
    Some((rank, PvLine { score: score?, depth, pv }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_info_line() {
        let (rank, line) = parse_info(
            "info depth 18 seldepth 25 multipv 2 score cp -34 nodes 1 nps 1 pv e7e5 g1f3 b8c6",
        )
        .unwrap();
        assert_eq!(rank, 2);
        assert_eq!(line.score, Score::Cp(-34));
        assert_eq!(line.depth, 18);
        assert_eq!(line.pv, vec!["e7e5", "g1f3", "b8c6"]);
    }

    #[test]
    fn ignores_bound_lines() {
        assert!(parse_info("info depth 10 score cp 20 lowerbound pv e2e4").is_none());
    }

    #[test]
    fn win_percent_is_symmetric() {
        assert!((Score::Cp(0).win_percent() - 50.0).abs() < 1e-9);
        let a = Score::Cp(150).win_percent();
        let b = Score::Cp(-150).win_percent();
        assert!((a + b - 100.0).abs() < 1e-9);
        assert_eq!(Score::Mate(3).win_percent(), 100.0);
        assert_eq!(Score::Mate(-2).win_percent(), 0.0);
        assert_eq!(Score::Mated.win_percent(), 0.0);
        assert_eq!(Score::Mated.negate().win_percent(), 100.0);
    }
}
