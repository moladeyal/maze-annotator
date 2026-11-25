// Can the goal be reached? Grid search over (position, has-item) with portals and locks.
// usage: node test/reach.js dist/maze1   (folder with annotations.json [+ game.json])
const fs = require("fs"), MC = require("../static/game-core.js");
const dir = process.argv[2], ann = JSON.parse(fs.readFileSync(dir + "/annotations.json"));
const cfg = fs.existsSync(dir + "/game.json") ? JSON.parse(fs.readFileSync(dir + "/game.json")) : {};
if (process.env.NOKEYS) cfg.items = [];
if (process.env.NOPORTALS) ann.portals = [];
const f = MC.buildField(ann.lines, ann.image.w, ann.image.h), g0 = MC.createGame(ann, cfg, f), STEP = 2;
const W = Math.ceil(f.w / STEP), H = Math.ceil(f.h / STEP), keyIds = g0.items.map((i) => i.id);
const bit = (set) => keyIds.reduce((b, id, i) => b | (set.has(id) ? 1 << i : 0), 0);
const seen = new Uint8Array(W * H * (1 << keyIds.length)); const idx = (x, y, k) => (k * H + y) * W + x;
const has = (k) => new Set(keyIds.filter((_, i) => k & (1 << i)));
const locked = (x, y, k) => g0.locks.some((l) => !has(k).has(l.needs) && MC.regionContains(l.r, x, y));
const q = []; const push = (x, y, k) => { const X = Math.round(x / STEP), Y = Math.round(y / STEP); if (X < 0 || Y < 0 || X >= W || Y >= H) return; const i = idx(X, Y, k); if (!seen[i]) { seen[i] = 1; q.push([X, Y, k]); } };
push(g0.hero.x, g0.hero.y, 0);
let goal = null, gotKeys = new Set(), portalsUsed = new Set(), regionsReached = new Set();
while (q.length) {
  const [X, Y, k] = q.pop(), x = X * STEP, y = Y * STEP;
  if (g0.goal && MC.regionTouches(g0.goal, x, y, g0.touch)) goal = goal || [x, y];
  for (const r of ann.regions) if (MC.regionContains(r, x, y)) regionsReached.add(r.name);
  let k2 = k;
  for (const it of g0.items) if (it.r && MC.regionTouches(it.r, x, y, g0.touch)) { k2 |= 1 << keyIds.indexOf(it.id); gotKeys.add(it.id); }
  if (k2 !== k) push(x, y, k2);
  for (const p of ann.portals) {
    const A = ann.regions.find((r) => r.id === p.a), B = ann.regions.find((r) => r.id === p.b), d = p.dir || "both";
    for (const [from, to, ok] of [[A, B, d !== "ba"], [B, A, d !== "ab"]]) if (ok && from && to && MC.regionContains(from, x, y)) {
      const c = MC.regionCenter(to), n = MC.nearestWalkable(f, c[0], c[1], g0.hero.r, 60); portalsUsed.add(p.id); push(n[0], n[1], k);
    }
  }
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const nx = x + dx * STEP, ny = y + dy * STEP;
    if (MC.walkable(f, nx, ny, g0.hero.r) && !locked(nx, ny, k)) push(nx, ny, k);
  }
}
console.log("goal reachable:", goal ? "YES at " + goal.map(Math.round) : "NO");
console.log("items collectable:", [...gotKeys].join(", ") || "none", "| portals used:", [...portalsUsed].join(","));
console.log("ALL regions reached:", ann.regions.map((r) => r.name + (regionsReached.has(r.name) ? "+" : "-")).join(" "));
console.log("named regions reached:", [...regionsReached].filter((n) => ["start","goal","water","goggles"].includes(n)).join(", "));

if (process.env.DUMP) { // write reached cells for visualisation
  const out = []; for (let k = 0; k < (1 << keyIds.length); k++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (seen[idx(x, y, k)]) out.push([x * STEP, y * STEP, k]);
  fs.writeFileSync(process.env.DUMP, JSON.stringify(out));
}

process.exit(goal ? 0 : 1);
