// run: node test/core.test.js
const MC = require("../static/game-core.js");
const assert = require("assert");
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

// two rooms 100x60 each, separated by a solid wall at x=100; a closed outer box.
const box = (x0, y0, x1, y1) => ({ pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });
const lines = [box(5, 5, 195, 105), { pts: [[100, 5], [100, 105]] }];
const f = MC.buildField(lines, 200, 110);

// collision
ok(MC.walkable(f, 50, 50, 4), "open floor walkable");
ok(!MC.walkable(f, 100, 50, 4), "wall blocks");
ok(!MC.walkable(f, 103, 50, 4), "hero radius keeps distance from wall");
ok(!MC.walkable(f, 2, 50, 4), "outside the box blocked");
ok(MC.walkable(f, 50, 50, 20) && !MC.walkable(f, 20, 50, 20), "bigger hero needs more clearance");

// movement + sliding
let h = MC.newHero(50, 50, 4);
MC.moveHero(f, h, 1, 0, 200);
ok(h.x < 100 && h.x > 90, "stops at the wall, x=" + h.x);
h = MC.newHero(90, 50, 4); const y0 = h.y;
MC.moveHero(f, h, 0.7071, 0.7071, 40);
ok(h.y > y0 + 20, "slides along the wall when moving diagonally into it");
h = MC.newHero(50, 50, 4); MC.moveHero(f, h, 1, 0, 3000);
ok(h.x < 100, "very long step cannot tunnel through a wall");

// input
const kv = (...k) => MC.keyVector(new Set(k));
ok(kv()[0] === 0 && kv()[1] === 0, "no keys");
let v = kv("ArrowRight", "ArrowDown");
ok(Math.abs(v[0] - 0.7071) < 1e-3 && Math.abs(v[1] - 0.7071) < 1e-3, "two arrows = normalised diagonal");
v = kv("KeyW", "KeyA"); ok(v[0] < 0 && v[1] < 0, "WASD diagonals");
v = kv("Numpad9"); ok(v[0] > 0 && v[1] < 0, "numpad diagonal");
ok(kv("ArrowLeft", "ArrowRight")[0] === 0, "opposite arrows cancel");
v = MC.pointerVector({ x: 10, y: 10 }, { x: 20, y: 20 }); ok(v[0] > 0 && v[1] > 0, "pointer pulls toward it");
ok(MC.pointerVector({ x: 10, y: 10 }, { x: 11, y: 10 })[0] === 0, "pointer dead zone");

// regions
const poly = { id: "p", shape: "polygon", pts: [[0, 0], [10, 0], [10, 10], [0, 10]] };
const ell = { id: "e", shape: "ellipse", cx: 50, cy: 50, rx: 10, ry: 5 };
ok(MC.regionContains(poly, 5, 5) && !MC.regionContains(poly, 15, 5), "polygon contains");
ok(MC.regionContains(ell, 59, 50) && !MC.regionContains(ell, 50, 57), "ellipse contains");
ok(Math.abs(MC.regionCenter(poly)[0] - 5) < 1e-6 && Math.abs(MC.regionCenter(poly)[1] - 5) < 1e-6, "polygon centre");
const thin = { id: "t", shape: "polygon", pts: [[0, 0], [10, 0], [10, 0], [0, 0]] };
ok(MC.regionCenter(thin).every(Number.isFinite), "degenerate polygon has a finite centre");
ok(Math.abs(MC.regionArea(ell) - Math.PI * 50) < 1e-6, "ellipse area");
ok(MC.findRegion([{ name: " Start " }], "start"), "findRegion is case/space insensitive");

