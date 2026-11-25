"""Browser test of an exported game folder.  .venv/bin/python test/game_smoke.py dist/maze1
Uses real key presses; only teleports the hero (via window.__game()) to get near a feature quickly."""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright
d = os.path.abspath(sys.argv[1]); shots = sys.argv[2] if len(sys.argv) > 2 else "/tmp"
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8130", "--bind", "127.0.0.1"], cwd=d, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
fails = []; errs = []
def check(c, m):
    print(("PASS " if c else "FAIL ") + m)
    if not c: fails.append(m)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(viewport={"width": 1300, "height": 950})
        pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto("http://127.0.0.1:8130/index.html"); pg.wait_for_function("window.__game && window.__game()", timeout=20000); time.sleep(0.5)
        G = lambda e: pg.evaluate("() => { const g = window.__game(); return " + e + "; }")
        pg.screenshot(path=shots + "/game_start.png")
        s = G("[g.hero.x, g.hero.y]"); check(abs(s[0] - 125) < 40 and abs(s[1] - 88) < 40, "hero starts in the 'start' region at the top left %s" % [round(v) for v in s])
        check(G("g.has.size") == 0 and pg.locator(".slot.full").count() == 0, "inventory slot is empty at the start")
        n_dash = G("g.portals.filter(p => p.dashed).length"); check(n_dash == 3, "exactly the 3 tunnel portals are flagged dashed (found %d)" % n_dash)
        # halo: sample a ring well outside the hero's body (3 body radii) at two moments; it must be coloured and must change as it pulses
        def ring():
            return pg.evaluate("""() => { const g = window.__game(), c = document.getElementById('c'), x = c.getContext('2d'); const R = (g.hero.r + 2.5) * 2.6; let s = 0;
              for (let a = 0; a < 6.28; a += .5) { const d = x.getImageData(Math.round(g.hero.x + R * Math.cos(a)), Math.round(g.hero.y + R * Math.sin(a)), 1, 1).data; s += d[0] - d[2]; } return s; }""")
        vals = []
        for _ in range(8): vals.append(ring()); time.sleep(0.3)
        check(max(vals) - min(vals) > 15, "the halo around the hero is visible and pulsates (ring sample varies %s)" % [round(v) for v in vals])
        check(G("g.hero.r") == 4, "hero collision radius is still 4 (halo is visual only)")
        # --- lock: no goggles -> water entrance blocks
        pg.evaluate("() => { const g = window.__game(); g.hero.x = 707; g.hero.y = 592; }")
        pg.keyboard.down("ArrowRight"); time.sleep(1.6); pg.keyboard.up("ArrowRight")
        x = G("g.hero.x"); check(739 < x < 752, "without goggles the hero is stopped at the water's edge (x=%.0f)" % x)
        check(pg.locator("#toast.on").count() == 1 and "משקפת" in pg.inner_text("#toast"), "a Hebrew hint explains why: %r" % pg.inner_text("#toast"))
        pg.screenshot(path=shots + "/game_locked.png")
        # --- pick up the goggles (walk into them for real)
        gg = G("(() => { const r = g.items[0].r; return [r.pts.reduce((s,p)=>s+p[0],0)/r.pts.length, r.pts.reduce((s,p)=>s+p[1],0)/r.pts.length]; })()")
        pg.evaluate("([x,y]) => { const g = window.__game(); g.hero.x = x + 40; g.hero.y = y; }", gg)
        pg.keyboard.down("ArrowLeft"); time.sleep(1.2); pg.keyboard.up("ArrowLeft"); time.sleep(0.3)
        check(G("g.has.has('goggles')"), "walking up to the goggles picks them up")
        check(pg.locator(".slot.full").count() == 1, "the item slot is filled")
        pg.hover(".slot.full"); time.sleep(0.3)
        tip = pg.evaluate("() => getComputedStyle(document.querySelector('.slot.full'), '::after').content")
        check("המשקפת אצלך" in tip, "hovering the icon shows 'המשקפת אצלך' (tooltip content: %s)" % tip)
        pg.screenshot(path=shots + "/game_goggles.png")
        # --- with goggles the water is open
        pg.evaluate("() => { const g = window.__game(); g.hero.x = 707; g.hero.y = 592; }")
        pg.keyboard.down("ArrowRight"); time.sleep(1.6); pg.keyboard.up("ArrowRight")
        x = G("g.hero.x"); check(x > 800, "with the goggles the hero swims into the water (x=%.0f)" % x)
        # --- win
        pg.evaluate("() => { const g = window.__game(); const r = g.goal; g.hero.x = 1088; g.hero.y = 1212; }")
        time.sleep(0.3); check(G("g.won"), "reaching the goal wins")
        time.sleep(1.8); pg.screenshot(path=shots + "/game_win.png")
        px = pg.evaluate("() => { const c = document.getElementById('c'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let col = 0; for (let i = 0; i < d.length; i += 40) if (Math.max(d[i],d[i+1],d[i+2]) - Math.min(d[i],d[i+1],d[i+2]) > 120) col++; return col; }")
        check(px > 300, "confetti is on screen (%d saturated sample pixels)" % px)
        pg.keyboard.press("r"); time.sleep(0.3); check(not G("g.won") and G("g.has.size") == 0, "R restarts: win cleared, goggles dropped")
        b.close()
    check(not errs, "no console/page errors: %s" % errs[:3])
finally:
    srv.terminate()
print("FAILED: %d" % len(fails) if fails else "ALL GAME CHECKS PASSED"); sys.exit(1 if fails else 0)
