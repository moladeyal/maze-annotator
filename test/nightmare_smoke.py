"""Browser test for the monsters / sword / controller / megaportal rules.  .venv/bin/python test/nightmare_smoke.py dist/maze_nightmare [shots_dir]
Interactions use real key presses; the hero is only teleported (window.__game()) to get next to a feature quickly."""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright
d = os.path.abspath(sys.argv[1]); shots = sys.argv[2] if len(sys.argv) > 2 else "/tmp"
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8133", "--bind", "127.0.0.1"], cwd=d, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
fails, errs = [], []
def check(c, m):
    print(("PASS " if c else "FAIL ") + m)
    if not c: fails.append(m)
# find, for a region, a spot + one of the 8 arrow directions from which walking straight in ends inside the region
FIND = """([name, touch]) => { const MC = window.MazeCore, g = window.__game(), r = MC.findRegion(g.regions, name), f = g.field, rad = g.hero.r;
  const c = MC.regionCenter(r); const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]; const out = [];
  for (let dist = 28; dist <= 120; dist += 8) for (const [dx, dy] of dirs) { const n = Math.hypot(dx, dy), ux = dx / n, uy = dy / n;
    const sx = c[0] - ux * dist, sy = c[1] - uy * dist; const hit = (x, y) => touch ? MC.regionTouches(r, x, y, g.touch) : MC.regionContains(r, x, y);
    if (!MC.walkable(f, sx, sy, rad) || hit(sx, sy)) continue;
    const h = MC.newHero(sx, sy, rad); let inside = false; for (let i = 0; i < dist * 2 + 40; i++) { MC.moveHero(f, h, ux, uy, 1); if (hit(h.x, h.y)) { inside = true; break; } }
    if (inside) out.push({ x: sx, y: sy, dx, dy, dist }); }
  out.sort((a, b) => a.dist - b.dist); return out[0] || null; }"""
