# maze-annotator

A tiny local tool for turning a **photo of a hand-drawn maze** into a playable mini game.
You don't trace anything by hand: lines are detected automatically, you only *fix* them and add meaning.
Everything you do is saved as metadata on top of the original photo (`annotations.json`); the photo itself is never modified.

## Setup

```sh
python3 -m venv .venv            # if this fails (no ensurepip): python3 -m venv --without-pip .venv && curl -sS https://bootstrap.pypa.io/get-pip.py | .venv/bin/python
.venv/bin/pip install -r requirements.txt
./run.sh                         # http://127.0.0.1:8000 — localhost only
```

From your laptop (the server only listens on localhost, so tunnel to it):

```sh
ssh -L 8000:localhost:8000 user@your-dev-box     # then open http://localhost:8000
```

Your drawings live in `./projects/<name>/` and are git-ignored — they never leave the machine unless you export and publish them yourself.

## Workflow

**1 · Rotate, crop & detect.** Upload a photo (“+ New project…”). Fix its orientation with the ↺/↻ 90° buttons and the *Straighten* slider (a grid helps level the page; this works on a copy, the original photo is never changed). Then drag the yellow crop box (corners, anywhere along an edge, or the middle) or type exact numbers to cut away the page border, and tune the three sliders until the blue lines look about right:

| slider | what it does |
|---|---|
| Sensitivity | how dark a pixel must be to count as pencil (lower = fainter lines, more noise) |
| Min line length | drops short stubs and specks |
| Simplify | fewer, straighter segments (higher) vs. following the wobble (lower) |

Click **Accept lines & annotate**. (You can come back and re-detect; auto-detected lines are replaced, your regions/portals/drawn lines are kept if the crop didn't change.)

**2 · Annotate.**

| tool (key) | what it does |
|---|---|
| Select (V) | click a region to select, drag to move, Del to delete |
| Eraser (E) | circle eraser; drag over lines to cut them. `[` `]` change size |
| Line (D) | draw an extra wall, freehand or straight (click points, double-click/Enter to finish) |
| Region (R) | polygon or ellipse, then give it a name (`start`, `finish`, `water`, …). Regions **never block** the hero |
| Portal (T) | click one region, then another. The list on the right toggles the direction `↔ → ←` |
| Undo / Redo | Ctrl+Z, Ctrl+Shift+Z |
| Play (P) | playtest in place (hero starts in the region named `start`, or at your mouse) |

Lines (detected or drawn) block the hero; regions do not. A *tunnel* is simply two very thin regions across its two mouths joined by a bidirectional portal.
A portal is inactive after you land in it until you've moved out again, so you can't bounce back and forth.
Layer toggles on the right show/hide the scan, detected lines, drawn lines, regions and portals. Everything autosaves (with timestamped backups in `projects/<name>/backups/`).

The **💡 Tips** button (or `?`) opens a list of tips, e.g. how to mark a drawn circle as a portal region (erase its lines first, draw the region slightly bigger) and how the playtest picks where the hero starts.

Movement: arrows, WASD or the numpad (two keys = diagonal), or hold the mouse/finger down to walk toward it. Hero size defaults to very small.

**Export** writes a static folder `dist/<name>/` (`index.html`, `game-core.js`, `work.jpg`, `annotations.json`) that any static host can serve.

## Data (`projects/<name>/annotations.json`)

```jsonc
{
  "version": 1,
  "image": { "w": 1800, "h": 1429, "file": "work.jpg" },   // annotations use these pixel coordinates
  "crop": { "x":…, "y":…, "w":…, "h":… }, "scale": 0.53,    // how work.jpg was cut from scan.jpg
  "lines":   [ { "id": "a1", "src": "auto" | "drawn", "pts": [[x,y], …] } ],   // these block the hero
  "regions": [ { "id": "r1", "name": "start", "shape": "polygon", "pts": [[x,y], …], "props": {} },
               { "id": "r2", "name": "water", "shape": "ellipse", "cx":…, "cy":…, "rx":…, "ry":… } ],
  "portals": [ { "id": "p1", "a": "r1", "b": "r2", "dir": "both" | "ab" | "ba" } ]
}
```

Unknown extra keys are preserved when saving, so extra features can store their own data.
Game behaviour (collision, portals, movement) is in `static/game-core.js`; the page that uses it is `static/game.html`.

## Tests

```sh
node test/core.test.js                         # collision / movement / region / portal logic
.venv/bin/pip install playwright && .venv/bin/python -m playwright install chromium
.venv/bin/python test/ui_smoke.py scan.jpg     # drives the whole editor in headless chromium
```
