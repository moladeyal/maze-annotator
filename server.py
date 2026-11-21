#!/usr/bin/env python3
"""Maze annotator dev server. Binds to 127.0.0.1 only; reach it with an ssh tunnel.

  python server.py [--port 8000] [--add scan.jpg --name maze1]

Data lives in ./projects/<name>/ (git-ignored, your drawings never leave the box):
  scan.jpg          the uploaded photo (never modified after upload)
  work.jpg          cropped/scaled image that annotations are drawn on (written on Accept)
  project.json      crop rectangle, detection sliders, hero size, stage
  annotations.json  lines, regions, portals (+ any extra keys, which are preserved)
  backups/          timestamped copies of annotations.json
"""
import argparse
import json
import os
import re
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

import detect

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
PROJECTS = os.environ.get("MAZE_PROJECTS") or os.path.join(ROOT, "projects")
DIST = os.environ.get("MAZE_DIST") or os.path.join(ROOT, "dist")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
MAX_UPLOAD = 60 * 1024 * 1024
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png"}

LOCK = threading.Lock()  # detection is CPU heavy; one at a time is plenty
_scan_cache = {}


def pdir(name):
    if not NAME_RE.match(name or ""):
        raise ValueError("bad project name (use letters, digits, - and _)")
    return os.path.join(PROJECTS, name)


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def get_scan(name):
    path = os.path.join(pdir(name), "scan.jpg")
    mtime = os.path.getmtime(path)
    hit = _scan_cache.get(name)
    if hit and hit[0] == mtime:
        return hit[1]
    im = detect.load_scan(path)
    _scan_cache.clear()
    _scan_cache[name] = (mtime, im)
    return im


