# App-Symbol

Lege hier **eine** Datei ab:

| Datei | Größe | Format |
|---|---|---|
| `icon.png` | **1024 × 1024 px** | PNG, quadratisch, transparenter Hintergrund |
| `icon.svg` *(optional)* | beliebig, quadratisch | SVG – wird für Linux/Flatpak bevorzugt, falls vorhanden |

Daraus erzeuge ich alle Größen automatisch (`npx tauri icon`):
32, 128, 256, 512 px, Windows `.ico` inkl. Kachel-Logos, macOS `.icns`.

Tipps:
- Das Motiv sollte auch bei **32 × 32 px** noch erkennbar sein (wenig Details, klare Form).
- Etwas Rand lassen (ca. 5–10 %), Windows/GNOME schneiden sonst Ecken ab.
