// Move and feedback sounds.
//
// Sounds are played natively by the backend (rodio, see audio.rs): WebKitGTK
// suspends Web Audio on its own (after silence, tab switches …) and only lets
// it resume inside a direct click, so move sounds were often swallowed.
//
// At start every sound is prepared once and handed to the backend as WAV:
// - own recordings in src/assets/sounds/ (move, capture, check, checkmate,
//   setup – .ogg/.mp3/.wav) are decoded and re-encoded,
// - all others are synthesised (a wooden piece set down on a board: short
//   muffled strike, damped wood modes, low thud) with an OfflineAudioContext,
//   which needs no permission to "play".
// If the backend has no audio device, sounds fall back to Web Audio.

import { invoke } from "@tauri-apps/api/core";

import { t } from "./i18n";
import { store } from "./util";

type Name = "Move" | "Capture" | "Check" | "Checkmate" | "Error" | "Confirmation" | "Victory" | "Setup";
const NAMES: Name[] = ["Move", "Capture", "Check", "Checkmate", "Error", "Confirmation", "Victory", "Setup"];

const FILES = import.meta.glob("./assets/sounds/*.{ogg,mp3,wav}", { eager: true, query: "?url", import: "default" }) as Record<
  string,
  string
>;

/** URL of an own recording, e.g. "move" -> ./assets/sounds/move.ogg */
function recording(name: string): string | undefined {
  for (const ext of ["ogg", "mp3", "wav"]) {
    const url = FILES[`./assets/sounds/${name}.${ext}`];
    if (url) return url;
  }
  return undefined;
}

const RECORDED: Partial<Record<Name, string>> = {
  Move: "move",
  Capture: "capture",
  Check: "check",
  Checkmate: "checkmate",
  Setup: "setup",
};

/** Own recording for a sound (a capture falls back to the move recording). */
function recordingFor(name: Name): string | undefined {
  const file = RECORDED[name];
  return (file && recording(file)) ?? (name === "Capture" ? recording("move") : undefined);
}

export function soundOn(): boolean {
  return store.get("sound") !== "off";
}

export function volume(): number {
  const v = Number(store.get("volume") ?? "0.6");
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6;
}

// ---------------------------------------------------------------------------
// preparing sounds (decode or synthesise -> AudioBuffer -> WAV)

const SAMPLE_RATE = 44100;

interface Prepared {
  buffer: AudioBuffer | null;
  source: "file" | "synth";
  error: string | null;
  /** Registered with the native backend. */
  native: boolean;
}

const prepared = new Map<Name, Prepared>();
let nativeOutput = false;
let preparing: Promise<void> | null = null;

async function decodeFile(url: string): Promise<AudioBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.arrayBuffer();
  if (!data.byteLength) throw new Error(t("Datei ist leer"));
  // Decoding doesn't need a running (or permitted) audio output.
  return new OfflineAudioContext(2, 1, SAMPLE_RATE).decodeAudioData(data);
}

