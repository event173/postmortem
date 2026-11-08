# postmortem

Game review for your Lichess games – move classifications, accuracy and a
rule-based coach that explains *why* a move was bad. Runs locally: games are
pulled from the public Lichess API, analysis happens with Stockfish on your
machine.

Built with [Tauri](https://tauri.app) (Rust backend, TypeScript frontend).

## Features

- Load your recent games by Lichess username, or a single game by link
- Works offline: games and reviews are stored in a local SQLite database;
  on start only new games are synced from Lichess (older ones on demand)
- Stockfish analysis of every position (MultiPV 2), stored with the game
- Move classes: Brilliant, Great, Best, Excellent, Good, Book, Forced,
  Inaccuracy, Mistake, Miss, Blunder
- Accuracy per player (Lichess-style win% model)
- Coach comments: allowed/missed mates, forks, hanging pieces, material loss,
  missed material wins, positional fallback
- Eval bar, eval graph, best-move arrow, keyboard navigation
- Explore: drag pieces to play your own variation; every move you try is
  classified and explained like a game move
- "Aus Fehlern lernen": replay your own mistakes of a game as exercises
  (accepts any move the engine rates Excellent or better; hint / solution / skip)
- Statistics: your weaknesses by cause (hanging pieces, allowed forks,
  missed mates …) with examples, error rate per game phase, accuracy trend;
  "analyse all" runs in the background
- Live engine with the top 3 lines for whatever is on the board (click a line
  to play its first move)

## Requirements (Linux)

```sh
sudo apt install stockfish libwebkit2gtk-4.1-dev build-essential libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev
```

Plus Rust (`rustup`) and Node.js. Stockfish is looked up in `PATH`,
`/usr/games`, `/usr/bin`, `/usr/local/bin`, or via `POSTMORTEM_STOCKFISH=/path/to/stockfish`.

## Development

```sh
npm install
npm run tauri dev      # run the app
npm run tauri build    # build a release bundle (.deb / .AppImage / .rpm)

cd src-tauri
cargo test                                # unit tests
cargo test -- --ignored --nocapture       # live test: Lichess API + Stockfish
```

## Keyboard

| Key | Action |
| --- | --- |
| ← / → | previous / next move |
| Home / End | start / end |
| N | next own mistake |
| T | learn from your mistakes (Esc to quit, Enter for next) |
| Esc | leave variation, back to the game |
| F | flip board |

## How classification works

Each engine score is turned into winning chances (0–100 %) using the same
logistic curve Lichess uses. A move's quality is the drop in the mover's
winning chances:

| Loss | Class |
| --- | --- |
| engine's best move | Best |
| < 2 % | Excellent |
| < 5 % | Good |
| < 10 % | Inaccuracy |
| < 20 % | Mistake |
| ≥ 20 % | Blunder |

Special cases: **Book** (within the opening Lichess names for the game),
**Forced** (only legal move), **Great** (best move and the second-best is
≥ 20 % worse), **Brilliant** (best move that sacrifices ≥ 2 points of material
and keeps a good position), **Miss** (opponent just erred or mate was
available, and the move gives the chance away).

## License

The board uses [chessground](https://github.com/lichess-org/chessground),
which is GPL-3.0-or-later.
