//! Native sound playback (rodio).
//!
//! The web view's audio can't be relied on: WebKitGTK suspends Web Audio on
//! its own (e.g. after silence or a tab switch) and only lets it resume
//! inside a direct click – move sounds come after a backend round trip, so
//! they were often swallowed. Here sounds go straight to the sound card.
//!
//! The frontend registers every sound once as WAV bytes (own recordings
//! decoded and re-encoded, synthesised ones rendered offline) and then just
//! asks to play them by name.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::mixer::Mixer;
use rodio::{Decoder, Source};

pub struct Audio {
    /// None if no output device could be opened (the frontend then falls back).
    mixer: Option<Mixer>,
    sounds: Mutex<HashMap<String, Arc<[u8]>>>,
}

impl Audio {
    /// Open the default output on a thread of its own and keep it open for the
    /// lifetime of the app (the device handle isn't `Send` on every platform).
    pub fn open() -> Audio {
        let (tx, rx) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new().name("audio-output".into()).spawn(move || {
            match rodio::DeviceSinkBuilder::open_default_sink() {
                Ok(mut sink) => {
                    sink.log_on_drop(false);
                    let _ = tx.send(Some(sink.mixer().clone()));
                    // Keep `sink` alive: dropping it would close the device.
                    loop {
                        std::thread::park();
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                }
            }
        });
        let mixer = match spawned {
            Ok(_) => rx.recv_timeout(Duration::from_secs(3)).ok().flatten(),
            Err(_) => None,
        };
        Audio { mixer, sounds: Mutex::new(HashMap::new()) }
    }

    pub fn available(&self) -> bool {
        self.mixer.is_some()
    }

    /// The output, for sources that aren't registered sounds (the reading voice).
    pub fn mixer(&self) -> Option<Mixer> {
        self.mixer.clone()
    }

    /// Store a sound (WAV bytes) under a name; checks that it decodes.
    pub fn register(&self, name: &str, wav: Vec<u8>) -> Result<(), String> {
        let data: Arc<[u8]> = wav.into();
        Decoder::new(Cursor::new(data.clone())).map_err(|e| format!("{name}: {e}"))?;
        self.sounds.lock().unwrap().insert(name.to_string(), data);
        Ok(())
    }

    /// Play a registered sound right away; several may overlap.
    pub fn play(&self, name: &str, volume: f32) -> Result<(), String> {
        let mixer = self.mixer.as_ref().ok_or("Keine Audio-Ausgabe gefunden")?;
        let data = self
            .sounds
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| format!("Unbekannter Klang: {name}"))?;
        let source = Decoder::new(Cursor::new(data)).map_err(|e| e.to_string())?;
        mixer.add(source.amplify(volume.clamp(0.0, 1.0)));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal valid WAV: 16-bit mono, 8 kHz, 10 samples of silence.
    fn tiny_wav() -> Vec<u8> {
        let samples = 10u32;
        let data_len = samples * 2;
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data_len).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes()); // PCM
        w.extend_from_slice(&1u16.to_le_bytes()); // mono
        w.extend_from_slice(&8000u32.to_le_bytes());
        w.extend_from_slice(&16000u32.to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_len.to_le_bytes());
        w.extend(std::iter::repeat_n(0u8, data_len as usize));
        w
    }

    #[test]
    fn registers_valid_wav_and_rejects_garbage() {
        let audio = Audio { mixer: None, sounds: Mutex::new(HashMap::new()) };
        assert!(audio.register("move", tiny_wav()).is_ok());
        assert!(audio.register("broken", b"not a wav".to_vec()).is_err());
        // Without an output device, playing reports a clear error instead of panicking.
        assert!(audio.play("move", 0.5).unwrap_err().contains("Audio-Ausgabe"));
    }
}
