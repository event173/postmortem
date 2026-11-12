//! Reading texts aloud: with Piper (a natural voice, downloaded on request –
//! see piper.rs) or with the system's voices:
//!
//! - Linux: speech-dispatcher, spoken to directly over its socket (SSIP, a
//!   small text protocol). No library to link, so the app still starts where
//!   speech-dispatcher isn't installed – the system voice is just unavailable.
//! - Windows: the built-in voices (WinRT, via the `tts` crate).
//!
//! Speaking returns an id; when that text has been read to the end or was
//! stopped, the event `speech-end` carries the id (so the frontend can reset
//! its button – and ignore the end of a text it has already replaced).

use std::sync::Mutex;

use tauri::AppHandle;

#[derive(Default)]
pub struct Speech {
    /// The system voice, connected on first use (and again after the connection broke).
    system: Mutex<Option<imp::Backend>>,
    pub piper: crate::piper::Piper,
}

impl Speech {
    fn with<T>(&self, app: &AppHandle, f: impl FnOnce(&mut imp::Backend) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.system.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(imp::Backend::connect(app.clone())?);
        }
        let result = f(guard.as_mut().unwrap());
        if result.is_err() {
            // Maybe the connection broke (speech-dispatcher restarted): reconnect next time.
            *guard = None;
        }
        result
    }

    /// Is there a system voice?
    pub fn system_available(&self, app: &AppHandle) -> bool {
        self.with(app, |_| Ok(())).is_ok()
    }

    /// Read `text` aloud with the system voice (`lang`: "de" or "en"), stopping whatever is being read.
    pub fn speak_system(&self, app: &AppHandle, text: &str, lang: &str) -> Result<u64, String> {
        self.piper.stop();
        // One retry: a stale connection only shows when it's used.
        self.with(app, |b| b.speak(text, lang)).or_else(|_| self.with(app, |b| b.speak(text, lang)))
    }

    /// Stop the system voice (nothing to do if it was never used).
    pub fn stop_system(&self) {
        if let Ok(mut guard) = self.system.lock()
            && guard.as_mut().is_some_and(|b| b.stop().is_err())
        {
            *guard = None;
        }
    }

    /// Stop reading, whichever voice reads.
    pub fn stop(&self) {
        self.piper.stop();
        self.stop_system();
    }
}

#[derive(Clone, serde::Serialize)]
struct EndEvent {
    id: u64,
}

pub(crate) fn emit_end(app: &AppHandle, id: u64) {
    use tauri::Emitter;
    let _ = app.emit("speech-end", EndEvent { id });
}

// ---------------------------------------------------------------------------
// Linux: speech-dispatcher over SSIP

#[cfg(target_os = "linux")]
mod imp {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::time::Duration;

    use tauri::AppHandle;

    pub struct Backend {
        stream: UnixStream,
        /// Replies to our commands (code, lines); events go out as Tauri events.
        replies: Receiver<(u16, Vec<String>)>,
    }

