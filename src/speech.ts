// Reading texts aloud (src-tauri/src/speech.rs, piper.rs): with Piper, a
// natural voice downloaded on request, or with the system's voice.
//
// One text at a time: speaking a new one stops the old. A text is known by a
// key (the opening texts use the position), so a re-rendered button can show
// whether its text is the one being read.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SpeechLang = "de" | "en";
export type Engine = "piper" | "system";

export interface SpeechStatus {
  /** A system voice is there. */
  system: boolean;
  piper: {
    /** Piper runs on this system. */
    supported: boolean;
    /** Program and voice for the language are downloaded. */
    installed: boolean;
    /** Bytes still to download. */
    downloadSize: number;
    voice: string;
  };
}

/** Key of the text being read (null: silent). */
let current: string | null = null;
/** Backend id of that text; null while `speech_speak` hasn't answered yet. */
let currentId: number | null = null;
const listeners = new Set<() => void>();

function changed() {
  for (const f of listeners) f();
}

listen<{ id: number }>("speech-end", (e) => {
  if (current !== null && e.payload.id === currentId) {
    current = currentId = null;
    changed();
  }
}).catch(console.error);

export function speechStatus(language: SpeechLang): Promise<SpeechStatus> {
  return invoke<SpeechStatus>("speech_status", { lang: language });
}

/** Download Piper and the voice for a language; `progress` gets bytes done/total. */
export async function installVoice(language: SpeechLang, progress: (done: number, total: number) => void) {
  const off = await listen<{ done: number; total: number }>("voice-progress", (e) => progress(e.payload.done, e.payload.total));
  try {
    await invoke("voice_install", { lang: language });
  } finally {
    off();
  }
}

export function cancelVoiceInstall() {
  invoke("voice_cancel").catch(console.error);
}

/** Key of the text being read, or null. */
export function speakingKey(): string | null {
  return current;
}

/** Called whenever reading starts or stops. */
export function onSpeechChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export async function speak(key: string, text: string, language: SpeechLang, engine: Engine) {
  current = key;
  currentId = null;
  changed();
  try {
    const id = await invoke<number>("speech_speak", { text: spoken(text, language), lang: language, engine });
    if (current === key) currentId = id;
  } catch (e) {
    if (current === key) {
      current = null;
      changed();
    }
    throw e;
  }
}

export function stopSpeech() {
  if (current === null) return;
  current = currentId = null;
  changed();
  invoke("speech_stop").catch(console.error);
}

// ---------------------------------------------------------------------------
// chess notation as words

const WORDS = {
  de: {
    K: "König",
    Q: "Dame",
    R: "Turm",
    B: "Läufer",
    N: "Springer",
    x: "schlägt",
    promote: "wird",
    check: "Schach",
    mate: "matt",
    short: "kurze Rochade",
    long: "lange Rochade",
  },
  en: {
    K: "King",
    Q: "Queen",
    R: "Rook",
    B: "Bishop",
    N: "Knight",
    x: "takes",
    promote: "promotes to",
    check: "check",
    mate: "mate",
    short: "castles kingside",
    long: "castles queenside",
  },
};

const MOVE = /\b(?:\d+\s*\.(?:\s*\.\.|…)?\s*)?(?:(O-O-O|0-0-0)|(O-O|0-0)|([KQRBN])?([a-h]?[1-8]?)(x)?([a-h][1-8])(?:=([QRBN]))?)([+#])?[!?]*/g;

/**
 * "After 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4" → "After e4 c5 Knight f3 d6
 * d4 c takes d4 Knight takes d4": move numbers left out (a voice reads
 * "1." as "first"), pieces and captures as words.
 */
export function spoken(text: string, language: SpeechLang): string {
  const w = WORDS[language];
  return text.replace(MOVE, (_m, long, short, piece, from, x, to, promo, check) => {
    const parts: string[] = [];
    if (long) parts.push(w.long);
    else if (short) parts.push(w.short);
    else {
      if (piece) parts.push(w[piece as "K"]);
      if (from) parts.push(from);
      if (x) parts.push(w.x);
      parts.push(to);
      if (promo) parts.push(w.promote, w[promo as "Q"]);
    }
    if (check) parts.push(check === "#" ? w.mate : w.check);
    return parts.join(" ");
  });
}