// portals: A in left room <-> B in right room, thin regions
const A = { id: "A", shape: "polygon", pts: [[40, 40], [44, 40], [44, 60], [40, 60]] };
const B = { id: "B", shape: "polygon", pts: [[150, 40], [154, 40], [154, 60], [150, 60]] };
const regs = [A, B];
const both = [{ id: "p1", a: "A", b: "B", dir: "both" }];
h = MC.newHero(30, 50, 4);
MC.moveHero(f, h, 1, 0, 11); let hit = MC.updatePortals(f, h, regs, both);
ok(hit && hit.to === "B", "walking into A teleports to B");
ok(Math.abs(h.x - 152) < 2, "lands at the centre of B, x=" + h.x);
ok(MC.updatePortals(f, h, regs, both) === null, "no instant bounce back while still inside B");
MC.moveHero(f, h, 1, 0, 20); MC.updatePortals(f, h, regs, both);
ok(!h.inactive.has("B"), "B re-arms after moving away");
MC.moveHero(f, h, -1, 0, 20); hit = MC.updatePortals(f, h, regs, both);
ok(hit && hit.to === "A", "bidirectional: walking back into B returns to A");
// one-way
const ab = [{ id: "p2", a: "A", b: "B", dir: "ab" }];
h = MC.newHero(152, 50, 4); ok(MC.updatePortals(f, h, regs, ab) === null, "a->b portal does not fire from B");
h = MC.newHero(42, 50, 4); ok(MC.updatePortals(f, h, regs, ab) !== null, "a->b portal fires from A");
const ba = [{ id: "p3", a: "A", b: "B", dir: "ba" }];
h = MC.newHero(42, 50, 4); ok(MC.updatePortals(f, h, regs, ba) === null, "b->a portal does not fire from A");
h = MC.newHero(152, 50, 4); hit = MC.updatePortals(f, h, regs, ba); ok(hit && hit.to === "A", "b->a portal fires from B");
// landing spot inside a wall gets nudged to a walkable point
const wallRegion = { id: "W", shape: "polygon", pts: [[99, 40], [101, 40], [101, 60], [99, 60]] };
h = MC.newHero(42, 50, 4);
MC.updatePortals(f, h, [A, wallRegion], [{ id: "p4", a: "A", b: "W", dir: "ab" }]);
ok(MC.walkable(f, h.x, h.y, 4), "landing point on a wall is nudged to open floor");
// region borders do not block
h = MC.newHero(20, 80, 4); MC.moveHero(f, h, 1, 0, 60);
ok(h.x > 70, "regions never block movement (no portals here)");

// blocked predicate
h = MC.newHero(50, 50, 4); MC.moveHero(f, h, 1, 0, 30, (x) => x > 70);
ok(h.x <= 70 && h.x > 60, "extra blocked area stops the hero, x=" + h.x);

// rules: start / goal / item / lock
const ann = { image: { w: 200, h: 110 }, hero_radius: 4, portals: [], regions: [
  { id: "s", name: "start", shape: "polygon", pts: [[20, 40], [30, 40], [30, 60], [20, 60]] },
  { id: "g", name: "goggles", shape: "polygon", pts: [[60, 85], [70, 85], [70, 98], [60, 98]] },
  { id: "w", name: "water", shape: "polygon", pts: [[120, 10], [190, 10], [190, 100], [120, 100]] },
  { id: "z", name: "goal", shape: "polygon", pts: [[170, 40], [185, 40], [185, 60], [170, 60]] }] };
const cfg = { items: [{ id: "goggles", region: ["googles", "goggles"], label: "x" }], locks: [{ region: "water", needs: "goggles" }] };
// open a door in the middle wall so the two rooms connect
const door = MC.buildField([box(5, 5, 195, 105), { pts: [[100, 5], [100, 40]] }, { pts: [[100, 70], [100, 105]] }], 200, 110);
let g = MC.createGame(ann, cfg, door);
ok(Math.abs(g.hero.x - 25) < 3, "hero starts in the 'start' region");
const walk = (dx, dy, d) => { let evs = []; for (let i = 0; i < d; i++) evs = evs.concat(MC.stepGame(g, dx, dy, 1)); return evs; };
let evs = walk(1, 0, 110); // heads right: through the door, but the water (x>=120) is locked
ok(g.hero.x > 100 && g.hero.x < 121, "locked water stops the hero at its edge, x=" + g.hero.x);
ok(evs.some((e) => e.type === "locked"), "a 'locked' event is reported while pushing against it");
ok(!g.has.has("goggles") && !g.won, "nothing picked up yet and no win");
g = MC.createGame(ann, cfg, door);
walk(1, 0, 40); walk(0, 1, 50); // detour down to the goggles (alias 'googles' in the config resolves to region 'goggles')
ok(g.has.has("goggles"), "walking into the goggles region picks them up (region alias works)");
walk(0, -1, 40); evs = walk(1, 0, 170);
ok(g.hero.x > 140, "with the goggles the hero can enter the water, x=" + g.hero.x);
ok(g.won, "reaching the goal region wins");
ok(MC.stepGame(g, -1, 0, 5).length === 0 && g.hero.x > 140, "game is frozen after a win");