/** Render a synthesised sound offline. */
async function renderSynth(name: Name): Promise<AudioBuffer> {
  const seconds = name === "Checkmate" ? 1.3 : name === "Setup" ? 0.8 : 0.6;
  const ac = new OfflineAudioContext(2, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
  renderWood(ac, ac.destination, 0.002, name);
  return ac.startRendering();
}

/** 16-bit PCM WAV of an AudioBuffer (mono or stereo). */
function toWav(buf: AudioBuffer): Uint8Array {
  const channels = Math.min(2, buf.numberOfChannels);
  const frames = buf.length;
  const dataLen = frames * channels * 2;
  const out = new DataView(new ArrayBuffer(44 + dataLen));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + dataLen, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, channels, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, dataLen, true);
  const data = Array.from({ length: channels }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(out.buffer);
}

async function loadOne(name: Name): Promise<Prepared> {
  const url = recordingFor(name);
  let buffer: AudioBuffer | null = null;
  let source: Prepared["source"] = url ? "file" : "synth";
  let error: string | null = null;
  try {
    buffer = url ? await decodeFile(url) : await renderSynth(name);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // A broken recording: use the built-in sound instead.
    if (url) {
      source = "synth";
      buffer = await renderSynth(name).catch(() => null);
    }
  }
  return { buffer, source, error, native: false };
}

/** Loudness of a sound: the strongest 50 ms (RMS over all channels), plus its peak. */
function loudness(buf: AudioBuffer): { rms: number; peak: number } {
  const win = Math.max(1, Math.round(buf.sampleRate * 0.05));
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  let best = 0;
  let peak = 0;
  for (let start = 0; start < buf.length; start += Math.ceil(win / 2)) {
    let sum = 0;
    let n = 0;
    for (const d of chans) {
      for (let i = start; i < Math.min(buf.length, start + win); i++) {
        sum += d[i] * d[i];
        peak = Math.max(peak, Math.abs(d[i]));
        n++;
      }
    }
    if (n) best = Math.max(best, Math.sqrt(sum / n));
  }
  return { rms: best, peak };
}

/**
 * Bring the built-in (synthesised) sounds to the loudness of the own
 * recordings, so "correct" or "won" isn't louder than a move. Without
 * recordings nothing changes.
 */
function matchLoudness() {
  const recorded = [...prepared.values()].filter((p) => p.source === "file" && p.buffer).map((p) => loudness(p.buffer!).rms);
  if (!recorded.length) return;
  recorded.sort((a, b) => a - b);
  const target = recorded[Math.floor(recorded.length / 2)];
  for (const p of prepared.values()) {
    if (p.source !== "synth" || !p.buffer) continue;
    const { rms, peak } = loudness(p.buffer);
    if (!rms || !peak) continue;
    const gain = Math.min(target / rms, 0.98 / peak);
    for (let c = 0; c < p.buffer.numberOfChannels; c++) {
      const d = p.buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= gain;
    }
  }
}

async function register(name: Name, p: Prepared) {
  if (!p.buffer || !nativeOutput) return;
  try {
    await invoke("sound_register", { name, data: Array.from(toWav(p.buffer)) });
    p.native = true;
  } catch (e) {
    p.error ??= String(e);
  }
}

/** Prepare all sounds once (call at start). */
export function preloadSounds(): Promise<void> {
  preparing ??= (async () => {
    nativeOutput = await invoke<boolean>("sound_available").catch(() => false);
    for (const name of NAMES) prepared.set(name, await loadOne(name));
    matchLoudness();
    for (const [name, p] of prepared) await register(name, p);
  })();
  unlockOnGesture();
  return preparing;
}

// ---------------------------------------------------------------------------
// playing

function play(name: Name) {
  if (!soundOn()) return;
  const p = prepared.get(name);
  if (p?.native) {
    invoke("sound_play", { name, volume: volume() }).catch(() => webPlay(name));
  } else {
    webPlay(name);
  }
}

/** Sound for a move given in SAN: mate, check, capture or a plain move. */
export function moveSound(san: string) {
  if (san.includes("#")) play("Checkmate");
  else if (san.includes("+")) play("Check");
  else if (san.includes("x")) play("Capture");
  else play("Move");
}

export const errorSound = () => play("Error");
export const successSound = () => play("Confirmation");
export const victorySound = () => play("Victory");
/** A new board is set up (new game, puzzle or opening line). */
export const setupSound = () => play("Setup");

// ---------------------------------------------------------------------------
// fallback: Web Audio in the web view (no native audio device)

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Web Audio starts suspended until the user interacts; resume on every gesture. */
let unlocked = false;
function unlockOnGesture() {
  if (unlocked) return;
  unlocked = true;
  const unlock = () => {
    if (!nativeOutput) audio();
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

function webPlay(name: Name) {
  const ac = audio();
  if (!ac) return;
  const out = ac.createGain();
  out.gain.value = volume();
  out.connect(ac.destination);
  const buffer = prepared.get(name)?.buffer;
  if (buffer) {
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    src.start();
  } else {
    renderWood(ac, out, ac.currentTime + 0.005, name);
  }
}

// ---------------------------------------------------------------------------
// diagnosis (settings)

export interface SoundCheck {
  name: string;
  source: "file" | "synth";
  ok: boolean;
  native: boolean;
  seconds: number | null;
  error: string | null;
}

export async function diagnoseSounds(): Promise<{ output: string; files: SoundCheck[] }> {
  await preloadSounds();
  const files: SoundCheck[] = NAMES.map((name) => {
    const p = prepared.get(name);
    return {
      name,
      source: p?.source ?? "synth",
      ok: !!p?.buffer,
      native: !!p?.native,
      seconds: p?.buffer ? Math.round(p.buffer.duration * 100) / 100 : null,
      error: p?.error ?? null,
    };
  });
  const output = nativeOutput
    ? t("nativ (Soundkarte direkt)")
    : t("Web Audio ({state}) – keine native Ausgabe gefunden", { state: ctx?.state ?? t("inaktiv") });
  return { output, files };
}

/** Play one sound by its internal name (test buttons in the settings). */
export function testSound(name: string) {
  play(name as Name);
}

// ---------------------------------------------------------------------------
// synthesised wood

/** A short burst of noise (the strike itself). */
function noiseBuffer(ac: BaseAudioContext): AudioBuffer {
  const len = Math.floor(ac.sampleRate * 0.012);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  return buf;
}

/**
 * One wooden "tock" at time `at`. `pitch` scales all wood modes (lower =
 * heavier piece / thicker board), `level` is the loudness.
 */
function knock(ac: BaseAudioContext, out: AudioNode, at: number, pitch = 1, level = 1) {
  // Wood modes: inharmonic partials that die out quickly – low and short: a muffled, dull knock.
  const modes: [number, number, number][] = [
    [260, 0.05, 0.6],
    [610, 0.03, 0.3],
    [1250, 0.016, 0.08],
  ];
  for (const [f, decay, g] of modes) {
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f * pitch * (1 + (Math.random() - 0.5) * 0.04), at);
    const env = ac.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(g * level, at + 0.0015);
    env.gain.exponentialRampToValueAtTime(0.0001, at + decay * 4);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + decay * 4 + 0.02);
  }
  // The strike: low-passed noise click.
  const click = ac.createBufferSource();
  click.buffer = noiseBuffer(ac);
  const band = ac.createBiquadFilter();
  band.type = "lowpass";
  band.frequency.value = 1100 * pitch;
  band.Q.value = 0.7;
  const clickGain = ac.createGain();
  clickGain.gain.value = 0.3 * level;
  click.connect(band).connect(clickGain).connect(out);
  click.start(at);
  // The board: a soft low thud.
  const thud = ac.createOscillator();
  thud.type = "sine";
  thud.frequency.setValueAtTime(120 * pitch, at);
  thud.frequency.exponentialRampToValueAtTime(70 * pitch, at + 0.05);
  const thudGain = ac.createGain();
  thudGain.gain.setValueAtTime(0.0001, at);
  thudGain.gain.exponentialRampToValueAtTime(0.5 * level, at + 0.004);
  thudGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
  thud.connect(thudGain).connect(out);
  thud.start(at);
  thud.stop(at + 0.09);
}

/** A soft marimba-like (wooden bar) note, for feedback sounds. */
function marimba(ac: BaseAudioContext, out: AudioNode, at: number, freq: number, level = 0.5) {
  for (const [mult, g, decay] of [
    [1, 1, 0.35],
    [3.9, 0.25, 0.08],
    [9.2, 0.06, 0.03],
  ] as const) {
    const osc = ac.createOscillator();
    osc.frequency.value = freq * mult;
    const env = ac.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(g * level, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + decay * 3);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + decay * 3 + 0.02);
  }
}

