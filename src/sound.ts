// Move and feedback sounds.
// Own recordings in src/assets/sounds/ (move, capture, check, checkmate, setup –
// .ogg/.mp3/.wav) are used when present; everything else is synthesised with
// Web Audio: a wooden piece set down on a board (short muffled strike, a few
// damped wood modes and a low thud from the board).

import { store } from "./util";

type Name = "Move" | "Capture" | "Check" | "Checkmate" | "Error" | "Confirmation" | "Victory" | "Setup";

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

// Recordings are fetched and decoded into Web Audio buffers instead of being
// played with <audio>: in the installed app WebKitGTK (Linux) cannot stream
// media from Tauri's own URL scheme, but fetch() works. Buffers also start
// without delay.
const buffers = new Map<string, Promise<AudioBuffer | null>>();

function loadBuffer(url: string): Promise<AudioBuffer | null> {
  let p = buffers.get(url);
  if (!p) {
    p = (async () => {
      const ac = audio();
      if (!ac) return null;
      try {
        const data = await (await fetch(url)).arrayBuffer();
        return await ac.decodeAudioData(data);
      } catch {
        return null;
      }
    })();
    buffers.set(url, p);
  }
  return p;
}

/** Only the latest instance of each recording plays; quick steps don't pile up. */
const playingFiles = new Map<string, AudioBufferSourceNode>();

async function playFile(url: string, fallback: () => void) {
  const ac = audio();
  const buffer = await loadBuffer(url);
  if (!ac || !buffer) return fallback();
  try {
    playingFiles.get(url)?.stop();
  } catch {
    /* already finished */
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const gain = ac.createGain();
  gain.gain.value = volume();
  src.connect(gain).connect(ac.destination);
  src.start();
  playingFiles.set(url, src);
}

/** Decode all recordings up front so the first move already sounds instantly. */
export function preloadSounds() {
  for (const name of Object.values(RECORDED)) {
    const url = name && recording(name);
    if (url) void loadBuffer(url);
  }
}

export function soundOn(): boolean {
  return store.get("sound") !== "off";
}

export function volume(): number {
  const v = Number(store.get("volume") ?? "0.6");
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6;
}

// --- synthesised wood ---------------------------------------------------------

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** A short burst of noise (the strike itself). */
function noiseBuffer(ac: AudioContext): AudioBuffer {
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
function knock(ac: AudioContext, out: AudioNode, at: number, pitch = 1, level = 1) {
  // Wood modes: inharmonic partials that die out quickly (higher = faster).
  const modes: [number, number, number][] = [
    // [frequency Hz, decay s, gain] – low and short: a muffled, dull knock
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
  // The strike: band-passed noise click.
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
function marimba(ac: AudioContext, out: AudioNode, at: number, freq: number, level = 0.5) {
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

function wood(name: Name) {
  const ac = audio();
  if (!ac) return;
  const out = ac.createGain();
  out.gain.value = volume();
  out.connect(ac.destination);
  const t = ac.currentTime + 0.005;
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

function play(name: Name) {
  if (!soundOn()) return;
  const file = RECORDED[name];
  const url = (file && recording(file)) ?? (name === "Capture" ? recording("move") : undefined);
  if (url) void playFile(url, () => wood(name));
  else wood(name);
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
