//! Explanations of opening moves from the Wikibooks "Chess Opening Theory"
//! (CC BY-SA 4.0), embedded so they work offline. English originals in
//! `data/opening-texts/en.tsv` (fetched by `scripts/fetch-opening-texts.mjs`),
//! German translations in `de.tsv`.
//!
//! Texts are matched by position, so a transposition finds the text too.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;

use crate::openings::{epd, play_san_line};

const EN: &str = include_str!("../data/opening-texts/en.tsv");
const DE: &str = include_str!("../data/opening-texts/de.tsv");
pub const WIKI: &str = "https://en.wikibooks.org/wiki/Chess_Opening_Theory/";

struct Entry {
    /// SAN moves from the start, space-separated (the Wikibooks page).
    path: String,
    en: String,
    de: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningText {
    /// Paragraphs.
    pub paragraphs: Vec<String>,
    /// The English original although the app is German (not translated yet).
    pub untranslated: bool,
    /// The Wikibooks page (for the source note).
    pub url: String,
}

/// "e4 c6 d4" -> "1._e4/1...c6/2._d4"
fn page(path: &str) -> String {
    path.split(' ')
        .enumerate()
        .map(|(i, m)| if i % 2 == 0 { format!("{}._{m}", i / 2 + 1) } else { format!("{}...{m}", i.div_ceil(2)) })
        .collect::<Vec<_>>()
        .join("/")
}

/// "a\nb" (literal backslash-n in the file) -> paragraphs.
fn paragraphs(text: &str) -> Vec<String> {
    text.split("\\n").map(str::trim).filter(|p| !p.is_empty()).map(String::from).collect()
}

fn table() -> &'static HashMap<String, Entry> {
    static TABLE: OnceLock<HashMap<String, Entry>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let de: HashMap<&str, &str> = DE
            .lines()
            .filter_map(|l| {
                let mut c = l.splitn(3, '\t');
                let (path, _rev, text) = (c.next()?, c.next()?, c.next()?);
                Some((path, text))
            })
            .collect();
        let mut map: HashMap<String, Entry> = HashMap::new();
        for line in EN.lines() {
            let mut c = line.splitn(3, '\t');
            let (Some(path), Some(_rev), Some(text)) = (c.next(), c.next(), c.next()) else { continue };
            let Some(pos) = play_san_line(path.split(' ')) else { continue };
            // The file is sorted shortest first: keep the most direct move order.
            map.entry(epd(&pos)).or_insert_with(|| Entry {
                path: path.to_string(),
                en: text.to_string(),
                de: de.get(path).map(|t| t.to_string()),
            });
        }
        map
    })
}

/// The explanation of the position in `fen` (i.e. of the move that led there).
pub fn lookup(fen: &str) -> Option<OpeningText> {
    let pos = crate::analysis::parse_fen(fen).ok()?;
    let e = table().get(&epd(&pos))?;
    let german = !crate::i18n::en();
    let (text, untranslated) = match (&e.de, german) {
        (Some(de), true) => (de.as_str(), false),
        (None, true) => (e.en.as_str(), true),
        (_, false) => (e.en.as_str(), false),
    };
    Some(OpeningText { paragraphs: paragraphs(text), untranslated, url: format!("{WIKI}{}", page(&e.path)) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_names() {
        assert_eq!(page("e4"), "1._e4");
        assert_eq!(page("e4 c6 d4 d5"), "1._e4/1...c6/2._d4/2...d5");
    }

    #[test]
    fn texts_load_and_match_positions() {
        assert!(table().len() > 1000, "{}", table().len());
        let after_e4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        let t = lookup(after_e4).unwrap();
        assert!(!t.paragraphs.is_empty());
        assert!(t.url.ends_with("Chess_Opening_Theory/1._e4"), "{}", t.url);
        // German is the default language, and the main lines are translated.
        assert!(!t.untranslated);
        assert!(t.paragraphs.join(" ").contains("Königsbauer"), "{:?}", t.paragraphs);
        // A position no opening reaches has no text.
        assert!(lookup("4k3/8/8/8/8/8/8/4K3 w - - 0 1").is_none());
    }
}
