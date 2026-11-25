/* Maze annotator front-end (no build step, no dependencies).
 * Step 1: crop + detect lines (sliders).  Step 2: annotate (eraser / line / regions / portals) + playtest.
 * The scan is never modified; everything saved is metadata on top of it (annotations.json).
 */
(() => {
  const MC = window.MazeCore;
  const $ = (s) => document.querySelector(s);
  const cv = $('#cv'), ctx = cv.getContext('2d'), wrap = $('#wrap');

  const S = {
    name: null, project: null, ann: null, img: null, stage: 'detect',
    view: { k: 1, ox: 0, oy: 0 },
    tool: 'select', opts: { eraser: 14, line: 'free', region: 'polygon' },
    layers: { scan: true, auto: true, drawn: true, regions: true, portals: true },
    scanOpacity: 1, showPreview: true,
    crop: { x: 0, y: 0, w: 100, h: 100 }, params: { threshold: 0.12, minlen: 18, simplify: 2 },
    preview: null, detectToken: 0, detecting: false,
    sel: null, pending: null, draft: null, drag: null, mouse: null, space: false,
    userView: false, grid: true, baseV: 0, rotToken: 0, rotTimer: null,
    hist: [], redo: [], play: null, saveTimer: null, detectTimer: null,
  };

  /* ---------------- small helpers ---------------- */
  const status = (t) => ($('#status').textContent = t || '');
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) { /* non-json error */ }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image failed: ' + src)); i.src = src; });
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const baseUrl = () => `/p/${S.name}/base.jpg?${S.baseV}`;
  const imgSize = () => (S.stage === 'detect' ? S.project.scan_size : [S.ann.image.w, S.ann.image.h]);
  const bbCache = new WeakMap();
  const bbox = (L) => {
    let b = bbCache.get(L);
    if (!b) { b = [1e9, 1e9, -1e9, -1e9]; for (const p of L.pts) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); } bbCache.set(L, b); }
    return b;
  };
  const nid = (p, arr) => p + (1 + arr.reduce((m, o) => Math.max(m, parseInt(String(o.id).replace(/\D/g, '') || 0)), 0));

  function rdp(pts, eps) { // Ramer–Douglas–Peucker
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); let md = 0, mi = -1;
      const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
      if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function densify(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    return out;
  }

  /* ---------------- view ---------------- */
  function resize() {
    const dpr = devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(cv.clientWidth * dpr)); cv.height = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (S.project && S.img && !S.userView) fit();
    render();
  }
  function fit() {
    if (!S.project) return;
    const [w, h] = imgSize(), cw = wrap.clientWidth, ch = wrap.clientHeight, k = Math.min(cw / w, ch / h) * 0.96;
    S.view = { k, ox: (cw - w * k) / 2, oy: (ch - h * k) / 2 }; S.userView = false;
  }
  const toWorld = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - S.view.ox) / S.view.k, y: (e.clientY - r.top - S.view.oy) / S.view.k }; };
  const toScreen = (x, y) => [x * S.view.k + S.view.ox, y * S.view.k + S.view.oy];

  /* ---------------- history + autosave ---------------- */
  const core = () => JSON.stringify({ lines: S.ann.lines, regions: S.ann.regions, portals: S.ann.portals });
  function snap() { S.hist.push(core()); if (S.hist.length > 100) S.hist.shift(); S.redo = []; const u = $('#undo'); if (u) u.disabled = false; }
  function restore(json) { const u = $('#undo'); if (u) u.disabled = !S.hist.length; const c = JSON.parse(json); Object.assign(S.ann, c); if (S.sel && !findSel()) S.sel = null; S.pending = null; markDirty(); buildPanel(); render(); }
  function undo() { if (!S.hist.length) return; S.redo.push(core()); restore(S.hist.pop()); }
  function redo() { if (!S.redo.length) return; S.hist.push(core()); restore(S.redo.pop()); }
  function markDirty() {
    status('unsaved…'); clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(async () => {
      try { await api(`/api/project/${S.name}/annotations`, S.ann); status('saved'); } catch (e) { status('SAVE FAILED: ' + e.message); }
    }, 700);
  }
  const findSel = () => S.sel && (S.sel.type === 'region' ? S.ann.regions.find((r) => r.id === S.sel.id) : S.ann.portals.find((p) => p.id === S.sel.id));

  /* ---------------- projects ---------------- */
  async function listProjects(selectName) {
    const names = await api('/api/projects'), sel = $('#proj');
    sel.innerHTML = names.length ? names.map((n) => `<option>${n}</option>`).join('') : '<option value="">(no projects)</option>';
    if (selectName) sel.value = selectName;
    return names;
  }
  async function openProject(name) {
    if (!name) { S.project = null; buildPanel(); buildTools(); render(); return; }
    stopPlay();
    const d = await api('/api/project/' + name);
    S.name = name; S.project = d.project; S.ann = d.annotations; S.crop = { ...d.project.crop }; S.params = { ...d.project.params };
    S.hist = []; S.redo = []; S.sel = null; S.preview = null; S.draft = null;
    if (d.project.stage === 'edit' && d.annotations) { S.img = await loadImg(`/p/${name}/work.jpg?${Date.now()}`); S.stage = 'edit'; }
    else { S.baseV = Date.now(); S.img = await loadImg(baseUrl()); S.stage = 'detect'; runDetect(); }
    fit(); buildTools(); buildPanel(); render(); status('');
  }
  async function newProject(file) {
    let name = (file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'maze').slice(0, 40);
    name = prompt('Project name (letters, digits, - and _):', name); if (!name) return;
    status('uploading…');
    const r = await fetch('/api/upload?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
    const j = await r.json(); if (!r.ok) { status(''); alert(j.error); return; }
    await listProjects(name); await openProject(name);
  }

  /* ---------------- step 1: crop + detect ---------------- */
  function runDetect(delay = 0) {
    clearTimeout(S.detectTimer);
    S.detectTimer = setTimeout(async () => {
      const token = ++S.detectToken; S.detecting = true; status('detecting…'); buildPanel(true);
      try {
        const res = await api(`/api/project/${S.name}/detect`, { crop: S.crop, params: S.params });
        if (token !== S.detectToken) return;
        S.preview = res; status(`${res.lines.length} lines detected`);
      } catch (e) { status('detect failed: ' + e.message); }
      S.detecting = false; buildPanel(true); render();
    }, delay);
  }
  function cropHandles() {
    const c = S.crop, mx = c.x + c.w / 2, my = c.y + c.h / 2, r = c.x + c.w, b = c.y + c.h;
    return [['nw', c.x, c.y], ['ne', r, c.y], ['sw', c.x, b], ['se', r, b], ['n', mx, c.y], ['s', mx, b], ['w', c.x, my], ['e', r, my]];
  }
  function hitCrop(p) {
    const k = S.view.k, c = S.crop;
    for (const [n, x, y] of cropHandles()) if (Math.hypot(x - p.x, y - p.y) * k <= 15) return n;
    const t = 9 / k, inX = p.x >= c.x - t && p.x <= c.x + c.w + t, inY = p.y >= c.y - t && p.y <= c.y + c.h + t; // grab an edge anywhere along it
    if (inX && Math.abs(p.y - c.y) <= t) return 'n';
    if (inX && Math.abs(p.y - c.y - c.h) <= t) return 's';
    if (inY && Math.abs(p.x - c.x) <= t) return 'w';
    if (inY && Math.abs(p.x - c.x - c.w) <= t) return 'e';
    return p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h ? 'move' : null;
  }
  function syncCropInputs() { for (const k of ['x', 'y', 'w', 'h']) { const el = $('#c_' + k); if (el && document.activeElement !== el) el.value = Math.round(S.crop[k]); } }
  async function doRotate(q, a) {
    const token = ++S.rotToken; status('rotating…');
    try {
      const res = await api(`/api/project/${S.name}/rotate`, { q, a });
      if (token !== S.rotToken) return;
      S.project = res.project; S.crop = { ...res.project.crop }; S.baseV = Date.now(); S.preview = null;
      S.img = await loadImg(baseUrl()); fit(); buildPanel(); render(); runDetect(); status('rotated (original photo untouched)');
    } catch (e) { status('rotate failed: ' + e.message); }
  }
  function dragCrop(p) {
    const d = S.drag, o = d.crop0, [W, H] = S.project.scan_size, dx = p.x - d.start.x, dy = p.y - d.start.y, min = 40;
    let { x, y, w, h } = o;
    if (d.h === 'move') { x = Math.max(0, Math.min(W - w, o.x + dx)); y = Math.max(0, Math.min(H - h, o.y + dy)); }
    else {
      if (d.h.includes('w')) { x = Math.max(0, Math.min(o.x + o.w - min, o.x + dx)); w = o.x + o.w - x; }
      if (d.h.includes('e')) w = Math.max(min, Math.min(W - o.x, o.w + dx));
      if (d.h.includes('n')) { y = Math.max(0, Math.min(o.y + o.h - min, o.y + dy)); h = o.y + o.h - y; }
      if (d.h.includes('s')) h = Math.max(min, Math.min(H - o.y, o.h + dy));
    }
    S.crop = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }
  async function accept() {
    if (S.project.stage === 'edit' && !confirm('Re-detecting replaces the auto-detected lines (erasing you did on them is lost).\nRegions, portals and lines you drew are kept if the crop is unchanged, otherwise they are reset.\nContinue?')) return;
    status('accepting…');
    try {
      const res = await api(`/api/project/${S.name}/accept`, { crop: S.crop, params: S.params });
      S.ann = res.annotations; S.project = res.project;
      if (S.ann.reset) alert('The crop changed, so regions / portals / drawn lines were reset.');
      delete S.ann.reset;
      S.img = await loadImg(`/p/${S.name}/work.jpg?${Date.now()}`); S.stage = 'edit'; S.hist = []; S.redo = []; S.sel = null;
      fit(); buildTools(); buildPanel(); render(); status('lines accepted — annotate away');
    } catch (e) { status(''); alert('accept failed: ' + e.message); }
  }
  async function backToDetect() {
    stopPlay(); S.baseV = Date.now(); S.img = await loadImg(baseUrl()); S.stage = 'detect'; S.crop = { ...S.ann.crop }; S.params = { ...S.project.params };
    fit(); buildTools(); buildPanel(); render(); runDetect();
  }

  /* ---------------- step 2: editing ---------------- */
  function eraseAt(x, y, r) {
    const out = []; let changed = false;
    for (const L of S.ann.lines) {
      const b = bbox(L);
      if (x + r < b[0] || x - r > b[2] || y + r < b[1] || y - r > b[3]) { out.push(L); continue; }
      const dense = densify(L.pts, 2), runs = []; let cur = [];
      for (const p of dense) { if (Math.hypot(p[0] - x, p[1] - y) <= r) { if (cur.length) { runs.push(cur); cur = []; } } else cur.push(p); }
      if (cur.length) runs.push(cur);
      if (runs.length === 1 && runs[0].length === dense.length) { out.push(L); continue; }
      changed = true;
      for (const run of runs) if (run.length >= 2) out.push({ id: nid('l', S.ann.lines) + '_' + out.length, pts: rdp(run, 0.8), src: L.src });
    }
    if (changed) { S.ann.lines = out; markDirty(); }
  }
  function finishLine() {
    const d = S.draft; S.draft = null;
    if (!d) return;
    let pts = d.pts; if (S.opts.line === 'free') pts = rdp(pts, 1.0);
    if (pts.length < 2) return render();
    snap(); S.ann.lines.push({ id: nid('d', S.ann.lines), pts, src: 'drawn' }); markDirty(); render();
  }
  function finishRegion() {
    const d = S.draft; S.draft = null;
    if (!d) return;
    let reg = null;
    if (d.shape === 'ellipse') {
      const [a, b] = d.pts, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      if (rx < 2 || ry < 2) return render();
      reg = { shape: 'ellipse', cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx, ry };
    } else {
      if (d.pts.length < 3) return render();
      reg = { shape: 'polygon', pts: d.pts };
    }
    const name = prompt('Name this region (e.g. start, finish, water, goggles):', 'region ' + (S.ann.regions.length + 1));
    if (name === null) return render();
    snap(); reg.id = nid('r', S.ann.regions); reg.name = name.trim() || reg.id; reg.props = {};
    S.ann.regions.push(reg); S.sel = { type: 'region', id: reg.id }; markDirty(); buildPanel(); render();
  }
  function regionDist(r, x, y) {
    if (r.shape === 'ellipse') { const dx = (x - r.cx) / r.rx, dy = (y - r.cy) / r.ry, q = Math.hypot(dx, dy); return q <= 1 ? 0 : (q - 1) * Math.min(r.rx, r.ry); }
    if (MC.pointInPoly(r.pts, x, y)) return 0;
    let m = 1e9;
    for (let i = 0, j = r.pts.length - 1; i < r.pts.length; j = i++) {
      const [ax, ay] = r.pts[j], [bx, by] = r.pts[i], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)); m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return m;
  }
  function pickRegion(x, y) { // smallest region containing the point, else nearest within a few screen px (thin portals!)
    const tol = 10 / S.view.k; let inside = null, near = null;
    for (const r of S.ann.regions) {
      const d = regionDist(r, x, y);
      if (d === 0) { if (!inside || MC.regionArea(r) < MC.regionArea(inside)) inside = r; }
      else if (d <= tol && (!near || d < near.d)) near = { r, d };
    }
    return inside || (near && near.r) || null;
  }
  function moveRegion(r, dx, dy) {
    if (r.shape === 'ellipse') { r.cx += dx; r.cy += dy; } else r.pts = r.pts.map((p) => [p[0] + dx, p[1] + dy]);
  }
  function deleteSelected() {
    const s = findSel(); if (!s) return;
    snap();
    if (S.sel.type === 'region') { S.ann.regions = S.ann.regions.filter((r) => r.id !== s.id); S.ann.portals = S.ann.portals.filter((p) => p.a !== s.id && p.b !== s.id); }
    else S.ann.portals = S.ann.portals.filter((p) => p.id !== s.id);
    S.sel = null; markDirty(); buildPanel(); render();
  }

  /* ---------------- playtest ---------------- */
  function startPlay() {
    if (S.stage !== 'edit' || S.play) return;
    const { w, h } = S.ann.image, field = MC.buildField(S.ann.lines, w, h), r = S.project.hero_radius || 4;
    const st = MC.findRegion(S.ann.regions, 'start');
    const m = S.lastMouse;
    let c = st ? MC.regionCenter(st) : (m && m.x >= 0 && m.x < w && m.y >= 0 && m.y < h ? [m.x, m.y] : [w / 2, h / 2]);
    const p = MC.nearestWalkable(field, c[0], c[1], r, 80), hero = MC.newHero(p[0], p[1], r);
    for (const q of S.ann.portals) for (const id of [q.a, q.b]) { const R = S.ann.regions.find((x) => x.id === id); if (R && MC.regionContains(R, hero.x, hero.y)) hero.inactive.add(id); }
    S.play = { field, hero, keys: new Set(), pointer: null, last: performance.now(), raf: 0, speed: MC.speedFor(w, h) };
    const loop = (now) => {
      if (!S.play) return;
      const P = S.play, dt = Math.min(0.05, (now - P.last) / 1000); P.last = now;
      let v = MC.keyVector(P.keys); if (!v[0] && !v[1]) v = MC.pointerVector(P.hero, P.pointer);
      if (v[0] || v[1]) MC.moveHero(P.field, P.hero, v[0], v[1], P.speed * dt);
      MC.updatePortals(P.field, P.hero, S.ann.regions, S.ann.portals);
      render(); P.raf = requestAnimationFrame(loop);
    };
    S.play.raf = requestAnimationFrame(loop); buildTools(); buildPanel(); status('playtest: arrows/WASD/numpad, or hold the mouse · P or Esc to stop');
  }
  function stopPlay() { if (!S.play) return; cancelAnimationFrame(S.play.raf); S.play = null; buildTools(); buildPanel(); render(); status(''); }

  /* ---------------- rendering ---------------- */
  function pathRegion(r) {
    ctx.beginPath();
    if (r.shape === 'ellipse') ctx.ellipse(r.cx, r.cy, r.rx, r.ry, 0, 0, Math.PI * 2);
    else { r.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); }
  }
  function strokeLines(lines, color, w) {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
    for (const L of lines) { ctx.moveTo(L.pts[0][0], L.pts[0][1]); for (let i = 1; i < L.pts.length; i++) ctx.lineTo(L.pts[i][0], L.pts[i][1]); }
    ctx.stroke();
  }
  function arrow(x, y, ang, s) {
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - s * Math.cos(ang - 0.45), y - s * Math.sin(ang - 0.45)); ctx.lineTo(x - s * Math.cos(ang + 0.45), y - s * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill();
  }
  function render() {
    const v = S.view, dpr = cv.width / Math.max(1, cv.clientWidth), dprY = cv.height / Math.max(1, cv.clientHeight);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#242426'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (!S.project || !S.img) { ctx.fillStyle = '#888'; ctx.font = `${16 * dpr}px sans-serif`; ctx.fillText('Create a project: “+ New project…” and pick a scan photo', 30 * dpr, 50 * dpr); return; }
    ctx.setTransform(dpr * v.k, 0, 0, dprY * v.k, dpr * v.ox, dprY * v.oy);
    const k = v.k, px = 1 / k; // 1 screen pixel in world units
    if (S.stage === 'detect') renderDetect(k, px); else renderEdit(k, px);
  }
  function renderDetect(k, px) {
    const [W, H] = S.project.scan_size, c = S.crop;
    ctx.globalAlpha = S.scanOpacity; ctx.drawImage(S.img, 0, 0, W, H); ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, W, c.y); ctx.fillRect(0, c.y + c.h, W, H - c.y - c.h); ctx.fillRect(0, c.y, c.x, c.h); ctx.fillRect(c.x + c.w, c.y, W - c.x - c.w, c.h);
    if (S.preview && S.showPreview) {
      const pc = S.preview.crop, s = S.preview.scale;
      strokeLines(S.preview.lines.map((l) => ({ pts: l.map((p) => [pc.x + p[0] / s, pc.y + p[1] / s]) })), '#2f7bff', 2 * px);
    }
    if (S.grid) {
      const step = [10, 20, 25, 50, 100, 200, 250, 500].find((v) => v >= 60 / k) || 500;
      ctx.strokeStyle = 'rgba(120,220,255,.5)'; ctx.lineWidth = px; ctx.beginPath();
      for (let x = step; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = step; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
    }
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2 * px; ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#000'; ctx.lineWidth = px; for (const [, x, y] of cropHandles()) { ctx.fillRect(x - 7 * px, y - 7 * px, 14 * px, 14 * px); ctx.strokeRect(x - 7 * px, y - 7 * px, 14 * px, 14 * px); }
  }
  function renderEdit(k, px) {
    const A = S.ann, L = S.layers, { w, h } = A.image;
    if (L.scan) ctx.drawImage(S.img, 0, 0, w, h);
    if (L.auto) strokeLines(A.lines.filter((l) => l.src === 'auto'), '#2f7bff', 1.8 * px);
    if (L.drawn) strokeLines(A.lines.filter((l) => l.src === 'drawn'), '#ff8a1f', 2.2 * px);
    if (L.regions) for (const r of A.regions) {
      const hh = hue(r.name), sel = S.sel && S.sel.type === 'region' && S.sel.id === r.id, pend = S.pending === r.id;
      pathRegion(r); ctx.fillStyle = `hsla(${hh},80%,55%,${sel ? 0.4 : 0.22})`; ctx.fill();
      ctx.strokeStyle = `hsl(${hh},85%,${sel || pend ? 75 : 55}%)`; ctx.lineWidth = (sel || pend ? 3.5 : 1.8) * px; ctx.stroke();
      const c = MC.regionCenter(r); ctx.font = `${13 * px}px sans-serif`; ctx.textAlign = 'center'; ctx.lineWidth = 3 * px; ctx.strokeStyle = '#000c'; ctx.strokeText(r.name, c[0], c[1] - 6 * px); ctx.fillStyle = '#fff'; ctx.fillText(r.name, c[0], c[1] - 6 * px);
    }
    if (L.portals) for (const p of A.portals) {
      const a = A.regions.find((r) => r.id === p.a), b = A.regions.find((r) => r.id === p.b); if (!a || !b) continue;
      const ca = MC.regionCenter(a), cb = MC.regionCenter(b), sel = S.sel && S.sel.type === 'portal' && S.sel.id === p.id;
      ctx.strokeStyle = ctx.fillStyle = sel ? '#fff' : '#ff4fd8'; ctx.lineWidth = (sel ? 3 : 2) * px; ctx.setLineDash([7 * px, 5 * px]);
      ctx.beginPath(); ctx.moveTo(ca[0], ca[1]); ctx.lineTo(cb[0], cb[1]); ctx.stroke(); ctx.setLineDash([]);
      const ang = Math.atan2(cb[1] - ca[1], cb[0] - ca[0]), d = p.dir || 'both', s = 12 * px;
      if (d !== 'ba') arrow(cb[0] - Math.cos(ang) * 4 * px, cb[1] - Math.sin(ang) * 4 * px, ang, s);
      if (d !== 'ab') arrow(ca[0] + Math.cos(ang) * 4 * px, ca[1] + Math.sin(ang) * 4 * px, ang + Math.PI, s);
    }
    const d = S.draft;
    if (d) {
      ctx.strokeStyle = d.kind === 'line' ? '#ffd23f' : '#fff'; ctx.lineWidth = 2 * px; ctx.setLineDash(d.kind === 'region' ? [6 * px, 4 * px] : []);
      const pts = d.pts.concat(S.mouse && d.hover ? [[S.mouse.x, S.mouse.y]] : []);
      if (d.kind === 'region' && d.shape === 'ellipse' && d.pts.length === 2) {
        const [a, b] = d.pts; ctx.beginPath(); ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, 7); ctx.stroke();
      } else { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke(); }
      ctx.setLineDash([]); ctx.fillStyle = '#ffd23f'; for (const p of d.pts) ctx.fillRect(p[0] - 2.5 * px, p[1] - 2.5 * px, 5 * px, 5 * px);
    }
    if (S.tool === 'eraser' && S.mouse && !S.play) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * px; ctx.beginPath(); ctx.arc(S.mouse.x, S.mouse.y, S.opts.eraser, 0, 7); ctx.stroke(); }
    if (S.play) {
      const hero = S.play.hero, R = hero.r + 2.5;
      ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(hero.x, hero.y, R, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(hero.x - R * .35, hero.y - R * .2, R * .14, 0, 7); ctx.arc(hero.x + R * .35, hero.y - R * .2, R * .14, 0, 7); ctx.fill();
    }
  }

  /* ---------------- UI: tools + panel ---------------- */
  const TOOLS = [['select', 'Select', 'V'], ['eraser', 'Eraser', 'E'], ['line', 'Line', 'D'], ['region', 'Region', 'R'], ['portal', 'Portal', 'T']];
  function setTool(t) { S.tool = t; S.draft = null; S.pending = null; buildTools(); buildPanel(); render(); }
  function buildTools() {
    const el = $('#tools'); $('#st1').classList.toggle('on', S.stage === 'detect'); $('#st2').classList.toggle('on', S.stage === 'edit');
    if (!S.project || S.stage !== 'edit') { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = TOOLS.map(([id, n, k]) => `<button data-t="${id}" class="${S.tool === id && !S.play ? 'on' : ''}" ${S.play ? 'disabled' : ''} title="${n} (${k})">${n}<br><kbd>${k}</kbd></button>`).join('') +
      `<hr style="width:100%;border-color:#333"><button id="undo" ${S.hist.length ? '' : 'disabled'} title="Undo (Ctrl+Z)">Undo</button><button id="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>` +
      `<hr style="width:100%;border-color:#333"><button id="play" class="${S.play ? 'on' : ''}" title="Playtest (P)">${S.play ? 'Stop' : 'Play'}<br><kbd>P</kbd></button>`;
    el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => setTool(b.dataset.t)));
    $('#undo').onclick = undo; $('#redo').onclick = redo; $('#play').onclick = () => (S.play ? stopPlay() : startPlay());
  }
  const slider = (id, label, min, max, step, val, fmt) => `<div class="row"><label>${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><span class="v" id="${id}v">${fmt ? fmt(val) : val}</span></div>`;
  function buildPanel(onlyDetectInfo) {
    const el = $('#panel');
    if (!S.project) { el.innerHTML = '<p class="hint">No project yet. Use “+ New project…” to upload a photo of the drawing.</p>'; return; }
    if (S.stage === 'detect') {
      if (onlyDetectInfo && $('#dinfo')) { $('#dinfo').textContent = S.detecting ? 'detecting…' : S.preview ? `${S.preview.lines.length} lines in the crop` : ''; return; }
      const rot = S.project.rotation || { q: 0, a: 0 };
      el.innerHTML = `<h4>1 · Rotate</h4>
        <div class="row"><button id="rotL" title="Turn 90° counter-clockwise">↺ 90°</button><button id="rotR" title="Turn 90° clockwise">↻ 90°</button><button id="rotReset">Reset</button></div>
        ${slider('p_rot', 'Straighten', -15, 15, 0.1, rot.a, (v) => (+v).toFixed(1) + '°')}
        <div class="row"><label style="flex:1"><input type="checkbox" id="grid" ${S.grid ? 'checked' : ''}> Show grid (to level the page)</label></div>
        <p class="hint">Applied to a copy; your original photo is never changed. Rotating resets the crop${S.project.stage === 'edit' ? ' and (on re-detect) your annotations' : ''}.</p>
        <h4>2 · Crop</h4><p class="hint">Drag the yellow box: corners, anywhere along an edge, or the middle to move it. Scroll = zoom, space/middle-drag = pan. Or type exact numbers:</p>
        <div class="row"><label style="flex:0 0 14px">x</label><input type="number" id="c_x" min="0"> <label style="flex:0 0 14px">y</label><input type="number" id="c_y" min="0"></div>
        <div class="row"><label style="flex:0 0 14px">w</label><input type="number" id="c_w" min="40"> <label style="flex:0 0 14px">h</label><input type="number" id="c_h" min="40"></div>
        <div class="row"><button id="fitcrop">Reset crop</button><button id="fitview">Fit view</button></div>
        <h4>3 · Line detection</h4>
        ${slider('p_th', 'Sensitivity', 0.03, 0.35, 0.005, S.params.threshold, (v) => (+v).toFixed(3))}
        <p class="hint">Lower = picks up fainter pencil (and more noise).</p>
        ${slider('p_ml', 'Min line length', 0, 80, 1, S.params.minlen)}
        <p class="hint">Drops short stubs and specks.</p>
        ${slider('p_sm', 'Simplify', 0.5, 6, 0.1, S.params.simplify, (v) => (+v).toFixed(1))}
        <p class="hint">Higher = fewer, straighter segments.</p>
        <div class="row"><label>Show detected</label><input type="checkbox" id="showprev" ${S.showPreview ? 'checked' : ''}></div>
        ${slider('p_op', 'Scan opacity', 0.1, 1, 0.05, S.scanOpacity, (v) => (+v).toFixed(2))}
        <p class="hint" id="dinfo">${S.detecting ? 'detecting…' : S.preview ? `${S.preview.lines.length} lines in the crop` : ''}</p>
        <button class="big" id="accept">${S.project.stage === 'edit' ? 'Re-detect &amp; keep annotating →' : 'Accept lines &amp; annotate →'}</button>
        ${S.project.stage === 'edit' ? '<button id="cancelDetect" style="width:100%">Cancel (back to annotating)</button>' : ''}`;
      $('#rotL').onclick = () => doRotate((rot.q + 3) % 4, rot.a);
      $('#rotR').onclick = () => doRotate((rot.q + 1) % 4, rot.a);
      $('#rotReset').onclick = () => doRotate(0, 0);
      $('#p_rot').oninput = (e) => { $('#p_rotv').textContent = (+e.target.value).toFixed(1) + '°'; clearTimeout(S.rotTimer); S.rotTimer = setTimeout(() => doRotate(rot.q, +e.target.value), 450); };
      $('#grid').onchange = (e) => { S.grid = e.target.checked; render(); };
      ['x', 'y', 'w', 'h'].forEach((k) => { const el = $('#c_' + k); el.oninput = () => {
        const v = Math.round(+el.value); if (!Number.isFinite(v) || el.value === '') return;
        const [W, H] = S.project.scan_size, c = { ...S.crop }; c[k] = v;
        c.x = Math.max(0, Math.min(c.x, W - 40)); c.y = Math.max(0, Math.min(c.y, H - 40)); c.w = Math.max(40, Math.min(c.w, W - c.x)); c.h = Math.max(40, Math.min(c.h, H - c.y));
        S.crop = c; render(); runDetect(600); }; });
      syncCropInputs();
      const bind = (id, key, num) => { $(id).oninput = (e) => { S.params[key] = +e.target.value; $(id + 'v').textContent = num ? (+e.target.value).toFixed(num) : e.target.value; runDetect(350); }; };
      bind('#p_th', 'threshold', 3); bind('#p_ml', 'minlen', 0); bind('#p_sm', 'simplify', 1);
      $('#p_op').oninput = (e) => { S.scanOpacity = +e.target.value; $('#p_opv').textContent = (+e.target.value).toFixed(2); render(); };
      $('#showprev').onchange = (e) => { S.showPreview = e.target.checked; render(); };
      $('#fitcrop').onclick = () => { const [W, H] = S.project.scan_size; S.crop = { x: 0, y: 0, w: W, h: H }; syncCropInputs(); runDetect(); render(); };
      $('#fitview').onclick = () => { fit(); render(); };
      $('#accept').onclick = accept;
      if ($('#cancelDetect')) $('#cancelDetect').onclick = async () => { S.img = await loadImg(`/p/${S.name}/work.jpg?${Date.now()}`); S.stage = 'edit'; fit(); buildTools(); buildPanel(); render(); };
      return;
    }
    // ----- step 2
    const A = S.ann, nameOf = (id) => (A.regions.find((r) => r.id === id) || { name: '?' }).name;
    const opt = S.tool === 'eraser' ? `<h4>Eraser</h4>${slider('o_er', 'Size', 3, 80, 1, S.opts.eraser)}<p class="hint">Drag over lines to cut them. <kbd>[</kbd> <kbd>]</kbd> change size.</p>`
      : S.tool === 'line' ? `<h4>Line</h4><div class="row"><button data-lm="free" class="${S.opts.line === 'free' ? 'on' : ''}">Freehand</button><button data-lm="straight" class="${S.opts.line === 'straight' ? 'on' : ''}">Straight</button></div><p class="hint">${S.opts.line === 'free' ? 'Drag to draw.' : 'Click points; double-click or Enter to finish, Esc cancels.'} Drawn lines block the hero like any other.</p>`
      : S.tool === 'region' ? `<h4>Region</h4><div class="row"><button data-rs="polygon" class="${S.opts.region === 'polygon' ? 'on' : ''}">Polygon</button><button data-rs="ellipse" class="${S.opts.region === 'ellipse' ? 'on' : ''}">Ellipse</button></div><p class="hint">${S.opts.region === 'polygon' ? 'Click corners; double-click, Enter, or click the first corner to close.' : 'Drag a box.'} You will be asked for a name. Regions never block the hero.</p>`
      : S.tool === 'portal' ? `<h4>Portal</h4><p class="hint">Click one region, then another, to connect them. A thin polygon across a corridor mouth makes a good tunnel entrance.${S.pending ? '<br><b>Now click the second region…</b>' : ''}</p>`
      : `<h4>Select</h4><p class="hint">Click a region to select, drag to move, <kbd>Del</kbd> deletes. Drag empty space (or hold space) to pan; scroll to zoom.</p>`;
    el.innerHTML = `${opt}
      <h4>Regions</h4>${A.regions.length ? A.regions.map((r) => `<div class="item ${S.sel && S.sel.type === 'region' && S.sel.id === r.id ? 'sel' : ''}" data-r="${r.id}"><span class="dot" style="background:hsl(${hue(r.name)},80%,55%)"></span><span class="nm">${r.name.replace(/</g, '&lt;')}</span><button data-ren="${r.id}" title="Rename">✎</button><button data-del="${r.id}" title="Delete">✕</button></div>`).join('') : '<p class="hint">none yet</p>'}
      <h4>Portals</h4>${A.portals.length ? A.portals.map((p) => `<div class="item ${S.sel && S.sel.type === 'portal' && S.sel.id === p.id ? 'sel' : ''}" data-p="${p.id}"><span class="nm">${nameOf(p.a).replace(/</g, '&lt;')}</span><button data-dir="${p.id}" title="Click to change direction">${{ both: '↔', ab: '→', ba: '←' }[p.dir || 'both']}</button><span class="nm">${nameOf(p.b).replace(/</g, '&lt;')}</span><button data-pdel="${p.id}" title="Delete">✕</button></div>`).join('') : '<p class="hint">none yet</p>'}
      <h4>Layers</h4>${['scan', 'auto', 'drawn', 'regions', 'portals'].map((l) => `<div class="row"><label style="flex:1"><input type="checkbox" data-l="${l}" ${S.layers[l] ? 'checked' : ''}> ${{ scan: 'Drawing (scan)', auto: 'Detected lines', drawn: 'Drawn lines', regions: 'Regions', portals: 'Portals' }[l]}</label></div>`).join('')}
      <h4>Playtest</h4>${slider('h_r', 'Hero size', 1, 14, 0.5, S.project.hero_radius || 4)}
      <p class="hint">Small by default. Press <kbd>P</kbd> to walk around; the hero starts in a region named “start” (or at your mouse).</p>
      <h4>Project</h4><button id="export" style="width:100%">Export playable game</button><button id="redetect" style="width:100%;margin-top:6px">← Crop / re-detect lines</button>
      <p class="hint">${A.lines.length} lines · ${A.regions.length} regions · ${A.portals.length} portals. Autosaved.</p>`;
    const o = $('#o_er'); if (o) o.oninput = (e) => { S.opts.eraser = +e.target.value; $('#o_erv').textContent = e.target.value; render(); };
    el.querySelectorAll('[data-lm]').forEach((b) => (b.onclick = () => { S.opts.line = b.dataset.lm; S.draft = null; buildPanel(); }));
    el.querySelectorAll('[data-rs]').forEach((b) => (b.onclick = () => { S.opts.region = b.dataset.rs; S.draft = null; buildPanel(); }));
    el.querySelectorAll('[data-r]').forEach((b) => (b.onclick = (e) => { if (e.target.tagName === 'BUTTON') return; S.sel = { type: 'region', id: b.dataset.r }; buildPanel(); render(); }));
    el.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = () => { const r = A.regions.find((x) => x.id === b.dataset.ren), n = prompt('Rename region:', r.name); if (n && n.trim()) { snap(); r.name = n.trim(); markDirty(); buildPanel(); render(); } }));
    el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { S.sel = { type: 'region', id: b.dataset.del }; deleteSelected(); }));
    el.querySelectorAll('[data-p]').forEach((b) => (b.onclick = (e) => { if (e.target.tagName === 'BUTTON') return; S.sel = { type: 'portal', id: b.dataset.p }; buildPanel(); render(); }));
    el.querySelectorAll('[data-dir]').forEach((b) => (b.onclick = () => { const p = A.portals.find((x) => x.id === b.dataset.dir); snap(); p.dir = { both: 'ab', ab: 'ba', ba: 'both' }[p.dir || 'both']; markDirty(); buildPanel(); render(); }));
    el.querySelectorAll('[data-pdel]').forEach((b) => (b.onclick = () => { S.sel = { type: 'portal', id: b.dataset.pdel }; deleteSelected(); }));
    el.querySelectorAll('[data-l]').forEach((b) => (b.onchange = () => { S.layers[b.dataset.l] = b.checked; render(); }));
    $('#h_r').oninput = (e) => { S.project.hero_radius = +e.target.value; $('#h_rv').textContent = e.target.value; if (S.play) S.play.hero.r = +e.target.value; clearTimeout(S.heroT); S.heroT = setTimeout(() => api(`/api/project/${S.name}/project`, { hero_radius: S.project.hero_radius }), 500); };
    $('#export').onclick = async () => { try { const r = await api(`/api/project/${S.name}/export`, {}); alert(`Exported to ./${r.path}/\n\nTry it:  cd ${r.path} && python3 -m http.server 8001\n(it is a static folder: index.html, game-core.js, work.jpg, annotations.json)`); } catch (e) { alert('export failed: ' + e.message); } };
    $('#redetect').onclick = backToDetect;
  }

  /* ---------------- tips popup ---------------- */
  const TIPS = [
    ['Getting around', [
      'Scroll to zoom. Hold <kbd>Space</kbd> and drag (or drag with the middle/right mouse button) to pan.',
      '<kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redoes. Everything autosaves, with timestamped backups.']],
    ['Step 1 · rotate, crop, detect', [
      'Use the grid with <b>Straighten</b> to level the page, then crop away the page border.',
      'Faint pencil missing? Lower <b>Sensitivity</b>. Specks everywhere? Raise <b>Min line length</b>. Do this before erasing: re-detecting replaces the auto-detected lines.']],
    ['Step 2 · lines', [
      'Use the eraser on anything that is not a wall: stickers, handwriting, arrows, shadows. <kbd>[</kbd> and <kbd>]</kbd> change its size.',
      'Lines you draw block the hero just like detected ones. Regions never block.']],
    ['Regions &amp; portals', [
      '<b>Marking a circle (e.g. a trampoline) as a portal region:</b> the circle\'s own pencil lines are detected as walls, so the hero can\'t get inside it, and a region the hero can\'t reach never fires. <b>Erase the circle\'s lines first</b>, then draw the region slightly <b>bigger</b> than the circle so it overlaps the corridor.',
      'A tunnel is two very thin regions across its two mouths, joined by a bidirectional portal (the ↔ button in the list).',
      '<b>Tunnel ends:</b> after placing the thin portal region across each mouth, also draw lines (Line tool) on the <b>in-tunnel side</b> of those portals. They block the hero from walking into the area of the actual tunnel, so the only way through is the portal.',
      'After you land in a portal region it stays inactive until you walk out of it, so you can\'t bounce back and forth.',
      'Name a region <code>start</code> to choose where the hero starts.']],
    ['Playtest', [
      '<b>Hover the spot you want, then press <kbd>P</kbd>.</b> Unless a region is named <code>start</code>, the hero starts where your mouse pointer is (moved to the nearest open floor if it is on a wall). The Play button works too, but it uses the last place the pointer was over the picture, which is usually the edge you crossed on the way to the button, so <kbd>P</kbd> is more precise.',
      'Move with arrows, WASD or the numpad (two keys = diagonal), or hold the mouse button down to walk toward it. <kbd>Esc</kbd> or <kbd>P</kbd> stops.',
      'The hero size slider is in the panel; the default is very small.']],
  ];
  $('#tipsBody').innerHTML = TIPS.map(([title, items]) => `<h4>${title}</h4><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`).join('');
  const showTips = () => { $('#tips').hidden = false; };
  const hideTips = () => { $('#tips').hidden = true; };
  $('#tipsBtn').onclick = () => ($('#tips').hidden ? showTips() : hideTips());
  $('#tipsClose').onclick = hideTips;
  $('#tips').addEventListener('pointerdown', (e) => { if (e.target.id === 'tips') hideTips(); });

  /* ---------------- pointer / keyboard ---------------- */
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('wheel', (e) => {
    if (!S.project) return; e.preventDefault();
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, f = Math.pow(1.0015, -e.deltaY), v = S.view, nk = Math.max(0.05, Math.min(40, v.k * f));
    v.ox = mx - ((mx - v.ox) * nk) / v.k; v.oy = my - ((my - v.oy) * nk) / v.k; v.k = nk; S.userView = true; render();
  }, { passive: false });

  cv.addEventListener('pointerdown', (e) => {
    if (!S.project) return;
    cv.setPointerCapture(e.pointerId); const p = toWorld(e);
    if (e.button === 1 || e.button === 2 || S.space) { S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.ox, oy: S.view.oy }; return; }
    if (S.stage === 'detect') {
      const h = hitCrop(p);
      S.drag = h ? { type: 'crop', h, start: p, crop0: { ...S.crop } } : { type: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.ox, oy: S.view.oy };
      return;
    }
    if (S.play) { S.play.pointer = p; S.drag = { type: 'play' }; return; }
    const t = S.tool;
    if (t === 'select') {
      const r = pickRegion(p.x, p.y);
      if (r) { S.sel = { type: 'region', id: r.id }; S.drag = { type: 'move', last: p, snapped: false }; buildPanel(); render(); }
      else { S.sel = null; buildPanel(); S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.ox, oy: S.view.oy }; render(); }
    } else if (t === 'eraser') { snap(); S.drag = { type: 'erase' }; eraseAt(p.x, p.y, S.opts.eraser); render(); buildTools(); }
    else if (t === 'line') {
      if (S.opts.line === 'free') { S.draft = { kind: 'line', pts: [[p.x, p.y]] }; S.drag = { type: 'free' }; }
      else { if (!S.draft) S.draft = { kind: 'line', pts: [], hover: true }; const l = S.draft.pts[S.draft.pts.length - 1]; if (!l || Math.hypot(l[0] - p.x, l[1] - p.y) > 1.5 / S.view.k) S.draft.pts.push([p.x, p.y]); }
      render();
    } else if (t === 'region') {
      if (S.opts.region === 'ellipse') { S.draft = { kind: 'region', shape: 'ellipse', pts: [[p.x, p.y], [p.x, p.y]] }; S.drag = { type: 'ellipse' }; }
      else {
        if (!S.draft) S.draft = { kind: 'region', shape: 'polygon', pts: [], hover: true };
        const f = S.draft.pts[0];
        if (f && S.draft.pts.length >= 3 && Math.hypot(f[0] - p.x, f[1] - p.y) * S.view.k < 9) { finishRegion(); return; }
        const l = S.draft.pts[S.draft.pts.length - 1]; if (!l || Math.hypot(l[0] - p.x, l[1] - p.y) > 1.5 / S.view.k) S.draft.pts.push([p.x, p.y]);
      }
      render();
    } else if (t === 'portal') {
      const r = pickRegion(p.x, p.y); if (!r) return;
      if (!S.pending) { S.pending = r.id; buildPanel(); render(); }
      else if (S.pending !== r.id) {
        snap(); const portal = { id: nid('p', S.ann.portals), a: S.pending, b: r.id, dir: 'both' }; S.ann.portals.push(portal);
        S.pending = null; S.sel = { type: 'portal', id: portal.id }; markDirty(); buildPanel(); render(); buildTools();
      }
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const p = toWorld(e); S.mouse = p; S.lastMouse = p; const d = S.drag;
    if (d) {
      if (d.type === 'pan') { S.view.ox = d.ox + e.clientX - d.sx; S.view.oy = d.oy + e.clientY - d.sy; S.userView = true; }
      else if (d.type === 'crop') { dragCrop(p); syncCropInputs(); }
      else if (d.type === 'erase') eraseAt(p.x, p.y, S.opts.eraser);
      else if (d.type === 'play') S.play.pointer = p;
      else if (d.type === 'free') { const l = S.draft.pts[S.draft.pts.length - 1]; if (Math.hypot(l[0] - p.x, l[1] - p.y) > 2 / S.view.k) S.draft.pts.push([p.x, p.y]); }
      else if (d.type === 'ellipse') S.draft.pts[1] = [p.x, p.y];
      else if (d.type === 'move') {
        const r = S.ann.regions.find((x) => x.id === S.sel.id);
        if (r) { if (!d.snapped) { snap(); d.snapped = true; } moveRegion(r, p.x - d.last.x, p.y - d.last.y); d.last = p; markDirty(); }
      }
    }
    if (!S.play) render();
  });
  const endDrag = () => {
    const d = S.drag; S.drag = null; if (!d) return;
    if (d.type === 'crop') runDetect(100);
    else if (d.type === 'free') finishLine();
    else if (d.type === 'ellipse') finishRegion();
    else if (d.type === 'play') S.play && (S.play.pointer = null);
    else if (d.type === 'erase') buildTools();
    render();
  };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { if (!S.drag) { S.mouse = null; render(); } });
  cv.addEventListener('dblclick', () => {
    if (S.stage !== 'edit' || !S.draft) return;
    if (S.draft.kind === 'line' && S.opts.line === 'straight') finishLine();
    else if (S.draft.kind === 'region' && S.opts.region === 'polygon') finishRegion();
  });

  addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
    if (typing) return;
    if (!$('#tips').hidden) { if (e.code === 'Escape' || e.key === '?') { hideTips(); e.preventDefault(); } return; }
    if (e.key === '?') { showTips(); e.preventDefault(); return; }
    if (e.code === 'Space') { S.space = true; e.preventDefault(); }
    if (S.play) {
      if (e.code === 'KeyP' || e.code === 'Escape') { stopPlay(); return; }
      if (e.code.startsWith('Arrow') || e.code.startsWith('Numpad') || ['Home', 'End', 'PageUp', 'PageDown'].includes(e.code)) e.preventDefault();
      S.play.keys.add(e.code); return;
    }
    if (S.stage !== 'edit') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); buildTools(); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); buildTools(); return; }
    if (mod) return;
    const map = { KeyV: 'select', KeyE: 'eraser', KeyD: 'line', KeyR: 'region', KeyT: 'portal' };
    if (map[e.code]) setTool(map[e.code]);
    else if (e.code === 'KeyP') startPlay();
    else if (e.code === 'Escape') { S.draft = null; S.pending = null; buildPanel(); render(); }
    else if (e.code === 'Enter') { if (S.draft && S.draft.kind === 'line') finishLine(); else if (S.draft && S.draft.kind === 'region') finishRegion(); }
    else if (e.code === 'Delete' || e.code === 'Backspace') { deleteSelected(); }
    else if (e.code === 'BracketLeft' || e.code === 'BracketRight') { S.opts.eraser = Math.max(3, Math.min(80, S.opts.eraser + (e.code === 'BracketRight' ? 3 : -3))); if (S.tool === 'eraser') buildPanel(); render(); }
  });
  addEventListener('keyup', (e) => { if (e.code === 'Space') S.space = false; if (S.play) S.play.keys.delete(e.code); });
  addEventListener('blur', () => { S.space = false; if (S.play) S.play.keys.clear(); });
  $('#panel').addEventListener('change', (e) => { if (e.target.type === 'range') e.target.blur(); });
  addEventListener('resize', resize);
  new ResizeObserver(resize).observe(wrap); // also fires when the tools column shows/hides, which changes the canvas width

  $('#proj').onchange = (e) => openProject(e.target.value);
  $('#newProj').onclick = () => $('#file').click();
  $('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) newProject(f).catch((x) => alert(x.message)); };
  $('#st1').onclick = () => { if (S.project && S.stage === 'edit') backToDetect(); };
  $('#st2').onclick = () => { if (S.project && S.stage === 'detect' && S.project.stage === 'edit') $('#cancelDetect') && $('#cancelDetect').click(); };

  (async () => {
    resize();
    try { const names = await listProjects(); if (names.length) await openProject(names[0]); else { buildTools(); buildPanel(); render(); } }
    catch (e) { status('failed to load: ' + e.message); }
    window.__S = S; // handy for debugging / tests
  })();
})();
