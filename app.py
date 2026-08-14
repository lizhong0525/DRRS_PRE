"""
Railway Aerial Risk Detection Dashboard
基于无人机航拍的铁路风险识别模型 · 前端展示服务

Flask app providing:
  - Landing page (/)
  - Dashboard (/dashboard)
  - SSE console log stream (/api/console)
  - Simulated drone telemetry (/api/drone)
  - Image list (/api/images)
  - YOLOv11 inference (/api/detect)
  - Static result image (static/results/...)

启动: python app.py
访问: http://127.0.0.1:5000/
"""
from __future__ import annotations

import io
import math
import os
import random
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_from_directory,
    stream_with_context,
)

from ultralytics import YOLO

# -----------------------------------------------------------------------------
# Paths & constants
# -----------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "extracted" / "weights" / "mud_pumping_best.pt"
NORMAL_DIR = BASE_DIR / "images_normal" / "正常图片"
RISK_DIR = BASE_DIR / "images_risk" / "图片"
PROBLEM_DIR = BASE_DIR / "images_problem"
RESULTS_DIR = BASE_DIR / "static" / "results"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

CLASS_LABEL_EN = {
    "mud_pumping": "MUD PUMPING",
}
RISK_LABEL = "MUD PUMPING (HAZARD)"

# Risk-tier classification thresholds (model confidence → UI tier).
# English labels are used everywhere text is rendered ON THE IMAGE (cv2.putText
# uses Hershey fonts that don't support CJK → boxes/missing glyphs on Windows).
# The CSS/HTML chrome still uses Chinese (those are rendered by the browser
# which handles CJK fine).
TIER_THRESHOLDS = [
    (0.70, "HIGH",         "high",         (60,  60, 250)),   # BGR bright red
    (0.40, "SUSPECT",      "suspect",      (60, 140, 245)),   # BGR vivid orange
    (0.10, "UNCONFIRMED",  "unconfirmed",  (60, 215, 245)),   # BGR golden yellow
]
TIER_BY_CONF = {lbl: th for th, lbl, _, _ in TIER_THRESHOLDS}
TIER_BGR     = {lbl: col for _, lbl, _, col in TIER_THRESHOLDS}
TIER_ORDER   = ["high", "suspect", "unconfirmed"]


def _tier_for(conf: float):
    """Return (tier_label_for_image, tier_en) for a given confidence score."""
    for th, lbl, en, _ in TIER_THRESHOLDS:
        if conf >= th:
            return lbl, en
    return None, None


def _top_tier(detections):
    """Return the highest tier present in this detection list."""
    for en in TIER_ORDER:
        if any(d["tier"] == en for d in detections):
            return next(d for d in detections if d["tier"] == en)
    return None


def _tally_by_tier(detections):
    """{tier_en: count} for the given detections."""
    out = {"high": 0, "suspect": 0, "unconfirmed": 0}
    for d in detections:
        out[d["tier"]] = out.get(d["tier"], 0) + 1
    return out

# -----------------------------------------------------------------------------
# YOLO model (loaded once)
# -----------------------------------------------------------------------------
print(f"[boot] loading YOLO model: {MODEL_PATH}")
_yolo = YOLO(str(MODEL_PATH))
_yolo_lock = threading.Lock()
print(f"[boot] model classes: {_yolo.names}")

# -----------------------------------------------------------------------------
# App
# -----------------------------------------------------------------------------
app = Flask(__name__, static_folder="static", template_folder="templates")