KEYS = {(1,0):["ArrowRight"],(-1,0):["ArrowLeft"],(0,1):["ArrowDown"],(0,-1):["ArrowUp"],(1,1):["ArrowRight","ArrowDown"],(1,-1):["ArrowRight","ArrowUp"],(-1,1):["ArrowLeft","ArrowDown"],(-1,-1):["ArrowLeft","ArrowUp"]}
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(viewport={"width": 1400, "height": 960})
        pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto("http://127.0.0.1:8133/index.html"); pg.wait_for_function("window.__game && window.__game()", timeout=20000); time.sleep(0.5)
        G = lambda e: pg.evaluate("() => { const g = window.__game(); return " + e + "; }")
        tp = lambda x, y: pg.evaluate("([x,y]) => { const g = window.__game(); g.hero.x = x; g.hero.y = y; g.hero.inactive.clear(); }", [x, y])
        center = lambda n: G("(() => { const r = MazeCore.findRegion(g.regions, '%s'); return MazeCore.regionCenter(r); })()" % n)
        walk = lambda dirn, secs: ([pg.keyboard.down(k) for k in KEYS[dirn]], time.sleep(secs), [pg.keyboard.up(k) for k in KEYS[dirn]])
        def approach(name, touch=False):
            a = pg.evaluate(FIND, [name, touch]); assert a, "no straight approach to " + name; tp(a["x"], a["y"]); return (a["dx"], a["dy"])
        s = G("[g.hero.x, g.hero.y]"); st = center("start")
        check(abs(s[0] - st[0]) < 40 and abs(s[1] - st[1]) < 40, "hero starts in the 'start' region %s" % [round(v) for v in s])
        check(G("g.monsters.length") == 6 and G("g.mega !== null") and G("g.mega.choices.length") == 4, "6 monsters and a 4-way megaportal were read from the config")
        pg.screenshot(path=shots + "/nm_start.png")

        # --- no sword: monsters are walls
        dr = approach("mm1"); walk(dr, 1.4)
        check(not G("MazeCore.regionContains(MazeCore.findRegion(g.regions,'mm1'), g.hero.x, g.hero.y)") and G("g.defeated.size") == 0, "without a sword the hero cannot enter a monster")
        check("חרב" in pg.inner_text("#toast") and pg.locator("#toast.on").count() == 1, "a Hebrew hint says a sword is needed: %r" % pg.inner_text("#toast"))
        # --- pick up the sword
        dr = approach("sword", True); walk(dr, 0.8)
        check(G("g.has.has('sword') && g.dur.sword") == 5, "walking into the sword picks it up with durability 5")
        check(pg.locator(".slot[data-id=sword] .pip.on").count() == 5, "the sword slot shows 5 durability dots")
        pg.hover(".slot[data-id=sword]"); time.sleep(0.2)
        tip = pg.evaluate("() => getComputedStyle(document.querySelector('.slot[data-id=sword]'), '::after').content"); check("5/5" in tip and "החרב" in tip, "hover tooltip shows the sword and its durability: %s" % tip)
        pg.mouse.move(700, 900)
        # --- first fight, watch the animation
        dr = approach("mm1"); walk(dr, 0.35)
        check(G("g.defeated.has(g.monsters.find(m=>m.name==='mm1').id)") and G("g.dur.sword") == 4, "entering mm1 is a fight: monster defeated, sword 5 -> 4")
        time.sleep(0.12)
        red = pg.evaluate("""() => { const c = document.getElementById('c'), x = c.getContext('2d'), d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 64) if (d[i] > 190 && d[i+1] < 90 && d[i+2] < 90) n++; return n; }""")
        check(red > 150, "red flashing during the fight (%d strongly red sample pixels)" % red)
        check(pg.evaluate("window.__fx().fights.length") == 1 and pg.evaluate("window.__fx().sparks.length") > 10, "monster shake + sparks are running")
        x1 = G("g.hero.x"); time.sleep(0.3); x2 = G("g.hero.x"); check(abs(x2 - x1) < 0.5, "the hero pauses while the fight plays")
        pg.screenshot(path=shots + "/nm_fight.png")
        time.sleep(1.0); check(pg.locator(".slot[data-id=sword] .pip.on").count() == 4 and pg.evaluate("window.__fx().fights.length") == 0, "dots drop to 4 and the animation ends")
        # --- fight mm2..mm4 (one point each) then the breaking fight
        for n in ("mm2", "mm3", "mm4"):
            tp(*center("start")); dr = approach(n); walk(dr, 0.5); time.sleep(1.0)
        check(G("g.dur.sword") == 1 and G("g.defeated.size") == 4, "after four monsters the sword has 1 point left")
        tp(*center("start")); dr = approach("mm5"); walk(dr, 0.5)
        check(G("g.dur.sword") == 0 and not G("g.has.has('sword')") and G("g.broken.has('sword')"), "the fifth fight breaks the sword")
        time.sleep(1.0); check(pg.locator(".slot[data-id=sword].broken").count() == 1, "the sword slot shows it as broken")
        pg.screenshot(path=shots + "/nm_broken.png")
        dr = approach("mm6"); walk(dr, 1.4)
        check(not G("MazeCore.regionContains(MazeCore.findRegion(g.regions,'mm6'), g.hero.x, g.hero.y)"), "with a broken sword the next monster blocks again")
        check("נשברה" in pg.inner_text("#toast"), "and the message says the sword is broken: %r" % pg.inner_text("#toast"))
        dr = approach("sword", True); walk(dr, 0.8); check(not G("g.has.has('sword')"), "a broken sword is not re-collected from its spot")

        # --- restart, controller, megaportal
        pg.click("#restartBtn"); time.sleep(0.3)
        check(G("g.defeated.size") == 0 and G("g.has.size") == 0 and pg.locator(".slot.full").count() == 0, "restart button resets everything")
        dr = approach("mp", True); walk(dr, 1.2)
        check(G("!g.choosing") and "המגה" in pg.inner_text("#toast"), "the megaportal is off without the controller (Hebrew hint): %r" % pg.inner_text("#toast"))
        dr = approach("controller", True); walk(dr, 0.8)
        check(G("g.has.has('controller')") and pg.locator(".slot[data-id=controller].full").count() == 1, "controller picked up and shown in the item bar")
        dr = approach("mp", True); walk(dr, 1.0)
        check(G("g.choosing"), "entering the megaportal with the controller opens the number choice")
        x1 = G("g.hero.x"); pg.keyboard.down("ArrowRight"); time.sleep(0.4); pg.keyboard.up("ArrowRight"); check(abs(G("g.hero.x") - x1) < 0.5, "the hero is frozen while choosing")
        pg.screenshot(path=shots + "/nm_choose_a.png"); time.sleep(0.45); pg.screenshot(path=shots + "/nm_choose_b.png")
        sizes = []
        for _ in range(15):
            sizes.append(pg.evaluate("""() => { const g = window.__game(), c = document.getElementById('c'), x = c.getContext('2d'); const cs = g.mega.choices.map(ch => MazeCore.regionCenter(ch.r)); const R = Math.max(20, g.field.h * .03);
              return cs.map(p => { let n = 0; for (let a = 0; a < 6.28; a += .35) { const q = x.getImageData(Math.round(p[0] + R * 1.5 * Math.cos(a)), Math.round(p[1] + R * 1.5 * Math.sin(a)), 1, 1).data; if (q[0] > 200 && q[1] > 170 && q[2] < 120) n++; } return n; }); }"""))
            time.sleep(0.2)
        movers = [max(c[i] for c in sizes) - min(c[i] for c in sizes) for i in range(4)]
        check(sum(1 for m in movers if m >= 2) >= 3, "numbers pulse (grow and shrink) in turn over the four destinations (variation per number: %s)" % movers)
        pg.keyboard.press("Escape"); check(G("!g.choosing"), "Esc cancels the choice")
        tp(*center("start")); time.sleep(0.3); dr = approach("mp", True); walk(dr, 1.0); check(G("g.choosing"), "after leaving and re-entering it asks again")
        pg.keyboard.press("3"); time.sleep(0.2)
        c3 = center("mpt3"); h = G("[g.hero.x, g.hero.y]")
        check(G("!g.choosing") and abs(h[0] - c3[0]) < 25 and abs(h[1] - c3[1]) < 25, "pressing 3 teleports to mpt3 %s vs %s" % ([round(v) for v in h], [round(v) for v in c3]))
        pg.screenshot(path=shots + "/nm_landed.png")
        # --- click a number with the mouse
        tp(*center("start")); time.sleep(0.3); dr = approach("mp", True); walk(dr, 1.0); check(G("g.choosing"), "choice opens again")
        pos = pg.evaluate("""() => { const g = window.__game(), c = document.getElementById('c'), b = c.getBoundingClientRect(), p = MazeCore.regionCenter(g.mega.choices[3].r); return [b.left + p[0] * b.width / c.width, b.top + p[1] * b.height / c.height]; }""")
        pg.mouse.click(*pos); time.sleep(0.2); c4 = center("mpt4"); h = G("[g.hero.x, g.hero.y]")
        check(G("!g.choosing") and abs(h[0] - c4[0]) < 25 and abs(h[1] - c4[1]) < 25, "clicking the number 4 with the mouse teleports to mpt4")
        # --- finish
        c = center("finish"); tp(c[0], c[1] - 40); walk((0, 1), 0.8); time.sleep(0.3)
        check(G("g.won"), "reaching the finish wins"); time.sleep(1.2); pg.screenshot(path=shots + "/nm_win.png")
        b.close()
    check(not errs, "no console/page errors: %s" % errs[:3])
finally:
    srv.terminate()
print("FAILED: %d" % len(fails) if fails else "ALL NIGHTMARE CHECKS PASSED"); sys.exit(1 if fails else 0)
