// Mirrors the serde types in src-tauri/src/{lichess,analysis,engine}.rs

import { t } from "./i18n";

export interface Player {
  name: string;
  rating: number | null;
}

export interface Opening {
  eco: string;
  name: string;
  ply: number;
}

export type Platform = "lichess" | "chesscom" | "local";

export interface Account {
  source: Platform;
  username: string;
}

export interface GameInfo {
  id: string;
  source?: Platform;
  url?: string | null;
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
  /** Remaining clock after each ply in centiseconds, if known. */
  clocks?: number[] | null;
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
  /** Coach comment in German … */
  comment: string;
  /** … and English (missing in reviews from before 0.2.0). */
  commentEn?: string | null;
  /** The same written about the mover ("Schwarz hatte Matt …"), for your
   *  opponent's moves (missing in reviews from before 0.2.1). */
  commentOther?: string | null;
  commentOtherEn?: string | null;
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
  depth: number;
  done: number;
  total: number;
}

export interface ClassInfo {
  label: string;
  /** "Nf6 ist …" / "Nf6 is …" */
  phrase: string;
  symbol: string;
  color: string;
}

export const CLASSES: Record<Class, ClassInfo> = {
  brilliant: { label: t("Brillant"), phrase: t("brillant"), symbol: "!!", color: "#1fb8a0" },
  great: { label: t("Stark"), phrase: t("ein starker Zug"), symbol: "!", color: "#5b8dd6" },
  best: { label: t("Bester Zug"), phrase: t("der beste Zug"), symbol: "★", color: "#7cad3f" },
  excellent: { label: t("Ausgezeichnet"), phrase: t("ausgezeichnet"), symbol: "✓", color: "#97b850" },
  good: { label: t("Gut"), phrase: t("gut"), symbol: "✓", color: "#8aa585" },
  book: { label: t("Theorie"), phrase: t("ein Theoriezug"), symbol: "≡", color: "#a8896a" },
  forced: { label: t("Erzwungen"), phrase: t("erzwungen"), symbol: "□", color: "#8d8d8d" },
  inaccuracy: { label: t("Ungenauigkeit"), phrase: t("eine Ungenauigkeit"), symbol: "?!", color: "#e3b341" },
  mistake: { label: t("Fehler"), phrase: t("ein Fehler"), symbol: "?", color: "#e5862a" },
  miss: { label: t("Verpasst"), phrase: t("eine verpasste Chance"), symbol: "✕", color: "#e0614f" },
  blunder: { label: t("Patzer"), phrase: t("ein Patzer"), symbol: "??", color: "#d23a3a" },
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
  /** Played by the engine (continuation shown after a mistake), not by you. */
  engine?: boolean;
}

/** A move of an engine line, with the position after it. */
export interface LineMove {
  uci: string;
  san: string;
  fen: string;
  check: boolean;
}

/** Your move plus the engine's best continuation. */
export interface Refutation {
  moves: LineMove[];
  text: string;
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
  /** Per-game rate over all analysed games (only when a window is set). */
  baselinePerGame: number | null;
  examples: ThemeExample[];
}

export type ClockBucket = "plenty" | "low" | "scramble";

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
  /** Errors by remaining clock before the move (games with clock data only). */
  clock: Partial<Record<ClockBucket, PhaseStat>>;
  trend: TrendPoint[];
}

export interface BatchProgress {
  done: number;
  total: number;
  current: string | null;
  finished: boolean;
}