# -----------------------------------------------------------------------------
# Simulated console log (in-memory ring buffer + event for SSE)
# -----------------------------------------------------------------------------
class ConsoleHub:
    """Tiny pub-sub for log lines. Lines also stored in a ring buffer."""

    def __init__(self, maxlen: int = 500) -> None:
        self._buffer: deque[str] = deque(maxlen=maxlen)
        self._event = threading.Event()
        self._lock = threading.Lock()

    def push(self, line: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        msg = f"[{ts}] {line}"
        with self._lock:
            self._buffer.append(msg)
            self._event.set()
        print(msg, flush=True)

    def snapshot(self) -> list[str]:
        with self._lock:
            return list(self._buffer)

    def wait_for_new(self, last_seen_index: int) -> list[str]:
        """Wait briefly for new lines; return up-to-date snapshot slice."""
        self._event.wait(timeout=2.0)
        self._event.clear()
        snap = self.snapshot()
        return snap[last_seen_index:]

    def seed_initial(self) -> None:
        self.push("system: 风险识别服务端已启动")
        self.push("system: 模型加载完成 (YOLOv11-seg · mud_pumping)")
        self.push("link:   无人机遥测通道已建立")
        self.push("link:   检测队列通道已就绪")


console = ConsoleHub()
console.seed_initial()


# -----------------------------------------------------------------------------
# Simulated drone telemetry — the drone patrols a closed-loop railway corridor
# -----------------------------------------------------------------------------
# A representative railway corridor: mostly long straight tangent segments with
# two rounded turn-arounds at each end. Spans roughly 0.012° of lat/lon,
# which at lat ≈31° is about 1.3 km total track length.
_RAIL_PATH_RAW = [
    # west tangent (going east)
    (31.2240, 121.4675),
    (31.2242, 121.4690),
    (31.2245, 121.4708),
    (31.2249, 121.4726),
    (31.2254, 121.4742),
    (31.2260, 121.4756),
    (31.2268, 121.4768),
    # east turn-around
    (31.2278, 121.4776),
    (31.2289, 121.4780),
    (31.2300, 121.4778),
    (31.2310, 121.4772),
    (31.2317, 121.4762),
    # east tangent (going west)
    (31.2321, 121.4750),
    (31.2323, 121.4734),
    (31.2324, 121.4718),
    (31.2324, 121.4702),
    (31.2322, 121.4688),
    (31.2319, 121.4676),
    # west turn-around
    (31.2315, 121.4668),
    (31.2306, 121.4664),
    (31.2295, 121.4664),
    (31.2284, 121.4668),
    (31.2275, 121.4675),
    (31.2267, 121.4678),
    # back to start
    (31.2258, 121.4678),
]
_RAIL_PATH = list(_RAIL_PATH_RAW)  # will be augmented with smooth samples below

# Augment the raw path with extra Catmull-Rom samples so the curve reads smooth
# even between the user-defined waypoints.
def _cr(p0, p1, p2, p3, t):
    t2 = t * t
    t3 = t2 * t
    return (
        0.5 * ((2*p1[0]) + (-p0[0]+p2[0]) * t +
               (2*p0[0]-5*p1[0]+4*p2[0]-p3[0]) * t2 +
               (-p0[0]+3*p1[0]-3*p2[0]+p3[0]) * t3),
        0.5 * ((2*p1[1]) + (-p0[1]+p2[1]) * t +
               (2*p0[1]-5*p1[1]+4*p2[1]-p3[1]) * t2 +
               (-p0[1]+3*p1[1]-3*p2[1]+p3[1]) * t3),
    )


def _smooth_path(raw, samples_per_seg=12):
    """Resample a closed polyline with a centripetal Catmull-Rom spline."""
    n = len(raw)
    out = []
    for i in range(n):
        p0 = raw[(i - 1) % n]
        p1 = raw[i]
        p2 = raw[(i + 1) % n]
        p3 = raw[(i + 2) % n]
        if i == n - 1:
            # don't duplicate the closing vertex
            samples = 1
        else:
            samples = samples_per_seg
        for k in range(samples):
            t = k / samples_per_seg
            out.append(_cr(p0, p1, p2, p3, t))
    return out


_RAIL_PATH = _smooth_path(_RAIL_PATH_RAW, samples_per_seg=14)
PATH_LEN_M = None  # computed on first step


def _path_length_m():
    """Approximate total path length in meters (for speed→progress conversion)."""
    if PATH_LEN_M is not None:
        return PATH_LEN_M
    n = len(_RAIL_PATH)
    total = 0.0
    for i in range(n):
        a = _RAIL_PATH[i]
        b = _RAIL_PATH[(i + 1) % n]
        dlat = (b[0] - a[0]) * 111_320.0
        dlon = (b[1] - a[1]) * 111_320.0 * math.cos(math.radians(a[0]))
        total += math.hypot(dlat, dlon)
    globals()['PATH_LEN_M'] = total
    return total


def _interp_at(progress: float):
    """Sample position and tangent heading at `progress` ∈ [0,1) along the loop.

    progress=0 → start of path. Loops automatically.
    Returns (lat, lon, heading_deg).
    """
    n = len(_RAIL_PATH)
    seg = progress * n
    i = int(seg) % n
    frac = seg - math.floor(seg)
    p1 = _RAIL_PATH[i]
    p2 = _RAIL_PATH[(i + 1) % n]
    lat = p1[0] * (1 - frac) + p2[0] * frac
    lon = p1[1] * (1 - frac) + p2[1] * frac
    # tangent heading — degrees CW from north
    dlat = (p2[0] - p1[0]) * 111_320.0
    dlon = (p2[1] - p1[1]) * 111_320.0 * math.cos(math.radians(p1[0]))
    heading = (math.degrees(math.atan2(dlon, dlat)) + 360.0) % 360.0
    return lat, lon, heading


class DroneSim:
    """A drone that patrols the closed-loop railway corridor."""

    LOOP_SECONDS = 96.0          # how long one full lap takes (with nominal speed)
    NOMINAL_SPEED = 8.5          # m/s

    def __init__(self) -> None:
        self._t0 = time.time()
        self._progress = 0.0      # [0,1) along the path
        self.battery = 87.5
        self.gps_fix = "3D"
        self.signal = "强"
        self.mode = "AUTO_PATROL"
        # initialize position immediately so the canvas has a starting frame
        lat, lon, h = _interp_at(0.0)
        self.lat, self.lon, self.heading = lat, lon, h
        self.alt = 80.0
        self.speed = self.NOMINAL_SPEED

    def step(self) -> dict:
        t = time.time() - self._t0

        # advance along the path: progress = speed × Δt / total_length, scaled
        # so one full loop matches LOOP_SECONDS at NOMINAL_SPEED.
        length_m = _path_length_m()
        if length_m > 0:
            self._progress += (self.NOMINAL_SPEED * 0.5) / (length_m)  # tick at 0.5s
            self._progress = self._progress % 1.0

        lat, lon, heading = _interp_at(self._progress)
        # tiny cross-track jitter so the trail has visual texture
        jitter_n = math.sin(t * 0.6) * 1.2       # across-track offset (m)
        jitter_e = math.cos(t * 0.4) * 0.8
        dlat_j = jitter_n / 111_320.0
        dlon_j = jitter_e / (111_320.0 * math.cos(math.radians(lat)))
        self.lat = lat + dlat_j
        self.lon = lon + dlon_j
        # heading slowly drifts with the curvature of the track at this point
        self.heading = heading

        # smooth speed / altitude envelope — sinusoidal, NO random walk
        self.speed   = self.NOMINAL_SPEED + math.sin(t * 0.17) * 1.4   # 7.1 .. 9.9 m/s
        self.alt     = 78.0 + math.sin(t * 0.21) * 2.5                  # 75.5 .. 80.5 m
        self.battery = max(0, 92.0 - (t % 7200) / 7200 * 80)             # 12..92 % over 2 h

        # randomly change signal/battery decimals etc.
        return {
            "lat": self.lat,
            "lon": self.lon,
            "alt": round(self.alt, 2),
            "heading": round(self.heading, 1),
            "speed": round(self.speed, 2),
            "battery": round(self.battery, 2),
            "gps_fix": self.gps_fix,
            "signal": self.signal,
            "mode": self.mode,
            "ts": int(time.time() * 1000),
        }


drone = DroneSim()


# -----------------------------------------------------------------------------
# Detection log
# -----------------------------------------------------------------------------
DETECTION_HISTORY: deque[dict] = deque(maxlen=80)
DETECTION_LOCK = threading.Lock()
SESSION_STATS = {
    "total_detections": 0,
    "risk_detections": 0,
    "normal_detections": 0,
    "tier_count": {"high": 0, "suspect": 0, "unconfirmed": 0},
    "avg_inference_ms": 0.0,
    "by_class": {},
    "started_at": datetime.now().isoformat(timespec="seconds"),
}


def _classify_image_kind(rel_path: str) -> str:
    if rel_path.startswith("normal/"):
        return "normal"
    if rel_path.startswith("risk/"):
        return "risk"
    return "unknown"


# curated patrol sequence. 27 entries total after user edits:
#  •  #1-4     4 original photos from 正常图片.zip
#  •  #5-16    round-1 augments (4 transforms × 4 seeds, minus seeds 4-A & 4-C which were
#              the historically false-positive candidates — dropped per user)
#  •  #17-19   round-1 seed-4 surviving augments (B and D) and first round-2 seed-1 augment (E)
#  •  #20      ea15b2d8 risk image (moved here from old #29)
#  •  #21-26   remaining round-2 augments
#  •  #27      6e9caf29... round-2 seed-1-F (the clean aug that landed here after swap)
# Detection: only slot #20 is detected-risk (mud_pumping); everything else tests clean.
RISK_INDEX = 20
DEMO_PATROL = [
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "105f226305d15e6259e6fdbffb75ac96.jpg"},  #  1
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "1b71b5635071614709c0ea014e62d8b3.jpg"},  #  2
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "6a10208fc265d10727b7bd8640df0bd1.jpg"},  #  3
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "8f01f5cc58e5f965dcdec32254f9ab98.jpg"},  #  4
    # round-1 seed 1
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "8b575767daaca1d2496e358a.jpg"},          #  5  seed1 A
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "25aa35c050ea63274a27aa78.jpg"},          #  6  seed1 B
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "59885548e8f9108a2346de22.jpg"},          #  7  seed1 C
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "8d36ac0928986ef97776c553.jpg"},          #  8  seed1 D
    # round-1 seed 2
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "fbd3a49a993c17c791611b32.jpg"},          #  9  seed2 A
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "a37ac83434113b691ab4effb.jpg"},          # 10  seed2 B
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "fafbfc31fa3551d1e560dd2d.jpg"},          # 11  seed2 C
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "f0b7ff4279f9cc69b99154ab.jpg"},          # 12  seed2 D
    # round-1 seed 3
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "31ad45c13a640d80b24e392d.jpg"},          # 13  seed3 A
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "8588d9a20461a6d37aa0808d.jpg"},          # 14  seed3 B
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "f3f2166b3e4fe5dcd2ed668f.jpg"},          # 15  seed3 C
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "f066dbab539da205faf2bee6.jpg"},          # 16  seed3 D
    # round-1 seed 4 (only B and D survive — A and C were the false-positive candidates)
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "63a9cd17b74f0b4cbcdf111c.jpg"},          # 17  seed4 B
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "18a895b40f31e20ca71b7d33.jpg"},          # 18  seed4 D
    # round-2 seed 1 first slot
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "a7d5247a9ef6c73bba6194fe.jpg"},          # 19  seed1 E
    # risk slot — moved here from old #29 per user swap
    {"kind": "risk",   "dir": RISK_DIR,    "name": "ea15b2d8086cfbb978d95d92cf1d886d.jpg"},  # 20  legacy ea15b2d8
    # remaining round-2 seed 1
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "a8d15d92ec31cceed7fe70da.jpg"},          # 21  seed1 G
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "214165502ad91bb32dd2957e.jpg"},          # 22  seed1 H
    # round-2 seed 2
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "bbe93f00a53321dadfe6fa22.jpg"},          # 23  seed2 E
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "d87f40be8f0273ec36f73e96.jpg"},          # 24  seed2 F
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "eb86fed4fc8d767be3c3b421.jpg"},          # 25  seed2 G
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "505aea8fec691cbe64f8eea4.jpg"},          # 26  seed2 H
    # round-2 seed 1 swap target (moved here from old #20)
    {"kind": "normal", "dir": NORMAL_DIR,  "name": "6e9caf29d4f28b9b7a47d2af.jpg"},          # 27  seed1 F
]


