# DRRS_PRE — 铁路巡检风险识别控制台

A real-time detection dashboard for **railway aerial risk identification** based
on a YOLOv11n-segmentation model. A simulated drone patrols a closed-loop
railway corridor, capturing each patrol image and running it through
`mud_pumping` detection. Detected regions are highlighted on the image with
bounding boxes, segmentation masks, alarm glyphs, and tier-colored UI tags.

## Features

- **Landing page** (`/`) → click-through to the dashboard.
- **Live dashboard** (`/dashboard`) split into 4 panels:
  - Top-left: drone telemetry (lat/lon/alt/heading/speed/battery) drawn over a
    smoothed closed-loop railway corridor (Catmull-Rom interpolated, ~3.4 km).
  - Top-right: KPIs + last-detection summary + class breakdown + history.
  - Bottom-left: SSE real-time console log.
  - Bottom-right: image-detection panel with patrol sequence and per-image
    annotated results, expandable preview.
- **Auto-patrol (发现式)** walks the 27-slot sequence and lights up the
  detected-risk slot in a vivid red color block with a flashing banner alarm.
- **Tier classification** of detections (high ≥0.70 / suspect ≥0.40 /
  unconfirmed ≥0.10) with vivid per-tier colors and concentric glow rings on
  the highlighted area.
- **Result caching**: revisiting a previously-detected image replays its
  annotation without re-running inference.
- Server-side `state.results` cache: rendered images persist on the
  filesystem so a hard reload still shows them.

## Layout

```
.
├── app.py                 # Flask backend + YOLO inference + SSE
├── extracted/
│   ├── data.yaml          # YOLO class definitions (mud_pumping)
│   └── weights/           # NOT in repo — obtain from the model package
├── images_normal/正常图片/        # NOT in repo — user-provided photos
├── images_risk/图片/             # NOT in repo — legacy risk image
├── images_problem/               # NOT in repo — new problem photo
├── shots/                # debug screenshots (not in repo)
├── static/
│   ├── css/style.css     # all styling (color blocks, badges, alarm animation)
│   ├── js/dashboard.js   # SSE, drone canvas, patrol UI
│   └── results/          # annotated image cache (runtime, not in repo)
└── templates/
    ├── landing.html      # entry page
    └── dashboard.html    # main dashboard
```

## Requirements

- Python 3.10+ with `flask`, `ultralytics`, `opencv-python`, `numpy`,
  `pillow`.
- A CUDA-capable GPU is **optional** — the code falls back to CPU. CPU
  inference runs at ~50–100 ms per 640×640 image after warm-up.

## Setup

1. Clone this repository.
2. Extract the model package into `./extracted/`:

   ```bash
   # contents: extracted/weights/mud_pumping_best.pt  (and supporting files)
   # these come from the model's release package, ~6 MB total
   ```

3. Provide demo images:

   - `images_normal/正常图片/` — at least a handful of clean railway aerial
     photos used as the patrol sequence.
   - `images_problem/` — the problem photo to surface during the patrol
     (the demo's `DEMO_PATROL` references a single entry `09adb628…jpg`).

   The dictionary in `app.py: DEMO_PATROL` lists the exact filenames used at
   runtime; editing it lets you adapt to your own folder layout.

4. Install dependencies:

   ```bash
   pip install flask ultralytics opencv-python numpy pillow
   ```

5. Run:

   ```bash
   python app.py
   # → http://127.0.0.1:5000/
   ```

## Patrol sequence (default)

Slots 1–4 are real photos from your source folder; slots 5–26 are
PIL-generated augmentations (deterministic by name hash); **slot 20 holds
the risk image** that triggers the colour-block alarm. The exact list is
maintained in `DEMO_PATROL` near the top of `app.py`.

## API surface

| Endpoint       | Method | Purpose                                         |
| -------------- | ------ | ----------------------------------------------- |
| `/`            | GET    | Landing page                                    |
| `/dashboard`   | GET    | Main dashboard                                   |
| `/api/images`  | GET    | Patrol sequence (with per-image metadata)       |
| `/api/detect`  | POST   | Run inference on `{id: "<kind>/<filename>"}`    |
| `/api/drone`    | GET    | Drone telemetry (simulated patrol)              |
| `/api/path`     | GET    | Static Catmull-Rom railway corridor             |
| `/api/stats`    | GET    | Session stats + recent detection history         |
| `/api/console`  | GET    | Server-SSE event stream of console log lines    |

## Detection tiers

| Tier       | Threshold      | Color  |
| ---------- | -------------- | ------ |
| 高危       | conf ≥ 0.70    | red    |
| 疑似       | 0.40 ≤ c < 0.70 | orange |
| 待确认     | 0.10 ≤ c < 0.40 | yellow |

Tier thresholds are defined in `app.py` and can be tweaked. The display
font scales and the box thickness also scale with the tier.

## Notes / caveats

- `state.results` only lives in the browser session — reload the page and
  detection results will be lost on the client, but the annotated images
  on disk still exist under `static/results/`.
- The drone is **simulated**, not real telemetry — its position follows a
  fixed corridor, with smooth sinusoidal speed / altitude envelopes and
  cross-track jitter for visual texture.
- The default corpus is curated, not exhaustive. Re-train or re-supply
  your own images to use this in production.
