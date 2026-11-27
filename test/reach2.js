// Solvability under the full rules (items, sword durability, monsters, controller + megaportal).
// usage: node test/reach2.js <folder with annotations.json + game.json>   (env DUMP=file.json writes a report)
const fs = require("fs"), MC = require("../static/game-core.js");
const dir = process.argv[2], ann = JSON.parse(fs.readFileSync(dir + "/annotations.json")), cfg = JSON.parse(fs.readFileSync(dir + "/game.json"));
const f = MC.buildField(ann.lines, ann.image.w, ann.image.h), g0 = MC.createGame(ann, cfg, f);
const STEP = +process.env.STEP || 3, W = Math.ceil(f.w / STEP), H = Math.ceil(f.h / STEP), r = g0.hero.r;
const IT = g0.items, NI = IT.length, MN = g0.monsters, NM = MN.length;
const needsIdx = g0.monsterCfg ? IT.findIndex((i) => i.id === g0.monsterCfg.needs) : -1, maxDur = needsIdx >= 0 ? IT[needsIdx].durability : 0;
const pop = (x) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };
const byId = {}; ann.regions.forEach((q) => (byId[q.id] = q));
const canFight = (k, km) => needsIdx >= 0 && !!(k & (1 << needsIdx)) && pop(km) * (g0.monsterCfg.cost || 1) < maxDur;
const monAt = (x, y, km) => { for (let i = 0; i < NM; i++) if (!(km & (1 << i)) && MC.regionContains(MN[i], x, y)) return i; return -1; };
const lockedAt = (x, y, k) => g0.locks.some((l) => !(k & (1 << IT.findIndex((i) => i.id === l.needs))) && MC.regionContains(l.r, x, y));
const NS = 1 << (NI + NM), seen = new Uint8Array(W * H * NS), enc = (X, Y, fl) => (fl * H + Y) * W + X;
const q = []; let qi = 0;
const parent = new Map(); // only recorded for the first visit of interesting states (memory-light path tracing)
function arrive(x, y, k, km, from) { // apply everything that happens when standing at (x,y); returns false if not allowed
  const mi = monAt(x, y, km); let k2 = k, km2 = km;
  if (mi >= 0) { if (!canFight(k, km)) return false; km2 |= 1 << mi; }
  for (let i = 0; i < NI; i++) if (IT[i].r && !(k2 & (1 << i)) && !(k & (1 << (NI + 0)) && false) && MC.regionTouches(IT[i].r, x, y, g0.touch)) k2 |= 1 << i;
  // a broken sword is gone: modelled by canFight (durability), pickups only happen once because flag stays set
  const X = Math.round(x / STEP), Y = Math.round(y / STEP); if (X < 0 || Y < 0 || X >= W || Y >= H) return false;
  const s = enc(X, Y, k2 | (km2 << NI)); if (seen[s]) return true; seen[s] = 1; q.push(s); if (from !== undefined) parent.set(s, from); return true;
}
const land = (reg, k, km, from) => { const c = MC.regionCenter(reg), n = MC.nearestWalkable(f, c[0], c[1], r, 60); arrive(n[0], n[1], k, km, from); };
arrive(g0.hero.x, g0.hero.y, 0, 0);
const goalAt = {}, mpSeen = new Set(), destSeen = new Set(), portalsUsed = new Set(), monKilledEver = new Set();
let minKills = 99, bestState = -1;
while (qi < q.length) {
  const s = q[qi++]; const X = s % W, Y = ((s / W) | 0) % H, fl = (s / (W * H)) | 0, k = fl & ((1 << NI) - 1), km = fl >> NI, x = X * STEP, y = Y * STEP;
  for (let i = 0; i < NM; i++) if (km & (1 << i)) monKilledEver.add(MN[i].name);
  if (g0.goal && MC.regionTouches(g0.goal, x, y, g0.touch)) { const c = pop(km); if (c < minKills) { minKills = c; bestState = s; } goalAt[km] = 1; continue; }
  for (const p of g0.portals) {
    const A = byId[p.a], B = byId[p.b], d = p.dir || "both";
    for (const [from, to, ok] of [[A, B, d !== "ba"], [B, A, d !== "ab"]]) if (ok && from && to && MC.regionContains(from, x, y)) { portalsUsed.add(p.id); land(to, k, km, s); }
  }
  if (g0.mega && MC.regionTouches(g0.mega.r, x, y, g0.touch)) {
    const need = IT.findIndex((i) => i.id === g0.mega.needs);
    if (k & (1 << need)) { mpSeen.add(1); g0.mega.choices.forEach((c) => { destSeen.add(c.key); land(c.r, k, km, s); }); }
  }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue; const nx = x + dx * STEP, ny = y + dy * STEP;
    if (!MC.walkable(f, nx, ny, r) || lockedAt(nx, ny, k)) continue;
    arrive(nx, ny, k, km, s);
  }
}
const names = (km) => MN.filter((_, i) => km & (1 << i)).map((m) => m.name);
const ways = Object.keys(goalAt).map((km) => names(+km).sort().join("+") || "(none)");
console.log("states explored:", q.length);
console.log("finish reachable:", minKills < 99 ? "YES" : "NO");
if (minKills < 99) { console.log("fewest monsters fought on a winning run:", minKills, "| distinct winning fight-sets:", ways.length); console.log("  e.g.", ways.slice(0, 6).join("  |  ")); }
console.log("megaportal reached with controller:", mpSeen.size ? "yes" : "no", "| destinations offered:", [...destSeen].join(","));
console.log("portals used:", [...portalsUsed].sort().join(","), "| monsters that can be fought:", [...monKilledEver].sort().join(","));
const mustFight = MN.filter((m) => ways.length && Object.keys(goalAt).every((km) => +km & (1 << MN.indexOf(m)))).map((m) => m.name);
console.log("monsters on EVERY winning run:", mustFight.join(",") || "none", "| avoidable:", MN.filter((m) => !mustFight.includes(m.name)).map((m) => m.name).join(",") || "none");
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify({ minKills, ways, mustFight }));
process.exit(minKills < 99 ? 0 : 1);