/** The synthesised version of a sound, starting at `t`. */
function renderWood(ac: BaseAudioContext, out: AudioNode, t: number, name: Name) {
  switch (name) {
    case "Move":
      knock(ac, out, t);
      break;
    case "Capture":
      // the captured piece is knocked away, then the piece is set down
      knock(ac, out, t, 0.85, 0.8);
      knock(ac, out, t + 0.045, 0.95, 1);
      break;
    case "Check":
      knock(ac, out, t);
      marimba(ac, out, t + 0.03, 1320, 0.18);
      break;
    case "Checkmate":
      knock(ac, out, t, 0.9);
      marimba(ac, out, t + 0.05, 392, 0.4);
      marimba(ac, out, t + 0.2, 523, 0.4);
      marimba(ac, out, t + 0.35, 659, 0.45);
      break;
    case "Error":
      knock(ac, out, t, 0.6, 0.7);
      knock(ac, out, t + 0.12, 0.55, 0.6);
      break;
    case "Confirmation":
    case "Victory":
      marimba(ac, out, t, 784, 0.4);
      marimba(ac, out, t + 0.11, 1046, 0.4);
      break;
    case "Setup": {
      // Pieces being set up: a quick, slightly irregular run of soft knocks.
      let at = t;
      for (let i = 0; i < 10; i++) {
        knock(ac, out, at, 0.85 + Math.random() * 0.3, 0.35 + Math.random() * 0.25);
        at += 0.03 + Math.random() * 0.03;
      }
      break;
    }
  }
}
