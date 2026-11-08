//! Live analysis of whatever position is on the board.
//!
//! One long-running Stockfish process. A reader thread streams `info` lines to
//! the frontend as `live-info` events. A new request stops the running search
//! and waits for its `bestmove` before starting the next one, so results are
//! never attributed to the wrong position.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use shakmaty::{Chess, Color, Position};
use tauri::{AppHandle, Emitter};

use crate::analysis;
use crate::coach;
use crate::engine::{self, PvLine, Score};

const MAX_DEPTH: u32 = 24;
const MULTIPV: usize = 3;
const EMIT_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LiveLine {
    /// From White's point of view.
    pub score: Score,
    pub win_white: f64,
    pub uci: String,
    pub san: String,
    /// Numbered SAN of the whole variation.
    pub line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LiveInfo {
    pub id: u64,
    pub fen: String,
    pub depth: u32,
    pub done: bool,
    pub lines: Vec<LiveLine>,
}

struct Request {
    id: u64,
    fen: String,
    pos: Chess,
    multipv: usize,
}

#[derive(Default)]
struct SearchState {
    /// Number of `go` commands sent / `bestmove` replies seen.
    started: u64,
    finished: u64,
    current: Option<Arc<Request>>,
}

struct Shared {
    state: Mutex<SearchState>,
    cv: Condvar,
}

struct Process {
    child: Child,
    stdin: ChildStdin,
    shared: Arc<Shared>,
}

#[derive(Default)]
pub struct Live {
    process: Mutex<Option<Process>>,
}

fn send(stdin: &mut ChildStdin, cmd: &str) -> Result<(), String> {
    writeln!(stdin, "{cmd}")
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Stockfish-Pipe: {e}"))
}

fn to_live_lines(pos: &Chess, lines: &[PvLine]) -> Vec<LiveLine> {
    lines
        .iter()
        .filter_map(|l| {
            let first = coach::parse_uci(pos, l.pv.first()?)?;
            let score = if pos.turn() == Color::White { l.score } else { l.score.negate() };
            Some(LiveLine {
                score,
                win_white: score.win_percent(),
                uci: l.pv[0].clone(),
                san: coach::san(pos, first),
                line: coach::san_line(pos, &l.pv, 12),
            })
        })
        .collect()
}

fn spawn(app: &AppHandle) -> Result<Process, String> {
    let path = engine::find_stockfish()
        .ok_or("Stockfish wurde nicht gefunden. Installiere es z. B. mit: sudo apt install stockfish")?;
    let mut child = engine::spawn_stockfish(&path)?;
    let mut stdin = child.stdin.take().ok_or("kein stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("kein stdout")?);

    // Leave some CPU for a batch analysis that may be running in parallel.
    let threads = engine::threads(true);
    send(&mut stdin, "uci")?;
    send(&mut stdin, &format!("setoption name Threads value {threads}"))?;
    send(&mut stdin, "setoption name Hash value 128")?;

    let shared = Arc::new(Shared { state: Mutex::new(SearchState::default()), cv: Condvar::new() });
    let reader_shared = shared.clone();
    let app = app.clone();
    std::thread::spawn(move || reader(stdout, reader_shared, app));
    Ok(Process { child, stdin, shared })
}

fn reader(stdout: BufReader<std::process::ChildStdout>, shared: Arc<Shared>, app: AppHandle) {
    let mut lines: Vec<Option<PvLine>> = Vec::new();
    let mut lines_for: u64 = 0;
    let mut latest: Option<LiveInfo> = None;
    let mut last_emit = Instant::now() - EMIT_INTERVAL;

    for line in stdout.lines() {
        let Ok(line) = line else { break };
        if line.starts_with("bestmove") {
            let mut st = shared.state.lock().unwrap();
            st.finished += 1;
            let was_current = st.finished == st.started;
            shared.cv.notify_all();
            drop(st);
            if was_current && let Some(mut info) = latest.take() {
                info.done = true;
                let _ = app.emit("live-info", info);
            }
            continue;
        }
        let Some((rank, pv)) = engine::parse_info(&line) else { continue };
        let req = {
            let st = shared.state.lock().unwrap();
            // Only lines of the search that is currently running belong to `current`.
            if st.finished + 1 != st.started {
                continue;
            }
            match &st.current {
                Some(r) => r.clone(),
                None => continue,
            }
        };
        if lines_for != req.id {
            lines.clear();
            lines_for = req.id;
            latest = None;
        }
        if lines.len() < rank {
            lines.resize(rank, None);
        }
        lines[rank - 1] = Some(pv);
        // A full set of MultiPV lines has arrived for this depth.
        if rank == req.multipv && lines.iter().all(Option::is_some) {
            let complete: Vec<PvLine> = lines.iter().flatten().cloned().collect();
            let depth = complete[0].depth;
            let info = LiveInfo {
                id: req.id,
                fen: req.fen.clone(),
                depth,
                done: false,
                lines: to_live_lines(&req.pos, &complete),
            };
            if last_emit.elapsed() >= EMIT_INTERVAL {
                let _ = app.emit("live-info", info.clone());
                last_emit = Instant::now();
            }
            latest = Some(info);
        }
    }
}

impl Process {
    /// Stop the running search (if any) and wait until Stockfish confirms it.
    fn stop_and_wait(&mut self) -> Result<(), String> {
        let shared = self.shared.clone();
        let mut st = shared.state.lock().unwrap();
        if st.started > st.finished {
            send(&mut self.stdin, "stop")?;
            let (guard, _) = shared
                .cv
                .wait_timeout_while(st, Duration::from_secs(3), |s| s.started > s.finished)
                .unwrap();
            st = guard;
        }
        st.current = None;
        Ok(())
    }
}

impl Live {
    pub fn analyse(&self, app: &AppHandle, id: u64, fen: &str) -> Result<(), String> {
        let pos = analysis::parse_fen(fen)?;

        let mut guard = self.process.lock().unwrap();
        if guard.is_none() {
            *guard = Some(spawn(app)?);
        }
        let proc = guard.as_mut().unwrap();
        proc.stop_and_wait()?;

        // Finished games need no engine.
        if let Some(lines) = analysis::terminal_eval(&pos) {
            let score = if pos.turn() == Color::White { lines[0].score } else { lines[0].score.negate() };
            let _ = app.emit(
                "live-info",
                LiveInfo {
                    id,
                    fen: fen.to_string(),
                    depth: 0,
                    done: true,
                    lines: vec![LiveLine {
                        score,
                        win_white: score.win_percent(),
                        uci: String::new(),
                        san: String::new(),
                        line: String::new(),
                    }],
                },
            );
            return Ok(());
        }

        let multipv = pos.legal_moves().len().min(MULTIPV);
        let req = Arc::new(Request { id, fen: fen.to_string(), pos, multipv });
        {
            let mut st = proc.shared.state.lock().unwrap();
            st.current = Some(req);
            st.started += 1;
        }
        send(&mut proc.stdin, &format!("setoption name MultiPV value {multipv}"))?;
        send(&mut proc.stdin, &format!("position fen {fen}"))?;
        send(&mut proc.stdin, &format!("go depth {MAX_DEPTH}"))
    }

    /// Drop the engine process; the next request starts a fresh one (e.g. after settings changed).
    pub fn reset(&self) {
        *self.process.lock().unwrap() = None;
    }

    pub fn stop(&self) -> Result<(), String> {
        match self.process.lock().unwrap().as_mut() {
            Some(p) => p.stop_and_wait(),
            None => Ok(()),
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = send(&mut self.stdin, "quit");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