    fn socket_path() -> Option<PathBuf> {
        if let Ok(addr) = std::env::var("SPEECHD_ADDRESS")
            && let Some(p) = addr.strip_prefix("unix_socket:") {
                return Some(PathBuf::from(p));
            }
        let dir = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))?;
        Some(dir.join("speech-dispatcher/speechd.sock"))
    }

    fn open() -> Result<UnixStream, String> {
        let path = socket_path().ok_or("no socket path for speech-dispatcher")?;
        if let Ok(s) = UnixStream::connect(&path) {
            return Ok(s);
        }
        // Not running (and not socket-activated): start it, like other clients do.
        let spawned = std::process::Command::new("speech-dispatcher")
            .arg("--spawn")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if spawned.is_err() {
            return Err("speech-dispatcher is not installed".into());
        }
        for _ in 0..20 {
            if let Ok(s) = UnixStream::connect(&path) {
                return Ok(s);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("could not connect to speech-dispatcher".into())
    }

    impl Backend {
        pub fn connect(app: AppHandle) -> Result<Backend, String> {
            let stream = open()?;
            let reader = stream.try_clone().map_err(|e| e.to_string())?;
            let (tx, replies) = mpsc::channel();
            std::thread::Builder::new()
                .name("speech-dispatcher".into())
                .spawn(move || read_loop(reader, tx, app))
                .map_err(|e| e.to_string())?;
            let mut b = Backend { stream, replies };
            b.command("SET self CLIENT_NAME user:postmortem:main")?;
            b.command("SET self NOTIFICATION end on")?;
            b.command("SET self NOTIFICATION cancel on")?;
            Ok(b)
        }

        /// Send one command line, wait for its reply; error on 3xx–5xx.
        fn command(&mut self, line: &str) -> Result<Vec<String>, String> {
            self.send(&format!("{line}\r\n"))
        }

        fn send(&mut self, data: &str) -> Result<Vec<String>, String> {
            self.stream.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            match self.replies.recv_timeout(Duration::from_secs(5)) {
                Ok((code, lines)) if code < 300 => Ok(lines),
                Ok((code, lines)) => Err(format!("speech-dispatcher: {code} {}", lines.join(" "))),
                Err(RecvTimeoutError::Timeout) => Err("speech-dispatcher doesn't answer".into()),
                Err(RecvTimeoutError::Disconnected) => Err("connection to speech-dispatcher lost".into()),
            }
        }

        pub fn speak(&mut self, text: &str, lang: &str) -> Result<u64, String> {
            self.command("CANCEL self")?;
            self.command(&format!("SET self LANGUAGE {lang}"))?;
            self.command("SPEAK")?;
            let lines = self.send(&ssip_body(text))?;
            // "225-<msg id>" then "225 OK MESSAGE QUEUED"
            lines.first().and_then(|l| l.trim().parse().ok()).ok_or_else(|| "no message id".into())
        }

        pub fn stop(&mut self) -> Result<(), String> {
            self.command("CANCEL self").map(|_| ())
        }
    }

    impl Drop for Backend {
        fn drop(&mut self) {
            let _ = self.stream.write_all(b"CANCEL self\r\nQUIT\r\n");
        }
    }

    /// The text of a SPEAK: CRLF lines, a leading dot doubled, ended by a lone dot.
    pub(super) fn ssip_body(text: &str) -> String {
        let mut body = String::new();
        for line in text.lines() {
            if line.starts_with('.') {
                body.push('.');
            }
            body.push_str(line);
            body.push_str("\r\n");
        }
        body.push_str(".\r\n");
        body
    }

    /// Replies are "CCC-line" … "CCC last line". 7xx are events (notifications):
    /// "702-<msg id>", "702-<client id>", "702 END"; 703 = stopped/cancelled.
    fn read_loop(stream: UnixStream, tx: mpsc::Sender<(u16, Vec<String>)>, app: AppHandle) {
        let mut lines = Vec::new();
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            let line = line.trim_end_matches('\r');
            if line.len() < 4 {
                continue;
            }
            let Ok(code) = line[..3].parse::<u16>() else { continue };
            lines.push(line[4..].to_string());
            if line.as_bytes()[3] == b'-' {
                continue;
            }
            let done = std::mem::take(&mut lines);
            if (700..800).contains(&code) {
                if (code == 702 || code == 703)
                    && let Some(id) = done.first().and_then(|l| l.trim().parse().ok()) {
                        super::emit_end(&app, id);
                    }
            } else if tx.send((code, done)).is_err() {
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Windows: WinRT voices

#[cfg(windows)]
mod imp {
    use tauri::AppHandle;
    use tts::{Tts, UtteranceId};

    pub struct Backend {
        tts: Tts,
    }

    fn id(u: UtteranceId) -> u64 {
        let UtteranceId::WinRt(n) = u;
        n
    }

    impl Backend {
        pub fn connect(app: AppHandle) -> Result<Backend, String> {
            let tts = Tts::default().map_err(|e| e.to_string())?;
            let end = app.clone();
            tts.on_utterance_end(Some(Box::new(move |u| super::emit_end(&end, id(u))))).map_err(|e| e.to_string())?;
            tts.on_utterance_stop(Some(Box::new(move |u| super::emit_end(&app, id(u))))).map_err(|e| e.to_string())?;
            Ok(Backend { tts })
        }

        pub fn speak(&mut self, text: &str, lang: &str) -> Result<u64, String> {
            // A voice for the language, if one is installed (else the default voice).
            if let Ok(voices) = self.tts.voices() {
                if let Some(v) = voices.iter().find(|v| v.language().primary_language() == lang) {
                    let _ = self.tts.set_voice(v);
                }
            }
            match self.tts.speak(text, true).map_err(|e| e.to_string())? {
                Some(u) => Ok(id(u)),
                None => Err("no utterance id".into()),
            }
        }

        pub fn stop(&mut self) -> Result<(), String> {
            self.tts.stop().map(|_| ()).map_err(|e| e.to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// elsewhere: not available

#[cfg(not(any(target_os = "linux", windows)))]
mod imp {
    use tauri::AppHandle;

    pub struct Backend;

    impl Backend {
        pub fn connect(_app: AppHandle) -> Result<Backend, String> {
            Err("reading aloud is not supported on this system".into())
        }
        pub fn speak(&mut self, _text: &str, _lang: &str) -> Result<u64, String> {
            unreachable!()
        }
        pub fn stop(&mut self) -> Result<(), String> {
            Ok(())
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::imp::ssip_body;

    #[test]
    fn ssip_body_escapes_dots_and_ends_with_a_dot() {
        assert_eq!(ssip_body("1. e4\n.e5"), "1. e4\r\n..e5\r\n.\r\n");
    }
}