def create_project(name, image_bytes):
    d = pdir(name)
    im = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)  # applies EXIF rotation
    if im is None:
        raise ValueError("not an image")
    H, W = im.shape[:2]
    if max(H, W) > 4000:
        s = 4000 / max(H, W)
        im = cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        H, W = im.shape[:2]
    os.makedirs(d, exist_ok=True)
    cv2.imwrite(os.path.join(d, "scan.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 93])
    proj = {"name": name, "stage": "detect", "scan_size": [W, H],
            "crop": {"x": 0, "y": 0, "w": W, "h": H},
            "params": {"threshold": 0.12, "minlen": 18, "simplify": 2.0},
            "hero_radius": 4}
    write_json(os.path.join(d, "project.json"), proj)
    _scan_cache.clear()
    return proj


def new_id(prefix, items, key="id"):
    n = 1 + max([int(re.sub(r"\D", "", str(i.get(key, "0"))) or 0) for i in items] + [0])
    return f"{prefix}{n}"


def accept(name, crop, params):
    d = pdir(name)
    im = get_scan(name)
    with LOCK:
        work, scale, c = detect.make_work(im, crop)
        lines = detect.detect(work, **params)
    cv2.imwrite(os.path.join(d, "work.jpg"), work, [cv2.IMWRITE_JPEG_QUALITY, 93])
    h, w = work.shape[:2]
    old = read_json(os.path.join(d, "annotations.json"), None)
    same = bool(old and old.get("crop") == c and abs(old.get("scale", 0) - scale) < 1e-9)
    ann = dict(old) if same else {}
    kept = [l for l in (old or {}).get("lines", []) if l.get("src") == "drawn"] if same else []
    auto = [{"id": f"a{i + 1}", "pts": p, "src": "auto"} for i, p in enumerate(lines)]
    ann.update({"version": 1, "image": {"w": w, "h": h, "file": "work.jpg"}, "scale": scale, "crop": c,
                "lines": auto + kept})
    ann.setdefault("regions", [])
    ann.setdefault("portals", [])
    ann["reset"] = not same and bool(old)  # told to the client so it can warn
    write_json(os.path.join(d, "annotations.json"), {k: v for k, v in ann.items() if k != "reset"})
    proj = read_json(os.path.join(d, "project.json"))
    proj.update({"stage": "edit", "crop": c, "params": params, "work_size": [w, h], "scale": scale})
    write_json(os.path.join(d, "project.json"), proj)
    return ann, proj


def save_annotations(name, ann):
    d = pdir(name)
    path = os.path.join(d, "annotations.json")
    bdir = os.path.join(d, "backups")
    os.makedirs(bdir, exist_ok=True)
    existing = sorted(os.listdir(bdir))
    now = time.time()
    if os.path.exists(path) and (not existing or now - os.path.getmtime(os.path.join(bdir, existing[-1])) > 120):
        shutil.copy(path, os.path.join(bdir, time.strftime("annotations-%Y%m%d-%H%M%S.json")))
        for old in sorted(os.listdir(bdir))[:-30]:
            os.remove(os.path.join(bdir, old))
    write_json(path, ann)


def export(name):
    d = pdir(name)
    out = os.path.join(DIST, name)
    os.makedirs(out, exist_ok=True)
    shutil.copy(os.path.join(STATIC, "game.html"), os.path.join(out, "index.html"))
    shutil.copy(os.path.join(STATIC, "game-core.js"), os.path.join(out, "game-core.js"))
    shutil.copy(os.path.join(d, "work.jpg"), os.path.join(out, "work.jpg"))
    shutil.copy(os.path.join(d, "annotations.json"), os.path.join(out, "annotations.json"))
    return out


class H(BaseHTTPRequestHandler):
    server_version = "MazeAnnotator/1"

    def log_message(self, fmt, *a):
        if "/api/" in (a[0] if a else ""):
            super().log_message(fmt, *a)

    # -- helpers
    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ValueError("too large")
        return self.rfile.read(n)

    def jbody(self):
        return json.loads(self.body() or b"{}")

    def guard(self, fn):
        try:
            fn()
        except FileNotFoundError:
            self.send(404, {"error": "not found"})
        except ValueError as e:
            self.send(400, {"error": str(e)})
        except Exception as e:  # keep the dev server alive, tell the browser
            import traceback
            traceback.print_exc()
            self.send(500, {"error": f"{type(e).__name__}: {e}"})

    # -- routes
    def do_GET(self):
        self.guard(self._get)

    def do_POST(self):
        self.guard(self._post)

    def _get(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/api/projects":
            names = sorted(n for n in (os.listdir(PROJECTS) if os.path.isdir(PROJECTS) else []) if NAME_RE.match(n))
            return self.send(200, names)
        m = re.match(r"^/api/project/([^/]+)$", p)
        if m:
            d = pdir(m.group(1))
            proj = read_json(os.path.join(d, "project.json"))
            if proj is None:
                raise FileNotFoundError
            return self.send(200, {"project": proj, "annotations": read_json(os.path.join(d, "annotations.json"))})
        m = re.match(r"^/p/([^/]+)/(scan|work)\.jpg$", p)
        if m:
            with open(os.path.join(pdir(m.group(1)), m.group(2) + ".jpg"), "rb") as f:
                return self.send(200, f.read(), "image/jpeg")
        # static files
        rel = "index.html" if p in ("", "/") else p.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            raise FileNotFoundError
        with open(full, "rb") as f:
            return self.send(200, f.read(), MIME.get(os.path.splitext(full)[1], "application/octet-stream"))

    def _post(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/api/upload":
            name = parse_qs(u.query).get("name", [""])[0]
            if os.path.exists(os.path.join(pdir(name), "project.json")):
                raise ValueError(f"project '{name}' already exists")
            return self.send(200, create_project(name, self.body()))
        m = re.match(r"^/api/project/([^/]+)/(detect|accept|annotations|project|export)$", p)
        if not m:
            raise FileNotFoundError
        name, op = m.groups()
        d = pdir(name)
        if op == "detect":  # preview only, nothing is written
            b = self.jbody()
            im = get_scan(name)
            with LOCK:
                work, scale, c = detect.make_work(im, b.get("crop", {}))
                par = b.get("params", {})
                lines = detect.detect(work, float(par.get("threshold", 0.12)), float(par.get("minlen", 18)),
                                      float(par.get("simplify", 2.0)))
            return self.send(200, {"lines": lines, "scale": scale, "crop": c,
                                   "work_size": [work.shape[1], work.shape[0]]})
        if op == "accept":
            b = self.jbody()
            par = b.get("params", {})
            par = {"threshold": float(par.get("threshold", 0.12)), "minlen": float(par.get("minlen", 18)),
                   "simplify": float(par.get("simplify", 2.0))}
            ann, proj = accept(name, b.get("crop", {}), par)
            return self.send(200, {"annotations": ann, "project": proj})
        if op == "annotations":
            save_annotations(name, self.jbody())
            return self.send(200, {"ok": True})
        if op == "project":
            proj = read_json(os.path.join(d, "project.json"))
            proj.update(self.jbody())
            write_json(os.path.join(d, "project.json"), proj)
            return self.send(200, {"ok": True})
        if op == "export":
            return self.send(200, {"path": os.path.relpath(export(name), ROOT)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--add", help="image file to create a project from")
    ap.add_argument("--name", help="project name for --add")
    a = ap.parse_args()
    os.makedirs(PROJECTS, exist_ok=True)
    if a.add:
        name = a.name or os.path.splitext(os.path.basename(a.add))[0]
        with open(a.add, "rb") as f:
            create_project(re.sub(r"[^A-Za-z0-9_-]", "_", name)[:40], f.read())
        print("created project", name)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    print(f"maze annotator on http://127.0.0.1:{a.port}  (localhost only; use an ssh tunnel)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
