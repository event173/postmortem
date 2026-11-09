// "In den Karteikasten": turn a position into your own flashcard (see cards.rs).
// Used from the review, from free play and from games against the bot.

import { invoke } from "@tauri-apps/api/core";

import { t } from "./i18n";

export interface CardRequest {
  fen: string;
  /** The move that was played from there (UCI), if any. */
  played?: string | null;
  source: "review" | "explore" | "play";
  gameId?: string | null;
  ply?: number | null;
}

/**
 * Make `btn` add the position from `request()` to the flashcard box. Stockfish
 * needs a few seconds, so the button says what's going on.
 */
export function bindCardButton(btn: HTMLButtonElement, request: () => CardRequest | null) {
  const label = btn.innerHTML;
  btn.addEventListener("click", async () => {
    const req = request();
    if (!req || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = t("Stockfish sucht die besten Züge …");
    try {
      await invoke("card_create", { ...req, played: req.played ?? null, gameId: req.gameId ?? null, ply: req.ply ?? null });
      btn.textContent = t("✓ Im Karteikasten");
      btn.title = t("Kommt unter Lernen → Karteikasten dran.");
    } catch (e) {
      btn.textContent = String(e);
    }
    setTimeout(() => {
      btn.innerHTML = label;
      btn.disabled = false;
    }, 2500);
  });
}

export const CARD_BUTTON_LABEL = () => `＋ ${t("In den Karteikasten")}`;
