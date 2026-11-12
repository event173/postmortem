//! A natural reading voice: Piper (neural text-to-speech, runs offline).
//!
//! Nothing of it ships with the app. On first use the frontend asks, then the
//! Piper program and a voice per language are downloaded into the data folder
//! (`voice/`), each checked against a fixed SHA-256. Piper then runs as a
//! process per text: text in on stdin, raw 16-bit mono PCM out on stdout,
//! sentence by sentence – so the first sentence plays while the next is
//! still being computed. The samples go to the app's own sound output.
//!
//! Piper: <https://github.com/rhasspy/piper> (release 2023.11.14-2; the newer
//! piper1-gpl has no ready-made program). Voices: rhasspy/piper-voices,
//! pinned to a revision whose models this Piper still reads.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::Source;
use rodio::mixer::Mixer;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

struct Download {
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const PROGRAM: Option<Download> = Some(Download {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
    sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
    size: 26_460_462,
});
#[cfg(all(windows, target_arch = "x86_64"))]
const PROGRAM: Option<Download> = Some(Download {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
    size: 22_477_236,
});
#[cfg(not(any(all(target_os = "linux", target_arch = "x86_64"), all(windows, target_arch = "x86_64"))))]
const PROGRAM: Option<Download> = None;

#[cfg(windows)]
const EXE: &str = "piper.exe";
#[cfg(not(windows))]
const EXE: &str = "piper";

struct Voice {
    lang: &'static str,
    /// File name without extension (Piper's voice id).
    name: &'static str,
    /// Shown in the download question.
    label: &'static str,
    model: Download,
    config: Download,
}

const VOICES_URL: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aad/";

const VOICES: [Voice; 2] = [
    Voice {
        lang: "de",
        name: "de_DE-thorsten-medium",
        label: "Thorsten",
        model: Download {
            url: "de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx",
            sha256: "7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819",
            size: 63_201_294,
        },
        config: Download {
            url: "de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json",
            sha256: "974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85",
            size: 4_819,
        },
    },
    Voice {
        lang: "en",
        name: "en_GB-cori-medium",
        label: "Cori",
        model: Download {
            url: "en/en_GB/cori/medium/en_GB-cori-medium.onnx",
            sha256: "1899f98e5fb8310154f3c2973f4b8a929ba7245e722b3d3a85680b833d95f10d",
            size: 63_531_379,
        },
        config: Download {
            url: "en/en_GB/cori/medium/en_GB-cori-medium.onnx.json",
            sha256: "e262c16d7f192f69d4edd6b4ef8a5915379e67495fcc402f1ab15eeb33da3d36",
            size: 4_966,
        },
    },
];

fn voice(lang: &str) -> &'static Voice {
    VOICES.iter().find(|v| v.lang == lang).unwrap_or(&VOICES[1])
}

fn root(data: &Path) -> PathBuf {
    data.join("voice")
}

/// The extracted program (the archives hold a folder `piper/`).
fn program_dir(data: &Path) -> PathBuf {
    root(data).join("piper")
}

/// Written last when installing the program: a half-extracted folder doesn't count.
fn program_marker(data: &Path) -> PathBuf {
    program_dir(data).join(".complete")
}

fn model_path(data: &Path, v: &Voice) -> PathBuf {
    root(data).join(format!("{}.onnx", v.name))
}

fn program_installed(data: &Path) -> bool {
    program_marker(data).exists()
}

fn voice_installed(data: &Path, v: &Voice) -> bool {
    model_path(data, v).exists() && root(data).join(format!("{}.onnx.json", v.name)).exists()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Piper runs on this system at all.
    pub supported: bool,
    /// Program and voice for the language are there.
    pub installed: bool,
    /// What is still missing, in bytes.
    pub download_size: u64,
    /// Name of the voice ("Thorsten").
    pub voice: String,
}

pub fn status(data: &Path, lang: &str) -> Status {
    let v = voice(lang);
    let program = if program_installed(data) { 0 } else { PROGRAM.as_ref().map_or(0, |p| p.size) };
    let voice_size = if voice_installed(data, v) { 0 } else { v.model.size + v.config.size };
    Status {
        supported: PROGRAM.is_some(),
        installed: PROGRAM.is_some() && program == 0 && voice_size == 0,
        download_size: program + voice_size,
        voice: v.label.into(),
    }
}