def _list_images() -> list[dict]:
    """Curated patrol sequence. Each slot is rendered identically until inference
    proves the image carries risk; only then does the UI mark it red.

    `known_risk` is server-side metadata so the front-end can distinguish
    'discovery' (just-detected mud_pumping) from pre-existing annotation.
    """
    out: list[dict] = []
    for i, slot in enumerate(DEMO_PATROL, start=1):
        name = slot["name"]
        path = slot["dir"] / name
        is_risk = slot["kind"] == "risk"
        out.append(
            {
                "id": f"{slot['kind']}/{name}",
                "name": name,
                "index": i,
                "position": i,
                "kind": slot["kind"],
                "known_risk": is_risk,
                "path": str(path),
            }
        )
    return out


def _classify_image_kind(rel_path: str) -> str:
    if rel_path.startswith("normal/"):
        return "normal"
    if rel_path.startswith("risk/"):
        return "risk"
    return "unknown"


# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------
@app.route("/")
def landing():
    return render_template("landing.html")


@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/images")
def api_images():
    return jsonify({"images": _list_images()})


@app.route("/api/drone")
def api_drone():
    return jsonify(drone.step())


@app.route("/api/path")
def api_path():
    """Static smoothed railway corridor for the canvas decoration."""
    return jsonify({
        "points": [{"lat": p[0], "lon": p[1]} for p in _RAIL_PATH],
        "loop_seconds": DroneSim.LOOP_SECONDS,
        "length_m": round(_path_length_m()),
    })


