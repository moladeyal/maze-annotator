"""End-to-end UI test with headless chromium. Run:  .venv/bin/python test/ui_smoke.py /path/to/scan.jpg
Starts its own server on a temp projects dir, so real projects are untouched."""
import json, os, subprocess, sys, tempfile, time, shutil, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
scan = sys.argv[1]
tmp = tempfile.mkdtemp()
env = dict(os.environ, MAZE_PROJECTS=tmp + "/projects", MAZE_DIST=tmp + "/dist")
srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"), "--port", "8124"], env=env, cwd=ROOT,
                       stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
time.sleep(2)
URL = "http://127.0.0.1:8124/"
errs, fails = [], []
def check(c, m):
    print(("PASS " if c else "FAIL ") + m)
    if not c: fails.append(m)
def api(path): return json.load(urllib.request.urlopen(URL.rstrip("/") + path))

PIXJS = """()=>{const S=window.__S,cv=document.querySelector('#cv'),ctx=cv.getContext('2d');
 const sx=cv.width/cv.clientWidth, sy=cv.height/cv.clientHeight, c=S.crop;
 const H={nw:[c.x,c.y],n:[c.x+c.w/2,c.y],ne:[c.x+c.w,c.y],e:[c.x+c.w,c.y+c.h/2],se:[c.x+c.w,c.y+c.h],s:[c.x+c.w/2,c.y+c.h],sw:[c.x,c.y+c.h],w:[c.x,c.y+c.h/2]};
 const out={bitmap:[cv.width,cv.height],css:[cv.clientWidth,cv.clientHeight],dpr:devicePixelRatio,handles:{}};
 for(const [n,[x,y]] of Object.entries(H)){const px=Math.round((x*S.view.k+S.view.ox)*sx),py=Math.round((y*S.view.k+S.view.oy)*sy);
  const d=ctx.getImageData(Math.max(0,px-1),Math.max(0,py-1),3,3).data; let yellow=0;
  for(let i=0;i<d.length;i+=4) if(d[i]>200&&d[i+1]>170&&d[i+2]<120) yellow++;
  out.handles[n]=yellow>0;}
 return out;}"""

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1500, "height": 900})
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("dialog", lambda d: d.accept(DLG.pop(0) if DLG else None))
        DLG = ["smoke"]
        pg.goto(URL); pg.wait_for_selector("#cv")
        S = lambda expr: pg.evaluate("() => { const S = window.__S; return " + expr + "; }")

        # ---- upload + step 1
        pg.set_input_files("#file", scan)
        pg.wait_for_function("window.__S && window.__S.project && window.__S.stage==='detect' && window.__S.preview", timeout=60000)
        check(S("S.project.scan_size[0]") > 0, "project created, scan loaded: %s" % S("S.project.scan_size"))
        n0 = S("S.preview.lines.length"); check(n0 > 50, "initial detection found lines: %d" % n0)
        def pix_ok(label):
            r = pg.evaluate(PIXJS); bad = [n for n, v in r["handles"].items() if not v]
            check(not bad and r["bitmap"][0] == round(r["css"][0] * r["dpr"]) and r["bitmap"][1] == round(r["css"][1] * r["dpr"]),
                  "%s: canvas bitmap matches its size and crop handles are drawn where they are hit-tested (bad: %s; bitmap %s vs css %s)" % (label, bad or "none", r["bitmap"], r["css"]))
        pix_ok("step 1 after load")
        box0 = pg.locator("#cv").bounding_box()
        for hname in ["nw", "n", "ne", "e", "se", "s", "sw", "w"]:   # real mouse drag of each of the 8 handles from the full-image default crop
            pg.evaluate("() => { const [W, H] = window.__S.project.scan_size; window.__S.crop = { x: 0, y: 0, w: W, h: H }; }")
            hx, hy = S("(()=>{const c=S.crop,m={nw:[c.x,c.y],n:[c.x+c.w/2,c.y],ne:[c.x+c.w,c.y],e:[c.x+c.w,c.y+c.h/2],se:[c.x+c.w,c.y+c.h],s:[c.x+c.w/2,c.y+c.h],sw:[c.x,c.y+c.h],w:[c.x,c.y+c.h/2]}['%s'];return [m[0]*S.view.k+S.view.ox,m[1]*S.view.k+S.view.oy]})()" % hname)
            c0 = S("({...S.crop})")
            pg.mouse.move(box0["x"] + hx, box0["y"] + hy); pg.mouse.down()
            pg.mouse.move(box0["x"] + hx + (-45 if "e" in hname else 45 if "w" in hname else 0), box0["y"] + hy + (-45 if "s" in hname else 45 if "n" in hname else 0), steps=5); pg.mouse.up()
            c1 = S("({...S.crop})")
            resized = (c1["w"] != c0["w"] or c1["h"] != c0["h"]) and not (c1["x"] != c0["x"] and c1["w"] == c0["w"] and "w" not in hname)
            check(resized, "handle '%s' resizes the crop instead of moving it (%s -> %s)" % (hname, c0, c1))
        pg.evaluate("() => { const [W, H] = window.__S.project.scan_size; window.__S.crop = { x: 0, y: 0, w: W, h: H }; }")
        # ---- rotation (the copy gets rotated; scan.jpg is untouched)
        w_b, h_b = S("S.project.scan_size")
        pg.click("#rotR"); pg.wait_for_function("window.__S.project.rotation.q===1 && window.__S.project.scan_size[0]===%d && !window.__S.detecting && window.__S.preview" % h_b, timeout=40000)
        check(S("S.project.scan_size") == [h_b, w_b], "rotate 90 deg swaps the dimensions: %s" % S("S.project.scan_size"))
        check(S("S.crop.w") == h_b and S("S.img.naturalWidth") == h_b, "crop reset to the full rotated image and the new image is shown")
        pg.evaluate("() => { const e = document.querySelector('#p_rot'); e.value = 4; e.dispatchEvent(new Event('input')); }")
        pg.wait_for_function("window.__S.project.rotation.a===4 && !window.__S.detecting && window.__S.preview", timeout=40000)
        check(S("S.project.scan_size[0]") > h_b, "straighten by 4 deg grows the canvas to fit: %s" % S("S.project.scan_size"))
        orig = api("/p/smoke/scan.jpg") if False else None
        pg.click("#rotReset"); pg.wait_for_function("window.__S.project.rotation.q===0 && window.__S.project.rotation.a===0 && window.__S.project.scan_size[0]===%d && !window.__S.detecting && window.__S.preview" % w_b, timeout=40000)
        check(S("S.project.scan_size") == [w_b, h_b], "reset restores the original size")
        # drag the crop's south-east corner inward with the mouse
        box = pg.locator("#cv").bounding_box()
        sx, sy = S("(()=>{const c=S.crop;return [(c.x+c.w)*S.view.k+S.view.ox,(c.y+c.h)*S.view.k+S.view.oy]})()")
        w0 = S("S.crop.w")
        pg.mouse.move(box["x"] + sx, box["y"] + sy); pg.mouse.down(); pg.mouse.move(box["x"] + sx - 120, box["y"] + sy - 90, steps=6); pg.mouse.up()
        check(S("S.crop.w") < w0, "dragging the crop corner shrinks the crop (%d -> %d)" % (w0, S("S.crop.w")))
        # grab the RIGHT edge away from its midpoint handle; type exact numbers; resize the window
        pg.evaluate("() => { const [W, H] = window.__S.project.scan_size; window.__S.crop = { x: 0, y: 0, w: W, h: H }; }")
        ex, ey = S("(()=>{const c=S.crop;return [(c.x+c.w)*S.view.k+S.view.ox,(c.y+c.h*0.2)*S.view.k+S.view.oy]})()")
        wfull = S("S.crop.w")
        pg.mouse.move(box["x"] + ex, box["y"] + ey); pg.mouse.down(); pg.mouse.move(box["x"] + ex - 60, box["y"] + ey, steps=5); pg.mouse.up()
        check(S("S.crop.w") < wfull and S("S.crop.h") == S("S.project.scan_size[1]"), "the right edge can be grabbed anywhere along it (w %d -> %d)" % (wfull, S("S.crop.w")))
        pg.fill("#c_w", "2000"); pg.wait_for_function("window.__S.crop.w===2000", timeout=5000)
        check(S("S.crop.w") == 2000, "numeric crop field works")
        pg.click("#fitcrop")
        for vw, vh in ((1000, 650), (1700, 1000)):
            pg.set_viewport_size({"width": vw, "height": vh}); time.sleep(0.4)
            r = S("(()=>{const c=S.crop,cv=document.querySelector('#cv');return [(c.x+c.w)*S.view.k+S.view.ox<=cv.clientWidth,(c.y+c.h)*S.view.k+S.view.oy<=cv.clientHeight,(c.x)*S.view.k+S.view.ox>=0,c.y*S.view.k+S.view.oy>=0]})()")
            check(all(r), "after resizing the window to %dx%d every crop handle is still on screen" % (vw, vh))
        pg.set_viewport_size({"width": 1500, "height": 900}); time.sleep(0.4)
        box = pg.locator("#cv").bounding_box()
        pg.mouse.move(box["x"] + 10, box["y"] + 10)
        # also pull the NW corner in to cut the page border
        nx, ny = S("(()=>{const c=S.crop;return [c.x*S.view.k+S.view.ox,c.y*S.view.k+S.view.oy]})()")
        pg.mouse.move(box["x"] + nx, box["y"] + ny); pg.mouse.down(); pg.mouse.move(box["x"] + nx + 80, box["y"] + ny + 60, steps=6); pg.mouse.up()
        pg.wait_for_function("window.__S.preview && window.__S.preview.crop.w === window.__S.crop.w", timeout=30000)
        n1 = S("S.preview.lines.length")
        pg.evaluate("() => { const e = document.querySelector('#p_th'); e.value = 0.2; e.dispatchEvent(new Event('input')); }")
        pg.wait_for_function("window.__S.params.threshold===0.2 && !window.__S.detecting && window.__S.preview.lines.length !== %d" % n1, timeout=30000)
        n2 = S("S.preview.lines.length"); check(n2 != n1, "sensitivity slider re-runs detection (%d -> %d lines)" % (n1, n2))
        pg.evaluate("() => { const e = document.querySelector('#p_th'); e.value = 0.12; e.dispatchEvent(new Event('input')); }")
        pg.wait_for_function("window.__S.params.threshold===0.12 && !window.__S.detecting && window.__S.preview.lines.length > 0", timeout=30000)
        pg.screenshot(path=tmp + "/step1.png")
        shutil.copy(tmp + "/step1.png", "/tmp/ui_step1.png")

        # ---- accept -> step 2
        pg.click("#accept"); pg.wait_for_function("window.__S.stage==='edit'", timeout=60000)
        L0 = S("S.ann.lines.length"); check(L0 > 50, "accepted, annotating with %d lines" % L0)
        time.sleep(0.6); box = pg.locator("#cv").bounding_box()   # step 2 shows the tools column, which shifts the canvas: re-measure
        pg.click("#tipsBtn")
        tips = pg.inner_text("#tips")
        check(pg.is_visible("#tips") and "Erase the circle" in tips and "bigger" in tips and "mouse pointer" in tips and "in-tunnel side" in tips, "Tips popup opens and has the circle/portal tip and the 'hero starts at the pointer' tip")
        pg.keyboard.press("Escape"); check(not pg.is_visible("#tips"), "Esc closes the Tips popup")
        pg.keyboard.press("Shift+Slash"); check(pg.is_visible("#tips"), "? opens the Tips popup"); pg.click("#tipsClose"); check(not pg.is_visible("#tips"), "close button works")
        k, ox, oy = S("S.view.k"), S("S.view.ox"), S("S.view.oy")
        W, H = S("S.ann.image.w"), S("S.ann.image.h")
        scr = lambda x, y: (box["x"] + x * k + ox, box["y"] + y * k + oy)

        # ---- eraser: drag across the middle of the picture
        pg.keyboard.press("e"); check(S("S.tool") == "eraser", "E selects the eraser")
        pg.evaluate("() => { window.__S.opts.eraser = 40; }")
        pg.mouse.move(*scr(W * 0.1, H * 0.5)); pg.mouse.down()
        for i in range(1, 21): pg.mouse.move(*scr(W * (0.1 + 0.04 * i), H * 0.5), steps=2)
        pg.mouse.up()
        L1 = S("S.ann.lines.length"); lens1 = S("S.ann.lines.reduce((s,l)=>s+l.pts.length,0)")
        check(L1 != L0 or lens1 > 0, "eraser changed lines (%d -> %d)" % (L0, L1))
        gone = S("S.ann.lines.every(l=>l.pts.every(p=>!(Math.abs(p[1]-%f)<30 && p[0]>%f && p[0]<%f)))" % (H * 0.5, W * 0.15, W * 0.85))
        check(gone, "no line points remain inside the erased band")
        pg.keyboard.press("Control+z")
        check(S("S.ann.lines.length") == L0, "undo restores the erased lines (%d)" % S("S.ann.lines.length"))
        pg.keyboard.press("Control+Shift+z")
        check(S("S.ann.lines.length") == L1, "redo re-applies it")
        pg.keyboard.press("Control+z")

        # ---- draw a line (freehand)
        pg.keyboard.press("d"); pg.mouse.move(*scr(100, 100)); pg.mouse.down(); pg.mouse.move(*scr(300, 160), steps=10); pg.mouse.move(*scr(420, 100), steps=10); pg.mouse.up()
        check(S("S.ann.lines.filter(l=>l.src==='drawn').length") == 1, "freehand draw adds one 'drawn' line")

        # ---- regions: polygon, ellipse, thin polygon
        pg.keyboard.press("r"); DLG[:] = ["start"]
        for x, y in [(200, 600), (300, 600), (300, 700), (200, 700)]:
            pg.mouse.click(*scr(x, y))
        pg.mouse.dblclick(*scr(200, 700))
        check(S("S.ann.regions.length") == 1 and S("S.ann.regions[0].name") == "start", "polygon region named 'start' (pts=%s)" % S("S.ann.regions[0] && S.ann.regions[0].pts.length"))
        pg.evaluate("() => { window.__S.opts.region='ellipse'; }"); DLG[:] = ["water"]
        pg.mouse.move(*scr(500, 500)); pg.mouse.down(); pg.mouse.move(*scr(640, 600), steps=8); pg.mouse.up()
        check(S("S.ann.regions.length") == 2 and S("S.ann.regions[1].shape") == "ellipse", "ellipse region 'water'")
        pg.evaluate("() => { window.__S.opts.region='polygon'; }"); DLG[:] = ["gateB"]
        for x, y in [(900, 800), (903, 800), (903, 840), (900, 840)]: pg.mouse.click(*scr(x, y))
        pg.keyboard.press("Enter")
        check(S("S.ann.regions.length") == 3, "thin polygon region closed with Enter")

        # ---- select/move, portal, direction toggle
        pg.keyboard.press("v"); r1 = S("S.ann.regions[1].cx")
        pg.mouse.move(*scr(570, 550)); pg.mouse.down(); pg.mouse.move(*scr(600, 550), steps=5); pg.mouse.up()
        check(abs(S("S.ann.regions[1].cx") - r1 - 30) < 3, "select+drag moves a region by the drag distance (%.1f)" % (S("S.ann.regions[1].cx") - r1))
        pg.keyboard.press("t")
        pg.mouse.click(*scr(250, 650)); pg.mouse.click(*scr(901.5, 820))   # start -> gateB (thin: found by proximity)
        check(S("S.ann.portals.length") == 1 and S("S.ann.portals[0].dir") == "both", "portal start<->gateB created, bidirectional")
        pg.click("[data-dir]"); check(S("S.ann.portals[0].dir") == "ab", "portal direction toggles to a->b")
        pg.click("[data-dir]"); pg.click("[data-dir]"); check(S("S.ann.portals[0].dir") == "both", "...and cycles back to both")

        pg.click("[data-dash]"); check(S("S.ann.portals[0].dashed") is True, "the dashed-line toggle on a portal turns on")
        pg.click("[data-dash]"); check(S("S.ann.portals[0].dashed") is None, "...and off again (flag removed)")
        pg.click("[data-dash]")
        # ---- layers
        pg.uncheck("[data-l=auto]"); check(S("S.layers.auto") is False, "layer toggle works")
        pg.check("[data-l=auto]")
        pg.screenshot(path="/tmp/ui_step2.png")

        # ---- playtest
        pg.keyboard.press("p"); check(S("!!S.play"), "P starts playtest")
        hx0, hy0 = S("S.play.hero.x"), S("S.play.hero.y")
        check(abs(hx0 - 250) < 120 and abs(hy0 - 650) < 120, "hero starts in region 'start' (%.0f,%.0f)" % (hx0, hy0))
        pg.keyboard.down("ArrowRight"); pg.keyboard.down("ArrowDown"); time.sleep(0.8); pg.keyboard.up("ArrowRight"); pg.keyboard.up("ArrowDown")
        moved = abs(S("S.play.hero.x") - hx0) + abs(S("S.play.hero.y") - hy0)
        check(moved > 5, "hero moves with arrows incl. diagonal (%.0f px)" % moved)
        check(S("MazeCore.walkable(S.play.field,S.play.hero.x,S.play.hero.y,S.play.hero.r)"), "hero stays on walkable ground")
        pg.keyboard.press("Escape"); check(S("!S.play"), "Esc stops playtest")
        # no region called 'start': the hero begins where the mouse pointer was, also when started from the Play button
        pg.evaluate("() => { window.__S.ann.regions[0].name = 'start_tmp'; }")
        for how in ("P key", "Play button"):
            pg.mouse.move(*scr(hx0, hy0)); time.sleep(0.1)
            if how == "P key": pg.keyboard.press("p")
            else: pg.click("#play")
            hxx, hyy = S("S.play ? [S.play.hero.x, S.play.hero.y] : [-1,-1]")
            check(abs(hxx - hx0) < 12 and abs(hyy - hy0) < 12, "%s starts the hero at the pointer (%.0f,%.0f vs %.0f,%.0f)" % (how, hxx, hyy, hx0, hy0))
            pg.keyboard.press("Escape")
        pg.evaluate("() => { window.__S.ann.regions[0].name = 'start'; }")

        # ---- persistence (autosave)
        time.sleep(1.2)
        saved = api("/api/project/smoke")["annotations"]
        check(len(saved["regions"]) == 3 and len(saved["portals"]) == 1 and any(l["src"] == "drawn" for l in saved["lines"]),
              "autosave persisted regions/portals/drawn line (%d lines)" % len(saved["lines"]))
        pg2 = b.new_page(viewport={"width": 1500, "height": 900}); pg2.goto(URL)
        pg2.wait_for_function("window.__S && window.__S.stage==='edit' && window.__S.ann", timeout=30000)
        check(pg2.evaluate("() => window.__S.ann.regions.length") == 3, "reloading the page restores the project")

        # ---- export + run exported game
        pg.click("#export")  # alert is auto-accepted
        time.sleep(0.5)
        out = tmp + "/dist/smoke"
        check(all(os.path.exists(out + "/" + f) for f in ("index.html", "game-core.js", "work.jpg", "annotations.json")), "export wrote a static game folder")
        gsrv = subprocess.Popen([sys.executable, "-m", "http.server", "8125", "--bind", "127.0.0.1"], cwd=out, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        pg3 = b.new_page(viewport={"width": 1200, "height": 800}); pg3.on("pageerror", lambda e: errs.append("game: " + str(e)))
        pg3.goto("http://127.0.0.1:8125/index.html"); time.sleep(1.5)
        pg3.keyboard.down("ArrowRight"); time.sleep(0.5); pg3.keyboard.up("ArrowRight")
        pg3.screenshot(path="/tmp/ui_game.png"); gsrv.terminate()
        # returning to step 1 from step 2 changes the layout again (tools column hides): handles must still line up
        pg.click("#redetect"); pg.wait_for_function("window.__S.stage==='detect'", timeout=20000); time.sleep(0.6)
        pix_ok("step 1 after coming back from step 2")
        b.close()
    check(not errs, "no console/page errors: %s" % errs[:3])
finally:
    srv.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print("FAILED: %d" % len(fails) if fails else "ALL UI CHECKS PASSED")
sys.exit(1 if fails else 0)
