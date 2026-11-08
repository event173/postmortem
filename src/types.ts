// Mirrors the serde types in src-tauri/src/{lichess,analysis,engine}.rs

export interface Player {
  name: string;
  rating: number | null;
}

export interface Opening {
  eco: string;
  name: string;
  ply: number;
}

export interface GameInfo {
  id: string;
  white: Player;
  black: Player;
  winner: "white" | "black" | null;
  status: string;
  speed: string;
  rated: boolean;
  timeControl: string | null;
  createdAt: number;
  opening: Opening | null;
  moves: string[];
}

export type Score =
  | { kind: "cp"; value: number }
  | { kind: "mate"; value: number }
  | { kind: "mated" }
  | { kind: "won" };

export type Class =
  | "brilliant"
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "book"
  | "forced"
  | "inaccuracy"
  | "mistake"
  | "miss"
  | "blunder";

export interface MoveReview {
  ply: number;
  color: "white" | "black";
  san: string;
  uci: string;
  classification: Class;
  winBefore: number;
  winAfter: number;
  bestSan: string | null;
  bestUci: string | null;
  bestLine: string | null;
  comment: string;
  /** Why the move was bad (bad moves only). */
  theme?: Theme | null;
}

export interface GameReview {
  version: number;
  gameId: string;
  depth: number;
  fens: string[];
  evals: Score[];
  winWhite: number[];
  moves: MoveReview[];
  accuracy: { white: number; black: number };
}

export interface Progress {
  gameId: string;
  done: number;
  total: number;
}

export interface ClassInfo {
  label: string;
  /** "Nf6 ist …" */
  phrase: string;
  symbol: string;
  color: string;
}

export const CLASSES: Record<Class, ClassInfo> = {
  brilliant: { label: "Brillant", phrase: "brillant", symbol: "!!", color: "#1fb8a0" },
  great: { label: "Stark", phrase: "ein starker Zug", symbol: "!", color: "#5b8dd6" },
  best: { label: "Bester Zug", phrase: "der beste Zug", symbol: "★", color: "#7cad3f" },
  excellent: { label: "Ausgezeichnet", phrase: "ausgezeichnet", symbol: "✓", color: "#97b850" },
  good: { label: "Gut", phrase: "gut", symbol: "✓", color: "#8aa585" },
  book: { label: "Theorie", phrase: "ein Theoriezug", symbol: "≡", color: "#a8896a" },
  forced: { label: "Erzwungen", phrase: "erzwungen", symbol: "□", color: "#8d8d8d" },
  inaccuracy: { label: "Ungenauigkeit", phrase: "eine Ungenauigkeit", symbol: "?!", color: "#e3b341" },
  mistake: { label: "Fehler", phrase: "ein Fehler", symbol: "?", color: "#e5862a" },
  miss: { label: "Verpasst", phrase: "eine verpasste Chance", symbol: "✕", color: "#e0614f" },
  blunder: { label: "Patzer", phrase: "ein Patzer", symbol: "??", color: "#d23a3a" },
};

/** Order used in the summary table. */
export const SUMMARY_ORDER: Class[] = [
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "book",
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
];

export const BAD: Class[] = ["inaccuracy", "mistake", "miss", "blunder"];

export interface PositionInfo {
  turn: "white" | "black";
  dests: Record<string, string[]>;
}

export interface PlayedMove {
  fen: string;
  san: string;
  uci: string;
  check: boolean;
}

export interface LiveLine {
  /** White's point of view. */
  score: Score;
  winWhite: number;
  uci: string;
  san: string;
  line: string;
}

export interface LiveInfo {
  id: number;
  fen: string;
  depth: number;
  done: boolean;
  lines: LiveLine[];
}

/** A move the user played on the board, off the game's main line. */
export interface VarNode {
  fen: string;
  san: string;
  uci: string;
  check: boolean;
  review?: MoveReview;
  error?: string;
}

/** A game from the local store. */
export interface StoredGame extends GameInfo {
  analysed: boolean;
}

export interface SyncResult {
  added: number;
  offline: boolean;
}

export type Theme =
  | "allowedMate"
  | "missedMate"
  | "allowedFork"
  | "hangingPiece"
  | "lostMaterial"
  | "missedTactic"
  | "missedChance"
  | "positional";

export type Phase = "opening" | "middlegame" | "endgame";

export interface ThemeExample {
  gameId: string;
  ply: number;
  san: string;
  classification: Class;
  createdAt: number;
  opponent: string;
}

export interface ThemeStat {
  theme: Theme;
  count: number;
  examples: ThemeExample[];
}

export interface PhaseStat {
  moves: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
}

export interface TrendPoint {
  gameId: string;
  createdAt: number;
  accuracy: number;
  result: "win" | "loss" | "draw";
}

export interface WeaknessStats {
  gamesTotal: number;
  gamesAnalysed: number;
  moves: number;
  accuracyAvg: number | null;
  classes: Partial<Record<Class, number>>;
  themes: ThemeStat[];
  phases: Partial<Record<Phase, PhaseStat>>;
  trend: TrendPoint[];
}

export interface BatchProgress {
  done: number;
  total: number;
  current: string | null;
  finished: boolean;
}