@app.route("/api/stats")
def api_stats():
    with DETECTION_LOCK:
        return jsonify(
            {
                "stats": SESSION_STATS,
                "history": list(DETECTION_HISTORY)[-12:],
            }
        )


@app.route("/static/results/<path:fname>")
def serve_result(fname: str):
    # prevent path traversal
    safe = (RESULTS_DIR / fname).resolve()
    if not str(safe).startswith(str(RESULTS_DIR.resolve())) or not safe.is_file():
        abort(404)
    return send_from_directory(RESULTS_DIR, fname)


@app.route("/api/detect", methods=["POST"])
def api_detect():
    payload = request.get_json(force=True, silent=True) or {}
    img_id = payload.get("id", "")
    if not img_id:
        return jsonify({"ok": False, "error": "missing image id"}), 400

    # resolve file
    candidates = []
    kind_guess = ""
    if "/" in img_id:
        kind_guess, name = img_id.split("/", 1)
        if kind_guess == "normal":
            candidates.append(NORMAL_DIR / name)
        elif kind_guess == "risk":
            # risk slots may live in images_risk/图片/ or images_problem/
            candidates.append(RISK_DIR / name)
            candidates.append(PROBLEM_DIR / name)

    matched = next((p for p in candidates if p.exists()), None)
    if matched is None:
        return jsonify({"ok": False, "error": f"image not found: {img_id}"}), 404

    console.push(f"detect: 收到请求  {img_id}")

    # run inference (thread-safe so concurrent requests don't blow GPU memory).
    # Threshold is intentionally set LOW (0.10) so the multi-tier classifier
    # has both conf high and conf medium candidates to color differently.
    MIN_CONF = 0.10
    t0 = time.time()
    with _yolo_lock:
        results = _yolo.predict(
            source=str(matched),
            imgsz=640,
            conf=MIN_CONF,
            save=False,
            verbose=False,
        )
    dt_ms = (time.time() - t0) * 1000.0

    res = results[0]
    boxes = res.boxes
    n_det = len(boxes)
    detections = []
    for i in range(n_det):
        cls_id = int(boxes.cls[i].item())
        conf = float(boxes.conf[i].item())
        xyxy = boxes.xyxy[i].tolist()
        cls_name = _yolo.names.get(cls_id, str(cls_id))
        cn = CLASS_LABEL_EN.get(cls_name, cls_name)
        tier_cn, tier_en = _tier_for(conf)
        detections.append(
            {
                "i": i,
                "class_id": cls_id,
                "class": cls_name,
                "class_cn": cn,
                "conf": round(conf, 4),
                "xyxy": [round(v, 1) for v in xyxy],
                "tier": tier_en,
                "tier_cn": tier_cn,
                "tier_color_bgr": list(TIER_BGR[tier_cn]),
            }
        )

    # collect mask polygon outlines (one polygon per detection, in pixel space)
    polygons = []
    has_masks = (
        hasattr(res, "masks")
        and res.masks is not None
        and getattr(res.masks, "xy", None) is not None
    )
    if has_masks and n_det > 0:
        for i in range(n_det):
            try:
                polygons.append(res.masks.xy[i])   # ndarray (N, 2) px
            except Exception:
                polygons.append(None)
    else:
        polygons = [None] * n_det

    # ---- custom rendering: tier-colored boxes + masks + labels ----
    img_bgr = cv2.imread(str(matched))
    if img_bgr is None:
        return jsonify({"ok": False, "error": "image could not be read"}), 500
    H, W = img_bgr.shape[:2]

    font = cv2.FONT_HERSHEY_SIMPLEX
    warn_font = cv2.FONT_HERSHEY_DUPLEX
    for det in detections:
        color = tuple(det["tier_color_bgr"])
        x1, y1, x2, y2 = [int(round(v)) for v in det["xyxy"]]
        x1 = max(0, x1); y1 = max(0, y1)
        x2 = min(W - 1, x2); y2 = min(H - 1, y2)
        box_w, box_h = x2 - x1, y2 - y1

        tier = det["tier"]
        tier_cn = det["tier_cn"]

        # ---- mask overlay: makes the highlighted "area on the image" stand out ----
        poly = polygons[det["i"]] if det["i"] < len(polygons) else None
        if poly is not None and poly.size >= 6 and tier in ("high", "suspect"):
            pts = np.array(poly, dtype=np.int32).reshape(-1, 1, 2)
            overlay = img_bgr.copy()
            # 高危: 0.55 alpha fill — heavy highlight; 疑似: 0.30
            alpha = 0.55 if tier == "high" else 0.30
            cv2.fillPoly(overlay, [pts], color)
            cv2.addWeighted(overlay, alpha, img_bgr, 1 - alpha, 0, img_bgr)
            cv2.polylines(img_bgr, [pts], True, color, 2, lineType=cv2.LINE_AA)

        # ---- outer "halo" rings (concentric glow rings around box) ----
        # Skip halo for 待确认 since it's just a hint
        if tier in ("high", "suspect"):
            # outer faintest halo
            for pad_px, alpha in [(20, 0.10), (12, 0.18)]:
                halo = img_bgr.copy()
                cv2.rectangle(halo, (x1 - pad_px, y1 - pad_px), (x2 + pad_px, y2 + pad_px), color, 4, lineType=cv2.LINE_AA)
                cv2.addWeighted(halo, alpha, img_bgr, 1 - alpha, 0, img_bgr)

        # ---- main box border (very thick for high) ----
        thickness = 6 if tier == "high" else 4 if tier == "suspect" else 2
        cv2.rectangle(img_bgr, (x1, y1), (x2, y2), color, thickness, lineType=cv2.LINE_AA)

        # ---- inner ⚠ glyph (drawn in the top-left corner of the box) ----
        # only for high + suspect tiers, big warning glyph
        if tier in ("high", "suspect"):
            glyph_box = 56 if tier == "high" else 44
            gx1, gy1 = x1, y1
            gx2, gy2 = min(x1 + glyph_box, W - 1), min(y1 + glyph_box, H - 1)
            # filled warning background
            cv2.rectangle(img_bgr, (gx1, gy1), (gx2, gy2), color, -1, lineType=cv2.LINE_AA)
            # white ⚠ triangle + exclamation — Helvetica style works better than DejaVu
            tri_pts = np.array(
                [
                    [int((gx1 + gx2) / 2), gy1 + 8],
                    [gx1 + 8, gy2 - 12],
                    [gx2 - 8, gy2 - 12],
                ],
                dtype=np.int32,
            )
            cv2.fillPoly(img_bgr, [tri_pts], (255, 255, 255), lineType=cv2.LINE_AA)
            # exclamation: small white dot at the bottom of the triangle
            dot_cx = (gx1 + gx2) // 2
            cv2.circle(img_bgr, (dot_cx, gy2 - 16), 3, (255, 255, 255), -1, lineType=cv2.LINE_AA)
            # tall white bar inside the triangle (vertical line)
            cv2.rectangle(
                img_bgr,
                (dot_cx - 2, gy1 + 12),
                (dot_cx + 2, gy2 - 18),
                (255, 255, 255),
                -1,
                lineType=cv2.LINE_AA,
            )

        # ---- label: white-on-tier banner above (or below) the box ----
        text = f"{det['class_cn']} {det['conf']:.2f}  {tier_cn}"
        font_scale = 0.9 if tier == "high" else 0.75 if tier == "suspect" else 0.7
        thickness_t = 2
        (tw, th), baseline = cv2.getTextSize(text, font, font_scale, thickness_t)
        ly_top    = y1 - th - baseline - 10
        ly_bottom = y1
        if ly_top < 4:
            ly_top    = y2 + 6
            ly_bottom = y2 + th + baseline + 14
        cv2.rectangle(
            img_bgr,
            (x1, ly_top),
            (x1 + tw + 16, ly_bottom),
            color, -1, lineType=cv2.LINE_AA,
        )
        cv2.putText(
            img_bgr, text,
            (x1 + 8, ly_bottom - baseline - 5),
            font, font_scale, (255, 255, 255), thickness_t, cv2.LINE_AA,
        )

    out_name = f"{uuid.uuid4().hex[:12]}_{matched.stem}.jpg"
    out_path = RESULTS_DIR / out_name
    cv2.imwrite(str(out_path), img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])

    # session stats / history
    kind = kind_guess or "unknown"
    is_risk = n_det > 0
    with DETECTION_LOCK:
        SESSION_STATS["total_detections"] += 1
        if is_risk:
            SESSION_STATS["risk_detections"] += 1
        else:
            SESSION_STATS["normal_detections"] += 1
        prev_n = SESSION_STATS["total_detections"] - 1
        SESSION_STATS["avg_inference_ms"] = round(
            (SESSION_STATS["avg_inference_ms"] * prev_n + dt_ms)
            / SESSION_STATS["total_detections"],
            2,
        )
        for d in detections:
            c = d["class"]
            SESSION_STATS["by_class"][c] = SESSION_STATS["by_class"].get(c, 0) + 1
            SESSION_STATS["tier_count"][d["tier"]] = SESSION_STATS["tier_count"].get(d["tier"], 0) + 1
        DETECTION_HISTORY.append(
            {
                "id": img_id,
                "kind": kind,
                "n": n_det,
                "tier_counts": _tally_by_tier(detections),
                "tier_top": _top_tier(detections)["tier"] if detections else None,
                "confs": [d["conf"] for d in detections],
                "ms": round(dt_ms, 1),
                "ts": datetime.now().strftime("%H:%M:%S"),
            }
        )

    # overall risk level = highest tier present (or "NORMAL" if nothing)
    top = _top_tier(detections)
    risk_level = top["tier_cn"] if top else "NORMAL"
    tier_counts = _tally_by_tier(detections)

    console.push(
        f"detect: 完成 {img_id}  推理 {dt_ms:.0f} ms  检测 {n_det} 个目标  风险等级: {risk_level}"
    )
    if n_det > 0:
        for d in detections:
            console.push(
                f"  ↳ [{d['tier_cn']}] {d['class_cn']}  conf={d['conf']:.2f}  box={d['xyxy']}"
            )

    return jsonify(
        {
            "ok": True,
            "id": img_id,
            "name": matched.name,
            "kind": kind,
            "n": n_det,
            "risk_level": risk_level,
            "tier_counts": tier_counts,
            "tiers": TIER_BY_CONF,           # conf threshold per tier (UI can read)
            "tier_colors": {                 # RGB hex for front-end swatches
                "high":         "#ff3c3c",
                "suspect":      "#ff9235",
                "unconfirmed":  "#f6c634",
            },
            "inference_ms": round(dt_ms, 1),
            "detections": detections,
            "annotated_url": f"/static/results/{out_name}",
            "orig_url": f"/static/original/{matched.name}",
        }
    )


