<p align="center">
  <img src="assets/app-icon/icon.png" alt="postmortem" width="128" height="128">
</p>

<h1 align="center">postmortem</h1>

<p align="center">
  Analysiere deine Schachpartien von <b>Lichess</b> und <b>chess.com</b> – lokal, offline, mit Stockfish.<br>
  <sub>Review your Lichess and chess.com games locally with Stockfish – a free, offline game review (German and English UI).</sub>
</p>

---

postmortem ist eine Desktop-App für Linux und Windows, die deine Partien so auswertet,
wie du es von der „Partie-Review“ bei chess.com kennst: Jeder Zug bekommt eine
Bewertung von *Brillant* bis *Patzer*, und ein Coach erklärt in normalen Worten,
**warum** ein Zug schlecht war – „Das erlaubt eine Gabel“, „Dein Läufer auf c4 hängt“,
„Du hattest Matt in 2“. Darauf aufbauend findest du deine typischen Schwächen und
trainierst sie gezielt mit Puzzles und Eröffnungsübungen.

Alles läuft auf deinem Rechner. Kein Konto, kein Abo, keine Limits.

Die Oberfläche gibt es auf Deutsch und Englisch (Zahnrad → *Sprache · Language*).

## Funktionen

**Partie-Review**
- Partien per Lichess- oder chess.com-Name laden (oder einen Lichess-Partielink einfügen)
- **Eigene Partien einspielen:** PGN einfügen oder als Datei öffnen (+ über der Partieliste) –
  Turnierpartien, Partien von anderen Seiten oder ein ganzer Export; sie erscheinen unter „Eigene“
- Partie als PGN und Stellung als FEN kopieren
- Bedenkzeit: Restzeit an den Spielern und Zeit pro Zug (wenn Lichess / chess.com / die PGN sie enthält)
- Bewertung jedes Zugs: Brillant, Stark, Bester Zug, Ausgezeichnet, Gut, Theorie,
  Ungenauigkeit, Fehler, Verpasste Chance, Patzer – plus Genauigkeit pro Spieler
- Coach-Kommentare auf Deutsch oder Englisch, Bewertungsbalken, Bewertungsverlauf, bester Zug als Pfeil
- Auch Lob: der Coach merkt an, wenn ein guter Zug die Entwicklung abschließt oder rochiert (nicht bei Theoriezügen)
- **Zeig mir, was passiert:** spielt die Widerlegung eines Fehlers auf dem Brett vor
- Frei weiterziehen: eigene Varianten, jeder Zug wird bewertet; Live-Engine mit den 3 besten Zügen
- **Aus Fehlern lernen:** deine Fehler einer Partie als Übungsaufgaben
- Pfeile und Kreise mit der rechten Maustaste, wie auf Lichess
- Brettfarben und 9 Figurensätze wählbar, Klänge beim Ziehen, Schlagen und Aufstellen –
  direkt über die Soundkarte, mit Sound-Diagnose im Zahnrad-Menü

**Statistik**
- Deine Schwächen nach Ursache (Figur hängen lassen, Gabel zugelassen, Matt übersehen …)
  mit Beispielen und Trainingstipps, Fehler nach Spielphase und nach Bedenkzeit (Zeitnot),
  Genauigkeitsverlauf
- **Werden deine Fehler weniger?** Fehler pro Partie und deine häufigsten Schwächen im Verlauf
  (Blöcke zu je mindestens 5 analysierten Partien)
- Neue Partien werden nach dem Synchronisieren automatisch im Hintergrund analysiert (abschaltbar)
- Zeitraum wählbar (letzte 10 / 20 / 50 / alle Partien) mit Trend gegenüber deinem Schnitt
- **Wertung und Aktivität:** deine Wertung nach jeder gewerteten Partie (pro Plattform und
  Bedenkzeit, 3 Monate / 1 Jahr / alles) und deine Partien pro Woche bzw. Monat mit S/R/N
