//! UI language of backend messages (errors, coach comments, game-end reasons).
//!
//! The frontend sets the language at start; the coach can temporarily force a
//! language on the current thread to write its comments in both languages.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    De,
    En,
}

static ENGLISH: AtomicBool = AtomicBool::new(false);

thread_local! {
    static OVERRIDE: Cell<Option<Lang>> = const { Cell::new(None) };
}

pub fn set(lang: &str) {
    ENGLISH.store(lang == "en", Ordering::Relaxed);
}

pub fn current() -> Lang {
    OVERRIDE.with(|o| o.get()).unwrap_or(if ENGLISH.load(Ordering::Relaxed) { Lang::En } else { Lang::De })
}

pub fn en() -> bool {
    current() == Lang::En
}

/// Run `f` with `lang` as the language of this thread.
pub fn with<T>(lang: Lang, f: impl FnOnce() -> T) -> T {
    let prev = OVERRIDE.with(|o| o.replace(Some(lang)));
    let out = f();
    OVERRIDE.with(|o| o.set(prev));
    out
}

/// `tr!("Deutsch {x}", "English {x}")` – a `String` in the current language.
/// Both literals may capture variables like `format!`.
#[macro_export]
macro_rules! tr {
    ($de:literal, $en:literal) => {
        if $crate::i18n::en() { format!($en) } else { format!($de) }
    };
}

/// Refusal to analyse a game that is still being played (engine help during a
/// game gets accounts closed on Lichess and chess.com).
pub fn still_running() -> String {
    tr!(
        "Diese Partie läuft noch – analysieren erst nach Partieende. Engine-Hilfe während einer laufenden Partie verstößt gegen die Fair-Play-Regeln von Lichess und chess.com und kann zur Sperre führen.",
        "This game is still running – analyse it after it has ended. Engine help during a game breaks the fair-play rules of Lichess and chess.com and can get your account closed."
    )
}

/// The "Stockfish is missing" error, shared by everything that starts the engine.
pub fn no_stockfish() -> String {
    tr!(
        "Stockfish wurde nicht gefunden. Installiere es z. B. mit: sudo apt install stockfish",
        "Stockfish was not found. Install it, e.g. with: sudo apt install stockfish"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_wins_and_is_restored() {
        let x = 3;
        let german = with(Lang::De, || tr!("{x} Züge", "{x} moves"));
        let english = with(Lang::En, || tr!("{x} Züge", "{x} moves"));
        assert_eq!((german.as_str(), english.as_str()), ("3 Züge", "3 moves"));
        with(Lang::En, || {
            with(Lang::De, || assert!(!en()));
            assert!(en());
        });
    }
}