# also expose originals through static
ORIG_DIR = BASE_DIR / "static" / "original"
ORIG_DIR.mkdir(parents=True, exist_ok=True)


@app.route("/static/original/<path:fname>")
def serve_original(fname: str):
    cand = NORMAL_DIR / fname
    if cand.exists():
        return send_from_directory(str(NORMAL_DIR), fname)
    cand = RISK_DIR / fname
    if cand.exists():
        return send_from_directory(str(RISK_DIR), fname)
    abort(404)


# -----------------------------------------------------------------------------
# SSE: console stream
# -----------------------------------------------------------------------------
@app.route("/api/console")
def api_console():
    def gen():
        last_index = 0
        # initial snapshot
        snap = console.snapshot()
        for line in snap:
            yield f"data: {line}\n\n"
        last_index = len(snap)
        # small heartbeat every ~1s when idle
        while True:
            new_lines = console.wait_for_new(last_index)
            if new_lines:
                for line in new_lines:
                    yield f"data: {line}\n\n"
                last_index += len(new_lines)
            else:
                yield ": keep-alive\n\n"

    return Response(
        stream_with_context(gen()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# background heartbeat for the console so SSE clients always see motion
def _heartbeat() -> None:
    seq = 0
    while True:
        time.sleep(3.0)
        seq += 1
        drone_state = drone.step()
        if seq % 4 == 0:
            console.push(
                f"drone:  ({drone_state['lat']:.5f},{drone_state['lon']:.5f}) "
                f"alt={drone_state['alt']:.1f}m "
                f"hdg={drone_state['heading']:.0f}° "
                f"spd={drone_state['speed']:.1f}m/s "
                f"bat={drone_state['battery']:.1f}%"
            )


threading.Thread(target=_heartbeat, daemon=True).start()


# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    # Friendly host/port so the user can just click a link from the landing page
    port = int(os.environ.get("PORT", "5000"))
    print(f"[boot] listening on http://127.0.0.1:{port}/")
    # use_reloader=False so YOLO is loaded only once
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False, threaded=True)