- **Hier verlässt du die Theorie:** Stellungen, in denen du immer wieder als Erster die bekannten
  Eröffnungslinien verlässt – mit den bekannten Fortsetzungen und ob dich die Abweichung etwas kostet
- Deine Eröffnungen: Ergebnis und wie oft du in der Eröffnung patzt
- „Partien analysieren“ läuft im Hintergrund

**Puzzles**
- Die komplette Lichess-Puzzle-Datenbank (≈ 6 Mio. Puzzles), lokal und offline
- Auswahl passend zu dir: ca. 60 % deine Schwächen, 25 % gemischt, 15 % Stellungen aus
  deinen eigenen Partien – was du sicher löst, kommt seltener
- Eigene Puzzle-Wertung, Tipps, „Zeig mir, was passiert“, nach dem Lösen frei weiterspielen,
  Züge vor- und zurückgehen, Puzzle wiederholen

**Spielen**
- Gegen Stockfish in 8 Stufen (~800 bis ~2800 Elo), mit oder ohne Bedenkzeit,
  Zug zurücknehmen, Aufgeben
- Nach der Partie mit einem Klick in die Review; Bot-Partien erscheinen in der
  Partieliste unter „Eigene“ und zählen dort (und unter „Alle“) in der Statistik

**Eröffnungen**
- Startseite mit der Frage „Was möchtest du tun?“: **Neue Eröffnung lernen**, **Wiederholen**
  (die heute fälligen Karten) oder **Fehler aus deinen Partien** üben – darunter deine
  Eröffnungen mit ihrem Lernstand
- Alle 149 Eröffnungen als Kacheln mit Brett-Vorschau; als Weiß oder Schwarz lernen
- **Geführte Lektion:** Zug für Zug – „Weiter“ zeigt den Zug des Gegners, deine eigenen Züge
  spielst du nach dem grünen Pfeil; zu jedem Zug die passende Erklärung
- **Erklärungen zu jedem Zug** aus dem Wikibooks-Buch „Chess Opening Theory“ (Hauptvarianten bis
  zum 3. Zug ins Deutsche übersetzt, tiefere Stellungen auf Englisch)
- **Karteikasten mit 5 Fächern:** Variante festigen, bis sie zweimal sitzt, dann Wiederholung nach
  10 Min., 1, 3, 7 und 21 Tagen; ein Fehler schickt sie zurück in Fach 1. „Zurück“ und
  „Mit Pfeilen neu lernen“, wenn eine Variante vergessen ist
- Varianten einzeln wählbar, Hauptvariante zuerst; kurze Theorie-Linien werden mit Stockfish
  auf mindestens 8 eigene Züge verlängert
- **Frei spielen:** eine Eröffnung frei durchspielen und bei jedem Zug sehen, was kommen kann –
  aus deinen eigenen Partien (wie oft, wie ausgegangen), der Theorie und, mit eigenem
  Lichess-Schlüssel, wie oft der Zug auf Lichess in deiner Spielstärke gespielt wird.
  Wahlweise zieht der Gegner nach Häufigkeit, Stockfish bewertet die Kandidaten

## Installation

### Windows