// ---------------------------------------------------------------------------
// installing

#[derive(Clone, Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

/// Download what's missing for `lang` (progress via `voice-progress` events).
pub async fn install(app: &AppHandle, data: &Path, lang: &str, cancel: &AtomicBool) -> Result<Status, String> {
    let program = PROGRAM.as_ref().ok_or_else(|| {
        crate::tr!("Die natürliche Stimme gibt es für dieses System nicht.", "The natural voice isn't available for this system.")
    })?;
    let v = voice(lang);
    let dir = root(data);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let total = status(data, lang).download_size;
    let mut done = 0;

    if !program_installed(data) {
        let archive = dir.join("piper-download.part");
        fetch(app, program.url, program, &archive, cancel, &mut done, total).await?;
        let extracted = extract(&archive, &dir);
        let _ = std::fs::remove_file(&archive);
        extracted?;
        std::fs::write(program_marker(data), b"").map_err(|e| e.to_string())?;
    }
    if !voice_installed(data, v) {
        for (d, ext) in [(&v.config, "onnx.json"), (&v.model, "onnx")] {
            let target = dir.join(format!("{}.{ext}", v.name));
            let part = dir.join(format!("{}.{ext}.part", v.name));
            fetch(app, &format!("{VOICES_URL}{}", d.url), d, &part, cancel, &mut done, total).await?;
            std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(status(data, lang))
}

/// Download `url` to `to`, checking size and SHA-256 (deletes the file on any error).
async fn fetch(
    app: &AppHandle,
    url: &str,
    expected: &Download,
    to: &Path,
    cancel: &AtomicBool,
    done: &mut u64,
    total: u64,
) -> Result<(), String> {
    let result = fetch_inner(app, url, expected, to, cancel, done, total).await;
    if result.is_err() {
        let _ = std::fs::remove_file(to);
    }
    result
}

async fn fetch_inner(
    app: &AppHandle,
    url: &str,
    expected: &Download,
    to: &Path,
    cancel: &AtomicBool,
    done: &mut u64,
    total: u64,
) -> Result<(), String> {
    use crate::lichess::{FetchError, network_error};
    let mut resp = crate::lichess::client()?.get(url).send().await.map_err(|e| match network_error(e) {
        FetchError::Offline => crate::tr!("Keine Internetverbindung.", "No internet connection."),
        FetchError::Other(e) => e,
    })?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(crate::tr!("Download fehlgeschlagen ({status}).", "Download failed ({status})."));
    }
    let mut file = std::io::BufWriter::new(std::fs::File::create(to).map_err(|e| e.to_string())?);
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut last_emit = 0u64;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| crate::tr!("Download abgebrochen: {e}", "Download interrupted: {e}"))?
    {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hash.update(&chunk);
        size += chunk.len() as u64;
        *done += chunk.len() as u64;
        if *done - last_emit > 1_000_000 {
            let _ = app.emit("voice-progress", Progress { done: *done, total });
            last_emit = *done;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    let _ = app.emit("voice-progress", Progress { done: *done, total });
    if size != expected.size || hex::encode(hash.finalize()) != expected.sha256 {
        return Err(crate::tr!(
            "Die heruntergeladene Datei ist nicht die erwartete – bitte später nochmal versuchen.",
            "The downloaded file isn't the expected one – please try again later."
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    // `unpack` refuses paths leaving `into`.
    tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(into).map_err(|e| e.to_string())?;
    // The program must be executable whatever the umask did.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(into.join("piper").join(EXE), std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    // `extract` only writes paths inside `into`.
    zip::ZipArchive::new(file).and_then(|mut z| z.extract(into)).map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "linux", windows)))]
fn extract(_archive: &Path, _into: &Path) -> Result<(), String> {
    Err("unsupported".into())
}

/// Remove program and voices.
pub fn delete(data: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(root(data)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// speaking

/// Ids of texts read by Piper (far from speech-dispatcher's message ids).
static NEXT_ID: AtomicU64 = AtomicU64::new(1 << 40);

struct Running {
    child: Arc<Mutex<Child>>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Piper {
    running: Mutex<Option<Running>>,
}

impl Piper {
    /// Read `text` aloud; returns its id (the `speech-end` event carries it).
    pub fn speak(&self, app: &AppHandle, mixer: Mixer, data: &Path, text: &str, lang: &str) -> Result<u64, String> {
        self.stop();
        let v = voice(lang);
        if !program_installed(data) || !voice_installed(data, v) {
            return Err(crate::tr!("Die Stimme ist nicht heruntergeladen.", "The voice hasn't been downloaded."));
        }
        let rate = sample_rate(data, v).unwrap_or(22_050);
        let dir = program_dir(data);
        let mut cmd = Command::new(dir.join(EXE));
        cmd.current_dir(&dir)
            .arg("--model")
            .arg(model_path(data, v))
            .arg("--output-raw")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            crate::tr!("Die Stimme konnte nicht gestartet werden: {e}", "The voice could not be started: {e}")
        })?;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        let child = Arc::new(Mutex::new(child));
        let stop = Arc::new(AtomicBool::new(false));
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

        // One paragraph per line; Piper splits sentences itself and writes each one's audio when ready.
        let input = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n") + "\n";
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
            // Dropping stdin ends the input: Piper exits after the last sentence.
        });

        let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(64);
        let reaper = child.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut odd: Option<u8> = None;
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut bytes: Vec<u8> = odd.take().into_iter().collect();
                        bytes.extend_from_slice(&buf[..n]);
                        if bytes.len() % 2 == 1 {
                            odd = bytes.pop();
                        }
                        let samples =
                            bytes.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f32 / 32768.0).collect();
                        if tx.send(samples).is_err() {
                            break; // stopped
                        }
                    }
                }
            }
            let _ = reaper.lock().map(|mut c| c.wait());
        });

        mixer.add(Stream {
            rx,
            buf: Vec::new(),
            pos: 0,
            rate: std::num::NonZero::new(rate).unwrap_or(std::num::NonZero::<u32>::MIN),
            stop: stop.clone(),
            ended: false,
            app: app.clone(),
            id,
        });
        *self.running.lock().unwrap() = Some(Running { child, stop });
        Ok(id)
    }

    pub fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            r.stop.store(true, Ordering::Relaxed);
            let _ = r.child.lock().map(|mut c| c.kill());
        }
    }
}

