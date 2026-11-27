/* Shared by the editor's playtest and the exported game. No DOM, so it also runs under node (see test/).
 *
 *  - lines block the hero (collision = distance field from rasterised lines)
 *  - regions never block; they are just named shapes
 *  - portals connect two regions: entering one lands you at the centre of the other,
 *    and the landing region stays "inactive" until the hero has moved out of it.
 */
(function (root) {
  const MC = {};

  /* ---------- regions ---------- */
  function inPoly(pts, x, y) {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  MC.pointInPoly = inPoly;

  MC.regionContains = function (r, x, y) {
    if (r.shape === "ellipse") {
      const dx = (x - r.cx) / r.rx, dy = (y - r.cy) / r.ry;
      return dx * dx + dy * dy <= 1;
    }
    return inPoly(r.pts, x, y);
  };

  MC.regionArea = function (r) {
    if (r.shape === "ellipse") return Math.PI * r.rx * r.ry;
    let a = 0;
    for (let i = 0, j = r.pts.length - 1; i < r.pts.length; j = i++) a += r.pts[j][0] * r.pts[i][1] - r.pts[i][0] * r.pts[j][1];
    return Math.abs(a) / 2;
  };

  MC.regionCenter = function (r) {
    if (r.shape === "ellipse") return [r.cx, r.cy];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.pts.length - 1; i < r.pts.length; j = i++) {
      const f = r.pts[j][0] * r.pts[i][1] - r.pts[i][0] * r.pts[j][1];
      a += f; cx += (r.pts[j][0] + r.pts[i][0]) * f; cy += (r.pts[j][1] + r.pts[i][1]) * f;
    }
    if (Math.abs(a) < 1e-6) { // degenerate (very thin): plain average
      const n = r.pts.length;
      return [r.pts.reduce((s, p) => s + p[0], 0) / n, r.pts.reduce((s, p) => s + p[1], 0) / n];
    }
    return [cx / (3 * a), cy / (3 * a)];
  };

  // distance from a point to a region (0 inside)
  MC.regionDistance = function (r, x, y) {
    if (r.shape === "ellipse") { const q = Math.hypot((x - r.cx) / r.rx, (y - r.cy) / r.ry); return q <= 1 ? 0 : (q - 1) * Math.min(r.rx, r.ry); }
    if (inPoly(r.pts, x, y)) return 0;
    let m = 1e9;
    for (let i = 0, j = r.pts.length - 1; i < r.pts.length; j = i++) {
      const ax = r.pts[j][0], ay = r.pts[j][1], dx = r.pts[i][0] - ax, dy = r.pts[i][1] - ay, L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)); m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return m;
  };
  // "touching": inside, or within `tol` px. Walls drawn inside a region can keep the hero's centre out of it.
  MC.regionTouches = (r, x, y, tol) => MC.regionDistance(r, x, y) <= tol;

  MC.findRegion = (regions, name) => regions.find((r) => (r.name || "").trim().toLowerCase() === name.toLowerCase());

  /* ---------- collision field ---------- */
  // Rasterise all lines (3px wide) and compute an approximate distance-to-wall for every pixel.
  MC.buildField = function (lines, w, h) {
    w = Math.ceil(w); h = Math.ceil(h);
    const wall = new Uint8Array(w * h);
    const stamp = (x, y) => {
      const xi = Math.round(x), yi = Math.round(y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = xi + dx, Y = yi + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h) wall[Y * w + X] = 1;
      }
    };
    for (const L of lines) {
      const p = L.pts;
      if (p.length === 1) stamp(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) {
        const ax = p[i - 1][0], ay = p[i - 1][1], bx = p[i][0], by = p[i][1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.7));
        for (let k = 0; k <= n; k++) stamp(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
      }
    }
    const INF = 1e9, D = 1.4142, d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = wall[i] ? 0 : INF;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // forward chamfer pass
      const i = y * w + x; let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { // backward pass
      const i = y * w + x; let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
    return { w, h, d };
  };

  MC.walkable = function (f, x, y, r) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= f.w || yi >= f.h) return false;
    return f.d[yi * f.w + xi] >= r + 1;
  };

  // closest walkable point to (x,y), searching in growing rings
  MC.nearestWalkable = function (f, x, y, r, maxR) {
    if (MC.walkable(f, x, y, r)) return [x, y];
    for (let rad = 1; rad <= (maxR || 40); rad++) {
      for (let a = 0; a < 360; a += Math.max(4, Math.floor(200 / rad))) {
        const px = x + rad * Math.cos((a * Math.PI) / 180), py = y + rad * Math.sin((a * Math.PI) / 180);
        if (MC.walkable(f, px, py, r)) return [px, py];
      }
    }
    return [x, y];
  };

  /* ---------- input ---------- */
  // keys: Set of KeyboardEvent.code. Arrows/WASD combine into diagonals; numpad and Home/End/PgUp/PgDn are diagonals too.
  MC.keyVector = function (keys) {
    const has = (...c) => c.some((k) => keys.has(k));
    let dx = (has("ArrowRight", "KeyD", "Numpad6") ? 1 : 0) - (has("ArrowLeft", "KeyA", "Numpad4") ? 1 : 0);
    let dy = (has("ArrowDown", "KeyS", "Numpad2") ? 1 : 0) - (has("ArrowUp", "KeyW", "Numpad8") ? 1 : 0);
    if (has("Numpad7", "Home")) { dx -= 1; dy -= 1; }
    if (has("Numpad9", "PageUp")) { dx += 1; dy -= 1; }
    if (has("Numpad1", "End")) { dx -= 1; dy += 1; }
    if (has("Numpad3", "PageDown")) { dx += 1; dy += 1; }
    dx = Math.max(-1, Math.min(1, dx)); dy = Math.max(-1, Math.min(1, dy));
    const n = Math.hypot(dx, dy);
    return n ? [dx / n, dy / n] : [0, 0];
  };

  // holding the pointer down walks toward it (easy way to go diagonally on touch/trackpad)
  MC.pointerVector = function (hero, pointer) {
    if (!pointer) return [0, 0];
    const dx = pointer.x - hero.x, dy = pointer.y - hero.y, n = Math.hypot(dx, dy);
    return n > 3 ? [dx / n, dy / n] : [0, 0];
  };

  /* ---------- hero ---------- */
  MC.newHero = (x, y, r) => ({ x, y, r, inactive: new Set() });

  // advance the hero by `dist` px along unit vector (vx,vy); axes are tried separately so walls "slide"
  // `blocked(x, y)` (optional) adds extra no-go areas on top of the walls, e.g. a locked region
  MC.moveHero = function (f, hero, vx, vy, dist, blocked) {
    const n = Math.max(1, Math.ceil(dist / 1.0));
    const sx = (vx * dist) / n, sy = (vy * dist) / n;
    const ok = (x, y) => MC.walkable(f, x, y, hero.r) && !(blocked && blocked(x, y));
    for (let i = 0; i < n; i++) {
      if (sx && ok(hero.x + sx, hero.y)) hero.x += sx;
      if (sy && ok(hero.x, hero.y + sy)) hero.y += sy;
    }
  };

  /* ---------- portals ---------- */
  // portal: {id, a: regionId, b: regionId, dir: "both" | "ab" | "ba"}
  MC.updatePortals = function (f, hero, regions, portals) {
    const byId = {}; regions.forEach((r) => (byId[r.id] = r));
    for (const id of Array.from(hero.inactive)) { // re-arm once the hero has left the region
      const r = byId[id];
      if (!r || !MC.regionContains(r, hero.x, hero.y)) hero.inactive.delete(id);
    }
    for (const p of portals) {
      const A = byId[p.a], B = byId[p.b];
      if (!A || !B) continue;
      const dir = p.dir || "both";
      const hops = [];
      if (dir === "both" || dir === "ab") hops.push([A, B]);
      if (dir === "both" || dir === "ba") hops.push([B, A]);
      for (const [from, to] of hops) {
        if (hero.inactive.has(from.id) || !MC.regionContains(from, hero.x, hero.y)) continue;
        const c = MC.regionCenter(to);
        const [nx, ny] = MC.nearestWalkable(f, c[0], c[1], hero.r, 60);
        hero.x = nx; hero.y = ny;
        // everything we land inside of must be left before it can fire again (no instant bounce-back)
        for (const q of portals) for (const id of [q.a, q.b]) {
          const R = byId[id];
          if (R && MC.regionContains(R, hero.x, hero.y)) hero.inactive.add(id);
        }
        return { from: from.id, to: to.id };
      }
    }
    return null;
  };

  /* ---------- game rules: start / goal / items / locks ----------
   * cfg (game.json): { start:"start", goal:"goal",
   *   items:[{id, region:"goggles"|[aliases], icon, label}],      walk into the region to pick it up
   *   locks:[{region:"water", needs:"goggles", hint}] }           can't enter the region without the item
   */
  const names = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean);
  const findAny = (regions, v) => { for (const n of names(v)) { const r = MC.findRegion(regions, n); if (r) return r; } return null; };

  // regions picked by a spec: {regions:["a","b"]} or {pattern:"^mm\\d+$"}
  const pickRegions = (regions, spec) => {
    if (!spec) return [];
    if (spec.regions) return spec.regions.map((n) => MC.findRegion(regions, n)).filter(Boolean);
    if (spec.pattern) { const re = new RegExp(spec.pattern, "i"); return regions.filter((r) => re.test((r.name || "").trim())); }
    return [];
  };

  /* extra rules (all optional, from game.json):
   *   items[].durability        number of uses; used up by monsters
   *   monsters {pattern|regions, needs:"sword", cost:1, hint, brokenHint}
   *        a live monster blocks the hero unless the needed item is held with durability left.
   *        Entering it is a fight: durability drops by `cost`, the monster is defeated for good,
   *        and at 0 the item breaks (gone for good, it cannot be picked up again).
   *   megaportal {region:"mp", needs:"controller", prompt, lockedHint, choices:[{label, key, region}]}
   *        entering the region with the needed item pauses the hero ("choosing"); megaChoose(g, i) teleports.
   *        Ordinary portals starting in that region are ignored (the player chooses instead).
   */
  MC.createGame = function (ann, cfg, field) {
    cfg = cfg || {};
    const regions = ann.regions || [], radius = ann.hero_radius || 4;
    const g = { regions, cfg, field, has: new Set(), picked: new Set(), broken: new Set(), defeated: new Set(), dur: {}, won: false, choosing: false, events: [], blockedHint: null };
    g.items = (cfg.items || []).map((it) => ({ ...it, r: findAny(regions, it.region) }));
    g.locks = (cfg.locks || []).map((l) => ({ ...l, r: findAny(regions, l.region) })).filter((l) => l.r);
    g.goal = findAny(regions, cfg.goal || "goal");
    g.startRegion = findAny(regions, cfg.start || "start");
    const mc = cfg.monsters;
    g.monsterCfg = mc ? { needs: mc.needs || "sword", cost: mc.cost || 1, hint: mc.hint, brokenHint: mc.brokenHint } : null;
    g.monsters = mc ? pickRegions(regions, mc) : [];
    const mg = cfg.megaportal, mr = mg && findAny(regions, mg.region);
    g.mega = mr ? { r: mr, needs: mg.needs, prompt: mg.prompt, lockedHint: mg.lockedHint, armed: true,
      choices: (mg.choices || []).map((c) => ({ label: c.label, key: String(c.key || c.label), r: findAny(regions, c.region) })).filter((c) => c.r) } : null;
    g.portals = g.mega ? (ann.portals || []).filter((p) => p.a !== g.mega.r.id) : (ann.portals || []);
    g.touch = radius + 6;
    g.canFight = () => !!g.monsterCfg && g.has.has(g.monsterCfg.needs) && (g.dur[g.monsterCfg.needs] === undefined || g.dur[g.monsterCfg.needs] > 0);
    g.monsterAt = (x, y) => g.monsters.find((m) => !g.defeated.has(m.id) && MC.regionContains(m, x, y)) || null;
    g.blocked = (x, y) => g.locks.some((l) => !g.has.has(l.needs) && MC.regionContains(l.r, x, y)) || (!!g.monsterAt(x, y) && !g.canFight());
    const c = g.startRegion ? MC.regionCenter(g.startRegion) : [ann.image.w / 2, ann.image.h / 2];
    const p = MC.nearestWalkable(field, c[0], c[1], radius, 80);
    g.hero = MC.newHero(p[0], p[1], radius);
    markInactive(g);
    return g;
  };

  function markInactive(g) { // portal regions we are standing in must be left before they can fire
    for (const q of g.portals) for (const id of [q.a, q.b]) {
      const R = g.regions.find((r) => r.id === id);
      if (R && MC.regionContains(R, g.hero.x, g.hero.y)) g.hero.inactive.add(id);
    }
  }

  // everything that can happen once the hero stands somewhere: pickups, fights, megaportal, goal
  function settle(g, ev, withPortals) {
    const h = g.hero;
    if (withPortals) { const hop = MC.updatePortals(g.field, h, g.regions, g.portals); if (hop) ev.push({ type: "portal", ...hop }); }
    for (const it of g.items) {
      if (it.r && !g.picked.has(it.id) && MC.regionTouches(it.r, h.x, h.y, g.touch)) {
        g.picked.add(it.id); g.has.add(it.id);
        if (it.durability != null) g.dur[it.id] = it.durability;
        ev.push({ type: "pickup", item: it });
      }
    }
    if (g.monsterCfg) for (const m of g.monsters) {
      if (g.defeated.has(m.id) || !MC.regionContains(m, h.x, h.y) || !g.canFight()) continue;
      const n = g.monsterCfg.needs; g.defeated.add(m.id); g.dur[n] = Math.max(0, (g.dur[n] === undefined ? 1 : g.dur[n]) - g.monsterCfg.cost);
      const broke = g.dur[n] <= 0; if (broke) { g.has.delete(n); g.broken.add(n); }
      ev.push({ type: "fight", monster: m, dur: g.dur[n], broken: broke, item: n });
    }
    if (g.mega) {
      const inside = MC.regionTouches(g.mega.r, h.x, h.y, g.touch);
      if (!inside) g.mega.armed = true;
      else if (g.mega.armed) {
        g.mega.armed = false; // fires once per visit; leave the region to re-arm
        if (g.has.has(g.mega.needs)) { g.choosing = true; ev.push({ type: "choose" }); } else ev.push({ type: "megalocked" });
      }
    }
    if (g.goal && MC.regionTouches(g.goal, h.x, h.y, g.touch)) { g.won = true; ev.push({ type: "win" }); }
  }

  // one simulation step: move, then portals, pickups, fights, megaportal, goal. Returns the events fired.
  MC.stepGame = function (g, vx, vy, dist) {
    const ev = [], h = g.hero;
    if (g.won || g.choosing) return ev;
    g.blockedHint = null;
    if (vx || vy) {
      const x0 = h.x, y0 = h.y;
      MC.moveHero(g.field, h, vx, vy, dist, g.blocked);
      if (h.x === x0 && h.y === y0) { // pressing into something that blocks: tell the UI why
        const ax = h.x + vx * 3, ay = h.y + vy * 3;
        const l = g.locks.find((k) => !g.has.has(k.needs) && MC.regionContains(k.r, ax, ay));
        if (l) { g.blockedHint = l; ev.push({ type: "locked", lock: l }); }
        else if (g.monsterCfg && g.monsterAt(ax, ay) && !g.canFight()) {
          const hint = { hint: g.broken.has(g.monsterCfg.needs) ? g.monsterCfg.brokenHint : g.monsterCfg.hint };
          g.blockedHint = hint; ev.push({ type: "locked", lock: hint, monster: g.monsterAt(ax, ay) });
        }
      }
    }
    settle(g, ev, true);
    return ev;
  };

  // the player picked destination number i (index into mega.choices) while g.choosing
  MC.megaChoose = function (g, i) {
    const m = g.mega, ev = [];
    if (!m || !g.choosing || !m.choices[i]) return ev;
    const c = m.choices[i], ctr = MC.regionCenter(c.r), p = MC.nearestWalkable(g.field, ctr[0], ctr[1], g.hero.r, 60);
    const from = [g.hero.x, g.hero.y];
    g.hero.x = p[0]; g.hero.y = p[1]; g.choosing = false; g.hero.inactive.clear(); markInactive(g);
    ev.push({ type: "megaport", choice: c, index: i, from, to: [p[0], p[1]] });
    settle(g, ev, false);
    return ev;
  };
  MC.megaCancel = function (g) { g.choosing = false; }; // stays disarmed until the hero leaves the region

  MC.HERO_VISUAL_SCALE = 1.5; // drawn size relative to the old look; collision always uses hero.r
  // Draws the hero: a slowly pulsating halo (purely visual) + the round face. Collision only ever uses hero.r.
  MC.drawHero = function (ctx, hero, nowMs) {
    const R = (hero.r + 2.5) * MC.HERO_VISUAL_SCALE, t = (nowMs || 0) / 1000, pulse = 0.5 + 0.5 * Math.sin(t * 2.6); // ~2.4 s per breath
    const outer = R * (3.4 + 1.1 * pulse);
    const g = ctx.createRadialGradient(hero.x, hero.y, R * 0.8, hero.x, hero.y, outer);
    g.addColorStop(0, "rgba(255,214,64," + (0.55 + 0.25 * pulse).toFixed(3) + ")");
    g.addColorStop(0.55, "rgba(255,190,40," + (0.22 + 0.12 * pulse).toFixed(3) + ")");
    g.addColorStop(1, "rgba(255,190,40,0)");
    ctx.save();
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hero.x, hero.y, outer, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,140,0," + (0.35 + 0.35 * pulse).toFixed(3) + ")"; ctx.lineWidth = Math.max(1, R * 0.28);
    ctx.beginPath(); ctx.arc(hero.x, hero.y, R * (1.9 + 0.5 * pulse), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#ffd23f"; ctx.strokeStyle = "#222"; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(hero.x, hero.y, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#222"; ctx.beginPath();
    ctx.arc(hero.x - R * 0.35, hero.y - R * 0.2, R * 0.14, 0, Math.PI * 2); ctx.arc(hero.x + R * 0.35, hero.y - R * 0.2, R * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  // portals the player should see as a dashed line (portal.dashed), as [{x1,y1,x2,y2,dir}]
  MC.visiblePortalLines = function (regions, portals) {
    const byId = {}; regions.forEach((r) => (byId[r.id] = r)); const out = [];
    for (const p of portals) {
      if (!p.dashed || !byId[p.a] || !byId[p.b]) continue;
      const a = MC.regionCenter(byId[p.a]), b = MC.regionCenter(byId[p.b]);
      out.push({ id: p.id, x1: a[0], y1: a[1], x2: b[0], y2: b[1], dir: p.dir || "both" });
    }
    return out;
  };

  MC.speedFor = (w, h) => 0.1 * Math.max(w, h); // px/s; scales with image size

  if (typeof module !== "undefined" && module.exports) module.exports = MC; else root.MazeCore = MC;
})(typeof window !== "undefined" ? window : globalThis);