1. Unter [Releases](https://github.com/event173/postmortem/releases) die Datei
   `postmortem_…_x64-setup.exe` (oder `.msi`) herunterladen und ausführen.
2. Beim ersten Start meldet Windows evtl. *„Der Computer wurde durch Windows geschützt“* –
   die App ist nicht kostenpflichtig signiert. Auf **Weitere Informationen → Trotzdem ausführen** klicken.

Stockfish ist enthalten. **Deinstallieren:** *Einstellungen → Apps → postmortem → Deinstallieren*.

### Linux

Aus den [Releases](https://github.com/event173/postmortem/releases):

- **Flatpak** (empfohlen – läuft auf jeder Distribution, bringt alles mit):
  `flatpak install --user postmortem_*_x86_64.flatpak` oder per Doppelklick im Software-Center.
  Die GNOME-Laufzeitumgebung wird dabei automatisch von Flathub geladen.
- **.deb** (Debian, Ubuntu, Mint …): `sudo apt install ./postmortem_*_amd64.deb` –
  mit `apt`, nicht `dpkg -i`, damit die Abhängigkeiten mitinstalliert werden.
- **AppImage**: herunterladen, ausführbar machen (`chmod +x postmortem_*.AppImage`), starten.

In allen Paketen ist Stockfish enthalten. Wird es nicht gefunden, kannst du im
Zahnrad-Menü einen eigenen Pfad angeben oder es installieren (`sudo apt install stockfish`).

## Erste Schritte

1. **Namen eingeben:** In der Partieliste „Lichess“ oder „chess.com“ wählen, Benutzernamen eingeben,
   *Laden*. Deine letzten Partien erscheinen links; neue werden bei jedem Start nachgeladen.
2. **Partie anklicken:** Nach wenigen Sekunden steht eine schnelle Analyse (Tiefe 10), die du
   sofort durchgehen kannst. Auf Wunsch (*Tief analysieren*) wird im Hintergrund auf die
   eingestellte Tiefe verfeinert und still ausgetauscht. Die Analyse wird gespeichert – beim
   nächsten Mal ist sie sofort da.
3. **Statistik:** Unter *Statistik → „… Partien analysieren“* werden deine übrigen Partien im
   Hintergrund ausgewertet. Je mehr analysiert sind, desto aussagekräftiger.
4. **Puzzles:** Einmalig im **Zahnrad-Menü** die Puzzle-Datenbank herunterladen (≈ 300 MB).
   Die App meldet sich, wenn Lichess eine neue Version hat.
5. **Eröffnungen:** Unter *Eröffnungen → Neue Eröffnung lernen* eine Eröffnung aussuchen und
   als Weiß oder Schwarz lernen. Fällige Karten findest du später unter *Wiederholen*.
6. **Lichess-Häufigkeiten (optional):** Für *Frei spielen* im Zahnrad-Menü unter
   „Lichess-Eröffnungsdatenbank“ einen persönlichen Lichess-Schlüssel eintragen –
   **ohne Häkchen** erstellen, er braucht keine Rechte. Die Anleitung steht dort.

### Tastenkürzel

| Taste | Aktion |
| --- | --- |
| ← / → | Zug zurück / vor |
| Pos1 / Ende | Anfang / Ende der Partie |
| N | zum nächsten eigenen Fehler (spielt die Züge bis dahin ab) |
| T | Aus Fehlern lernen |
| F | Brett drehen |
| Esc | Variante verlassen / Übung beenden |
| Enter | nächstes Puzzle / nächste Aufgabe |
| → / Enter | Eröffnungs-Lektion: weiter zum nächsten Zug |
| ← | Eröffnungen: deinen letzten Zug zurücknehmen |
| Rechtsklick ziehen | Pfeil zeichnen (Shift/Strg = rot, Alt = blau) |

## Gut zu wissen

**Fair Play.** postmortem analysiert nur beendete Partien. Laufende Partien – per
Lichess-Link oder als PGN eingespielt, z. B. eine chess.com-Fernpartie – werden abgelehnt:
Engine-Hilfe während einer Partie verstößt gegen die Regeln von Lichess und chess.com und
kann zur Sperre führen.

**Wie bewertet wird.** Jede Engine-Bewertung wird in Gewinnchancen (0–100 %) umgerechnet –
mit derselben Kurve wie bei Lichess. Ein Zug ist so gut, wie wenig er von deinen
Gewinnchancen kostet:

| Verlust | Bewertung |
| --- | --- |
| Zug der Engine | Bester Zug |
| < 2 % | Ausgezeichnet |
| < 5 % | Gut |
| < 10 % | Ungenauigkeit |
| < 20 % | Fehler |
| ≥ 20 % | Patzer |

Dazu: *Theorie* (laut Eröffnungsbuch), *Stark* (der einzige gute Zug), *Brillant*
(ein funktionierendes Opfer), *Verpasste Chance* (der Gegner hat gerade gepatzt oder
es gab ein Matt, und der Zug nutzt es nicht).

**Der Coach** ist kein Sprachmodell: Er erkennt anhand der Engine-Varianten konkrete
Muster (hängende Figur, Gabel, Matt, Materialverlust …) und formuliert daraus einen Satz.
Findet er keine konkrete Taktik, sagt er „Stellung verschlechtert“.

**Offline und Datenschutz.** Ins Internet geht die App nur, um deine Partien bei Lichess /
chess.com abzurufen (öffentliche APIs, ohne Anmeldung) und um die Puzzle-Datenbank
herunterzuladen bzw. auf Updates zu prüfen. Beim Start fragt sie außerdem GitHub, ob es eine
neuere postmortem-Version gibt, und zeigt dann oben einen Hinweis. Nur wenn du einen
Lichess-Schlüssel einträgst, fragt *Frei spielen* bei der Lichess-Eröffnungsdatenbank nach den
Zügen der gerade gezeigten Stellung (eine Anfrage nach der anderen, wie Lichess es verlangt).
Der Schlüssel bleibt in der lokalen Datenbank. Analyse, Statistik und Training passieren
lokal; es werden keine Daten an Dritte gesendet.

*Frei spielen* und die Lichess-Häufigkeiten sind wie die Analyse nur zum Üben gedacht –
nicht während einer laufenden Partie.

**Rechenzeit.** Die Analyse nutzt alle CPU-Kerne bis auf einen, Hintergrund-Analysen die
Hälfte, und Stockfish läuft mit niedriger Priorität – der Rechner bleibt bedienbar.
Analyse-Tiefe und Kernzahl lassen sich im Zahnrad-Menü einstellen.

**Wo die Daten liegen** (Partien, Analysen, Puzzle-Datenbank, Lernstand):

| System | Ordner |
| --- | --- |
| Linux | `~/.local/share/io.github.event173.postmortem/` |
| Linux (Flatpak) | `~/.var/app/io.github.event173.postmortem/data/io.github.event173.postmortem/` |
| Windows | `%APPDATA%\io.github.event173.postmortem\` |

Die Puzzle-Datenbank (≈ 1 GB) lässt sich im Zahnrad-Menü wieder löschen. Wer postmortem
komplett entfernen will, löscht nach der Deinstallation zusätzlich diesen Ordner.

## Selbst bauen

Voraussetzungen: [Rust](https://rustup.rs), Node.js ≥ 20 und unter Linux die
WebKitGTK-Pakete:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libasound2-dev stockfish
```

```sh
git clone https://github.com/event173/postmortem.git
cd postmortem
npm install
npm run tauri dev                 # starten (Entwicklung)
npm run tauri build               # Installationspakete bauen

cd src-tauri && cargo test        # Tests
cargo test -- --ignored           # Live-Tests gegen Lichess/chess.com (Netzwerk)
```

**Flatpak** (GNOME-51-Laufzeit; Stockfish 19 wird aus dem Quellcode gebaut):

```sh
flatpak install --user flathub org.flatpak.Builder org.gnome.Platform//51 org.gnome.Sdk//51
npm run tauri build -- --bundles deb
flatpak run org.flatpak.Builder --user --install --force-clean \
  --state-dir ~/.cache/postmortem-flatpak/state \
  ~/.cache/postmortem-flatpak/build packaging/flatpak/io.github.event173.postmortem.yml
flatpak run io.github.event173.postmortem
```

**Releases:** Ein Versions-Tag (`git tag v0.2.0 && git push origin v0.2.0`) startet
`.github/workflows/release.yml`; GitHub baut Windows-Installer, AppImage, .deb und Flatpak mit
Stockfish und legt einen Release-Entwurf an. Der Text aus `packaging/release-notes/<tag>.md`
steht oben im Release.

**Eröffnungstexte aktualisieren:** `node scripts/fetch-opening-texts.mjs` holt die englischen
Wikibooks-Texte neu nach `src-tauri/data/opening-texts/en.tsv`; die deutschen Übersetzungen in
`de.tsv` bleiben unberührt.

### Aufbau

| Pfad | Inhalt |
| --- | --- |
| `src/` | Oberfläche (TypeScript, [chessground](https://github.com/lichess-org/chessground)) |
| `src/i18n.ts`, `src/i18n-en.ts` | Sprachen: der deutsche Text ist der Schlüssel, `i18n-en.ts` die englische Übersetzung (`npm run i18n:check` findet fehlende) |
| `src-tauri/src/analysis.rs` | Klassifizierung der Züge, Genauigkeit |
| `src-tauri/src/coach.rs` | Coach: Muster erkennen, Erklärungen formulieren |
| `src-tauri/src/engine.rs`, `live.rs` | Stockfish-Anbindung (UCI) |
| `src-tauri/src/lichess.rs`, `chesscom.rs` | Partien abrufen |
| `src-tauri/src/stats.rs`, `theory.rs`, `trainer.rs` | Statistik, Theorie-Abweichungen, Puzzles |
| `src-tauri/src/repertoire.rs`, `openings.rs` | Eröffnungstraining (Karteikasten), Eröffnungsliste und -namen |
| `src-tauri/src/opening_texts.rs` | Wikibooks-Erklärungen zu den Eröffnungszügen |
| `src-tauri/src/explorer.rs` | *Frei spielen*: Züge aus deinen Partien, der Theorie und der Lichess-Eröffnungsdatenbank |
| `src-tauri/src/pgn.rs` | PGN einlesen (Import, Uhrzeiten) |
| `src-tauri/src/audio.rs` | Klänge direkt über die Soundkarte (rodio) |
| `src-tauri/src/update.rs` | Hinweis auf neue postmortem-Versionen |
| `src-tauri/src/i18n.rs` | Sprache der Meldungen und Coach-Kommentare (`tr!("Deutsch", "English")`) |
| `src-tauri/src/db.rs` | lokale SQLite-Datenbank |
| `packaging/flatpak/` | Flatpak-Manifest, Desktop-Datei, AppStream-Metadaten |

## Datenquellen

- [Lichess API](https://lichess.org/api) – deine Partien
- [Lichess-Eröffnungsdatenbank](https://lichess.org/api#tag/Opening-Explorer) – Zughäufigkeiten
  für *Frei spielen* (nur mit eigenem Lichess-Schlüssel)
- [chess.com Published-Data API](https://www.chess.com/news/view/published-data-api) – deine Partien
- [Lichess-Puzzle-Datenbank](https://database.lichess.org/#puzzles) (CC0)
- [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0) – Eröffnungsnamen und -linien
- [Wikibooks: Chess Opening Theory](https://en.wikibooks.org/wiki/Chess_Opening_Theory)
  ([CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)) – Erklärungen zu den
  Eröffnungszügen in `src-tauri/data/opening-texts/` (`en.tsv` Original, abgerufen mit
  `scripts/fetch-opening-texts.mjs`; `de.tsv` deutsche Übersetzung, ebenfalls CC BY-SA 4.0)
- [Stockfish](https://stockfishchess.org) (GPL-3.0) – die Engine
- Figurensätze aus [lichess-org/lila](https://github.com/lichess-org/lila) – nur frei
  lizenzierte (Details: `src/assets/pieces/LICENSES.md`); die Klänge sind eigene Aufnahmen
  (`src/assets/sounds/`), fehlende erzeugt die App selbst

## Lizenz

postmortem steht unter der [GPL-3.0-or-later](LICENSE). Das Brett
([chessground](https://github.com/lichess-org/chessground)) und die mitgelieferte
Engine ([Stockfish](https://stockfishchess.org)) stehen ebenfalls unter der GPL-3.0.

postmortem ist ein unabhängiges Projekt und steht in keiner Verbindung zu Lichess oder chess.com.