// touching: a wall inside the region keeps the centre out, but touching it counts for items and goal
const ring = { id: "k", name: "ring", shape: "polygon", pts: [[140, 20], [160, 20], [160, 40], [140, 40]] };
ok(MC.regionTouches(ring, 138, 30, 5) && !MC.regionTouches(ring, 130, 30, 5), "regionTouches: within tolerance counts, farther does not");
ok(MC.regionDistance(ring, 150, 30) === 0 && Math.abs(MC.regionDistance(ring, 135, 30) - 5) < 1e-9, "regionDistance");
// halo: purely visual. drawHero must never alter hero.r, and the drawn halo is much bigger than the body
const calls = []; const gstub = { addColorStop() {} };
const cx = new Proxy({}, { get: (_, k) => k === "createRadialGradient" ? (...a) => (calls.push(a), gstub) : k === "arc" ? (...a) => calls.push(["arc", ...a]) : () => {}, set: () => true });
h = MC.newHero(50, 50, 4); const r0 = h.r; MC.drawHero(cx, h, 0); MC.drawHero(cx, h, 1300);
ok(h.r === r0, "drawing the halo does not change the hero's collision radius");
const outers = calls.filter((c) => c[0] !== "arc").map((c) => c[5]);
ok(outers.length === 2 && outers.every((o) => o > 3 * (r0 + 2.5)) && outers[0] !== outers[1], "halo is several times larger than the body and pulsates over time");
// dashed portals
const rr = [{ id: "a", shape: "polygon", pts: [[0, 0], [2, 0], [2, 2], [0, 2]] }, { id: "b", shape: "polygon", pts: [[10, 0], [12, 0], [12, 2], [10, 2]] }];
const vl = MC.visiblePortalLines(rr, [{ id: "p1", a: "a", b: "b", dir: "both", dashed: true }, { id: "p2", a: "a", b: "b", dir: "ab" }]);
ok(vl.length === 1 && vl[0].id === "p1" && Math.abs(vl[0].x2 - vl[0].x1 - 10) < 1e-9, "only portals flagged dashed produce a visible line");
// drawn body is 1.5x larger, collision radius untouched
const arcs = []; const cx2 = new Proxy({}, { get: (_, k) => k === "createRadialGradient" ? () => ({ addColorStop() {} }) : k === "arc" ? (...a) => arcs.push(a) : () => {}, set: () => true });
h = MC.newHero(50, 50, 4); MC.drawHero(cx2, h, 0);
ok(arcs.some((a) => Math.abs(a[2] - (4 + 2.5) * 1.5) < 1e-9), "hero body is drawn 50% larger (radius " + ((4 + 2.5) * 1.5) + ")");
ok(h.r === 4 && MC.walkable(f, 50, 50, h.r) && !MC.walkable(f, 103, 50, h.r), "navigation still uses the original radius");
// ---- monsters + sword durability, controller + megaportal
{
  const sqr = (id, name, x, y, w = 10, h = 10) => ({ id, name, shape: "polygon", pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
  const open = MC.buildField([box(5, 5, 195, 105)], 200, 110); // one big open room
  const A = { image: { w: 200, h: 110 }, hero_radius: 3, portals: [
      { id: "m1", a: "mp", b: "d1", dir: "ab" }, { id: "m2", a: "mp", b: "d2", dir: "ab" }],
    regions: [sqr("s", "start", 10, 50), sqr("w", "sword", 30, 80), sqr("c", "controller", 30, 10), sqr("mp", "mp", 60, 50, 14, 14),
      sqr("d1", "d1", 160, 10), sqr("d2", "d2", 160, 90), sqr("f", "finish", 185, 50),
      sqr("a", "mm1", 90, 40, 8, 40), sqr("b", "mm2", 110, 40, 8, 40), sqr("z", "mm3", 130, 40, 8, 40)] };
  const C = { goal: "finish", items: [{ id: "sword", region: "sword", durability: 2 }, { id: "controller", region: "controller" }],
    monsters: { pattern: "^mm\\d+$", needs: "sword", hint: "need sword", brokenHint: "sword broke" },
    megaportal: { region: "mp", needs: "controller", prompt: "pick", choices: [{ label: "1", region: "d1" }, { label: "2", region: "d2" }] } };
  const mk = () => MC.createGame(A, C, open);
  const go = (g, dx, dy, d) => { let e = []; for (let i = 0; i < d; i++) e = e.concat(MC.stepGame(g, dx, dy, 1)); return e; };
  const put = (g, x, y) => { g.hero.x = x; g.hero.y = y; };

  let g = mk(); ok(g.monsters.length === 3, "monsters are picked by the name pattern");
  put(g, 80, 60); let e = go(g, 1, 0, 40);
  ok(g.hero.x < 91 && g.hero.x > 85, "without a sword a monster blocks like a wall, x=" + g.hero.x);
  ok(e.some((v) => v.type === "locked" && v.lock.hint === "need sword"), "and explains that a sword is needed");
  ok(g.defeated.size === 0 && g.dur.sword === undefined, "nothing was fought");

  g = mk(); put(g, 33, 83); go(g, 0, 0, 1);
  ok(g.has.has("sword") && g.dur.sword === 2, "picking up the sword gives its full durability (2)");
  put(g, 80, 60); e = go(g, 1, 0, 22);
  const f1 = e.filter((v) => v.type === "fight");
  ok(f1.length === 1 && f1[0].dur === 1 && !f1[0].broken && f1[0].monster.name === "mm1", "entering a monster is one fight: durability 2 -> 1");
  ok(g.defeated.has("a") && g.hero.x > 98 && g.hero.x < 110, "the defeated monster is passed and gone");
  e = go(g, -1, 0, 20); ok(e.filter((v) => v.type === "fight").length === 0 && g.dur.sword === 1, "walking back through a defeated monster costs nothing");
  put(g, 104, 60); e = go(g, 1, 0, 12);
  const f2 = e.filter((v) => v.type === "fight");
  ok(f2.length === 1 && f2[0].dur === 0 && f2[0].broken && !g.has.has("sword") && g.broken.has("sword"), "the second fight breaks the sword (0 left, gone)");
  put(g, 122, 60); e = go(g, 1, 0, 30);
  ok(g.hero.x < 131 && e.some((v) => v.type === "locked" && v.lock.hint === "sword broke"), "with a broken sword the next monster blocks again, with its own message, x=" + g.hero.x);
  put(g, 33, 83); go(g, 0, 0, 3); ok(!g.has.has("sword"), "a broken sword cannot be picked up again");

  g = mk(); put(g, 70, 57); e = go(g, 0, 0, 1);
  ok(e.some((v) => v.type === "megalocked") && !g.choosing, "megaportal is off without the controller (and says so)");
  put(g, 33, 13); go(g, 0, 0, 1); ok(g.has.has("controller"), "controller picked up");
  put(g, 40, 57); e = go(g, 1, 0, 25);
  ok(g.choosing && e.some((v) => v.type === "choose"), "entering the megaportal with the controller starts the choice");
  const hx = g.hero.x; e = go(g, 1, 0, 20); ok(g.hero.x === hx, "the hero is frozen while choosing");
  e = MC.megaChoose(g, 1);
  ok(!g.choosing && Math.abs(g.hero.x - 165) < 8 && Math.abs(g.hero.y - 95) < 8 && e.some((v) => v.type === "megaport" && v.choice.label === "2"), "choosing 2 teleports to destination 2");
  ok(MC.megaChoose(g, 0).length === 0, "choosing when not choosing does nothing");
  put(g, 40, 57); go(g, 1, 0, 25); ok(g.choosing, "re-entering after leaving asks again"); MC.megaCancel(g); ok(!g.choosing, "cancel closes the choice");
  go(g, 0, 0, 3); ok(!g.choosing, "after cancel it does not re-open while still inside");
  go(g, -1, 0, 30); go(g, 1, 0, 30); ok(g.choosing, "after leaving and coming back it opens again");
  g = mk(); put(g, 180, 55); go(g, 1, 0, 3); ok(g.won, "reaching finish still wins");
}

console.log("core tests passed:", n);
