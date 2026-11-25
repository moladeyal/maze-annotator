"""Very simple line detection for pencil-on-paper maze scans.

pipeline: crop -> (downscale) -> grey -> divide by local paper brightness ->
threshold -> remove specks -> skeleton -> polylines -> drop short stubs -> simplify

No semantics: everything dark and line-like becomes a polyline. The editor is
where a human decides what actually is a wall.
"""
import cv2
import numpy as np
from skimage.morphology import skeletonize
from skan import Skeleton, summarize

MAXSIDE = 1800  # working images are scaled down to at most this many px


def load_scan(path):
    """cv2 applies the EXIF orientation, so phone photos come out upright."""
    im = cv2.imread(path, cv2.IMREAD_COLOR)
    if im is None:
        raise ValueError("cannot read image")
    return im


def clamp_crop(im, crop):
    H, W = im.shape[:2]
    x = int(round(crop.get("x", 0)))
    y = int(round(crop.get("y", 0)))
    x = max(0, min(x, W - 8))
    y = max(0, min(y, H - 8))
    w = int(round(crop.get("w", W)))
    h = int(round(crop.get("h", H)))
    w = max(8, min(w, W - x))
    h = max(8, min(h, H - y))
    return {"x": x, "y": y, "w": w, "h": h}


def make_work(im, crop):
    """-> (work_image, scale, clamped_crop). scale maps scan px -> work px."""
    c = clamp_crop(im, crop)
    part = im[c["y"]:c["y"] + c["h"], c["x"]:c["x"] + c["w"]]
    s = min(1.0, MAXSIDE / max(c["w"], c["h"]))
    if s < 1.0:
        part = cv2.resize(part, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return part, s, c


def _line_mask(work, threshold):
    g = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY).astype(np.float32)
    k = max(3, int(round(max(g.shape) / 115)) | 1)  # ~15px at 1700px
    paper = cv2.GaussianBlur(cv2.dilate(g, np.ones((k, k), np.uint8)), (0, 0), k * 1.6)
    dark = 1.0 - g / np.maximum(paper, 1.0)  # 0 on paper, >0 on pencil
    m = (dark > threshold).astype(np.uint8)
    return cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))


def _length(pts):
    d = np.diff(pts.astype(np.float64), axis=0)
    return float(np.sqrt((d ** 2).sum(axis=1)).sum())


def detect(work, threshold=0.12, minlen=18, simplify=2.0):
    """-> list of polylines [[x,y],...] in work-image pixels."""
    m = _line_mask(work, threshold)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n > 1:
        tiny = np.flatnonzero(st[1:, cv2.CC_STAT_AREA] < max(20, minlen * 2)) + 1
        m[np.isin(lab, tiny)] = 0
    sk = skeletonize(m > 0)
    if sk.sum() < 2:
        return []
    S = Skeleton(sk.astype(np.uint8), keep_images=False)
    df = summarize(S, separator="_")
    out = []
    for i in range(S.n_paths):
        pts = S.path_coordinates(i)[:, ::-1]  # (x, y)
        if len(pts) < 2:
            continue
        branch_type = int(df.loc[i, "branch_type"])
        # 0 = isolated piece, 1 = stub hanging off a junction: both drop if short
        if branch_type in (0, 1) and _length(pts) < minlen:
            continue
        ap = cv2.approxPolyDP(pts.astype(np.float32).reshape(-1, 1, 2), float(simplify), False)
        ap = ap.reshape(-1, 2)
        if len(ap) >= 2:
            out.append([[round(float(x), 1), round(float(y), 1)] for x, y in ap])
    return out


def hide_marks(im, rect, threshold=0.035, pad=5):
    """Paint over pencil marks inside rect=[x0,y0,x1,y1] by inpainting from the surrounding paper.
    Used for the exported game only (the saved work.jpg and the scan are never altered)."""
    H, W = im.shape[:2]
    x0, y0, x1, y1 = [int(v) for v in rect]
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    m = _line_mask(im, threshold)
    mask = np.zeros((H, W), np.uint8)
    mask[y0:y1, x0:x1] = m[y0:y1, x0:x1] * 255
    mask = cv2.dilate(mask, np.ones((pad * 2 + 1, pad * 2 + 1), np.uint8))
    mask[:y0, :] = 0; mask[y1:, :] = 0; mask[:, :x0] = 0; mask[:, x1:] = 0
    return cv2.inpaint(im, mask, 5, cv2.INPAINT_TELEA)