fn sample_rate(data: &Path, v: &Voice) -> Option<u32> {
    let json = std::fs::read_to_string(root(data).join(format!("{}.onnx.json", v.name))).ok()?;
    let config: serde_json::Value = serde_json::from_str(&json).ok()?;
    config["audio"]["sample_rate"].as_u64().map(|r| r as u32)
}

/// Piper's output as a sound source. While Piper is still computing the next
/// sentence it plays silence; it ends when Piper is done and everything has
/// been played, or when stopped.
struct Stream {
    rx: Receiver<Vec<f32>>,
    buf: Vec<f32>,
    pos: usize,
    rate: rodio::SampleRate,
    stop: Arc<AtomicBool>,
    ended: bool,
    app: AppHandle,
    id: u64,
}

impl Iterator for Stream {
    type Item = rodio::Sample;

    fn next(&mut self) -> Option<f32> {
        if self.ended || self.stop.load(Ordering::Relaxed) {
            return None;
        }
        if self.pos >= self.buf.len() {
            match self.rx.try_recv() {
                Ok(samples) => {
                    self.buf = samples;
                    self.pos = 0;
                }
                Err(TryRecvError::Empty) => return Some(0.0),
                Err(TryRecvError::Disconnected) => {
                    self.ended = true;
                    return None;
                }
            }
        }
        let s = self.buf.get(self.pos).copied().unwrap_or(0.0);
        self.pos += 1;
        Some(s)
    }
}

impl Source for Stream {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> rodio::ChannelCount {
        std::num::NonZero::<u16>::MIN
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.rate
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

impl Drop for Stream {
    /// Removed from the output (played to the end or stopped): tell the frontend.
    fn drop(&mut self) {
        crate::speech::emit_end(&self.app, self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_counts_what_is_missing() {
        let dir = std::env::temp_dir().join(format!("postmortem-piper-test-{}", std::process::id()));
        let s = status(&dir, "de");
        assert_eq!(s.voice, "Thorsten");
        assert!(!s.installed);
        if s.supported {
            assert_eq!(s.download_size, PROGRAM.as_ref().unwrap().size + 63_201_294 + 4_819);
        }
        // Unknown languages get the English voice.
        assert_eq!(status(&dir, "fr").voice, "Cori");
    }
}
