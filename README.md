# vault-graph — 3D Obsidian Vault Graph (Jarvis HUD)

A 3D force-directed graph of your Obsidian vault with a Jarvis/Iron-Man style
translucent blue HUD. Zoom, rotate, pan, search, filter, inspect.

## Run

```
./run.sh
```

or directly: `python3 server.py` (stdlib only — no dependencies).

Then open **http://localhost:8777**

## Controls

| Input | Action |
|---|---|
| Left-drag | Rotate |
| Right-drag / middle-drag | Pan |
| Wheel / pinch | Zoom |
| Click node | Inspect (linked notes, tags) + **OPEN** shows note content in a draggable, resizable modal |
| Search box | Fuzzy filter — hides all unrelated nodes; empty = all |
| FOLDERS panel | Multi-select to isolate folders (empty = all) |
| LBL | Toggle labels for hub nodes (degree ≥ 10) |
| REHEAT / SYNC | Re-run simulation / re-scan vault from disk |
| Gear icon (top right) | FORCES panel: center / repel / link force / link distance + DEPTH OF CONNECTION + DISPLAY sliders |
| Folder / image icons (top right) | Collapse or show FOLDERS / INSPECT panels |

Graph physics: forces settle over ~10s into a **gentle perpetual drift** (never fully frozen — like Obsidian's live graph). Sliders hold the layout at full force while you drag, then it re-settles. Settings persist in localStorage.

## FORCES panel

- **CENTER / REPEL / LINK FORCE / LINK DISTANCE** — same semantics as Obsidian's graph settings; layout re-runs live while you drag.
- **DEPTH OF CONNECTION** — select a node, then set levels 1–6: shows only nodes within N links of the selection (0 = off).
- **DISPLAY** — label fade by distance-to-viewer (closer = brighter), node size, link thickness.

Buttons: FIT (reframe), SYNC (re-scan vault — picks up new/edited notes live).

## Configuration

Env vars (optional):
- `VAULT_GRAPH_VAULT` — vault path (default: second-brain-v2)
- `VAULT_GRAPH_PORT` — port (default: 8777)
- `VAULT_GRAPH_HOST` — bind address (default `0.0.0.0` = open to LAN so iPhone/other devices on Wi-Fi can load `http://<mac-ip>:8777`; set `127.0.0.1` to restrict to this machine)

## Endpoints

- `GET /` — the app
- `GET /graph.json` — nodes + links + folders as JSON
- `GET /api/refresh` — force a vault re-scan

## Files

- `server.py` — stdlib HTTP server + vault scraper (wikilinks, tags, folders)
- `index.html` / `styles.css` / `app.js` — HUD + 3D scene (Three.js from CDN)
- `.venv/` — dev-only venv used for headless testing (not needed to run)

## Notes

- Unresolved (broken) wikilinks are skipped, matching Obsidian's graph behavior.
- Node color = folder hue; node size = link degree; the vault `index` hub will dominate — that's real data, not a bug.
- `obsidian://` URL scheme can't be triggered from a fetch; use the INSPECT
  panel button — it routes through the server so the browser can hand off.