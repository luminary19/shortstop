#!/usr/bin/env python3
"""Stage 3 — YuNet face track -> smoothed 9:16 crop path.

Usage: track.py <media> <out_json> --model <yunet.onnx> [--sample-fps 5]

Algorithm (PLAN §5.4): detect at sample_fps, pick the largest face with
stickiness toward the previous pick, interpolate gaps <= 2 s / hold longer ones,
then smooth the center path with a dead-zone + critically-damped spring so the
crop never jitters. Crop is full-height 9:16, clamped, even-pixel aligned.
"""
import argparse
import json
import math
import sys

import cv2
import numpy as np

GAP_INTERP_MAX_S = 2.0
DEAD_ZONE_FRAC = 0.20      # crop holds while target stays in central 20% of crop
SPRING_OMEGA = 4.0         # rad/s, critically damped
MAX_VEL_PX_S = 250.0       # hard velocity clamp (tested numerically)
FALLBACK_COVERAGE = 0.5
SCORE_THRESHOLD = 0.6
STICKY_RADIUS_FRAC = 0.2   # "near previous pick" radius as fraction of frame width


def even(v):
    return int(v) // 2 * 2


def pick_face(faces, prev_center, frame_w):
    """faces: Nx15 YuNet rows. Largest face, preferring those near the previous pick."""
    cands = []
    for f in faces:
        x, y, w, h = f[0], f[1], f[2], f[3]
        conf = float(f[14])
        cands.append({"cx": x + w / 2, "cy": y + h / 2, "w": w, "h": h, "conf": conf})
    if not cands:
        return None
    if prev_center is not None:
        near = [c for c in cands
                if math.hypot(c["cx"] - prev_center[0], c["cy"] - prev_center[1])
                <= STICKY_RADIUS_FRAC * frame_w]
        if near:
            cands = near
    return max(cands, key=lambda c: c["w"] * c["h"])


def detect(media, model_path, sample_fps):
    cap = cv2.VideoCapture(media)
    if not cap.isOpened():
        raise SystemExit(f"cannot open media: {media}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, round(src_fps / sample_fps))

    det = cv2.FaceDetectorYN.create(model_path, "", (width, height), SCORE_THRESHOLD)
    det.setInputSize((width, height))

    detections = []
    sample_ts = []
    prev_center = None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            t = idx / src_fps
            sample_ts.append(t)
            _, faces = det.detect(frame)
            face = pick_face(faces, prev_center, width) if faces is not None else None
            if face is not None:
                prev_center = (face["cx"], face["cy"])
                detections.append({
                    "t": round(t, 4),
                    "cx": round(float(face["cx"]), 1),
                    "cy": round(float(face["cy"]), 1),
                    "w": round(float(face["w"]), 1),
                    "h": round(float(face["h"]), 1),
                    "conf": round(min(1.0, max(0.0, face["conf"])), 3),
                })
        idx += 1
    cap.release()
    return detections, sample_ts, width, height


def target_centers(detections, sample_ts):
    """Per-sample target center: detected, interpolated (gap <= 2 s), or held."""
    if not detections:
        return None
    det_t = np.array([d["t"] for d in detections])
    det_cx = np.array([d["cx"] for d in detections])
    det_cy = np.array([d["cy"] for d in detections])
    targets = []
    for t in sample_ts:
        i = np.searchsorted(det_t, t)
        exact = i < len(det_t) and abs(det_t[i] - t) < 1e-6
        if exact:
            targets.append((det_cx[i], det_cy[i]))
        elif i == 0:
            targets.append((det_cx[0], det_cy[0]))          # before first: hold first
        elif i >= len(det_t):
            targets.append((det_cx[-1], det_cy[-1]))        # after last: hold last
        else:
            gap = det_t[i] - det_t[i - 1]
            if gap <= GAP_INTERP_MAX_S:
                a = (t - det_t[i - 1]) / gap
                targets.append((det_cx[i - 1] + a * (det_cx[i] - det_cx[i - 1]),
                                det_cy[i - 1] + a * (det_cy[i] - det_cy[i - 1])))
            else:
                targets.append((det_cx[i - 1], det_cy[i - 1]))  # long gap: hold last
    return targets


def smooth_path(targets, sample_ts, width, height, crop_w, crop_h):
    """Dead-zone + critically-damped spring on the crop center. Returns crop_path."""
    dead = DEAD_ZONE_FRAC * crop_w / 2
    x = targets[0][0]
    y = targets[0][1]
    vx = vy = 0.0
    path = []
    for k, t in enumerate(sample_ts):
        if k > 0:
            dt = sample_ts[k] - sample_ts[k - 1]
            tx, ty = targets[k]
            for cur, vel, tgt in (("x", "vx", tx), ("y", "vy", ty)):
                pos = x if cur == "x" else y
                v = vx if cur == "x" else vy
                err = tgt - pos
                if abs(err) <= dead:
                    v = 0.0
                else:
                    goal = tgt - math.copysign(dead, err)  # ease to dead-zone edge
                    acc = SPRING_OMEGA ** 2 * (goal - pos) - 2 * SPRING_OMEGA * v
                    v += acc * dt
                    v = max(-MAX_VEL_PX_S, min(MAX_VEL_PX_S, v))
                    pos += v * dt
                if cur == "x":
                    x, vx = pos, v
                else:
                    y, vy = pos, v
        cx = min(max(x, crop_w / 2), width - crop_w / 2)
        cy = min(max(y, crop_h / 2), height - crop_h / 2)
        path.append({
            "t": round(t, 4),
            "x": even(max(0, min(width - crop_w, cx - crop_w / 2))),
            "y": even(max(0, min(height - crop_h, cy - crop_h / 2))),
        })
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("out_json")
    ap.add_argument("--model", required=True)
    ap.add_argument("--sample-fps", type=float, default=5.0)
    args = ap.parse_args()

    detections, sample_ts, width, height = detect(args.media, args.model, args.sample_fps)
    coverage = len(detections) / len(sample_ts) if sample_ts else 0.0

    crop_h = even(min(height, width * 16 / 9))
    crop_w = even(crop_h * 9 / 16)

    mode = "face" if coverage >= FALLBACK_COVERAGE else "fallback"
    if mode == "face":
        targets = target_centers(detections, sample_ts)
        crop_path = smooth_path(targets, sample_ts, width, height, crop_w, crop_h)
    else:
        # static centered window; render uses the configured fallback (blur-pad)
        crop_path = [{"t": 0.0, "x": even((width - crop_w) / 2), "y": even((height - crop_h) / 2)}]

    out = {
        "mode": mode,
        "sample_fps": args.sample_fps,
        "detections": detections,
        "crop_path": crop_path,
        "crop_w": crop_w,
        "crop_h": crop_h,
        "coverage": round(coverage, 4),
    }
    with open(args.out_json, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(f"track: mode={mode} coverage={coverage:.2f} crop={crop_w}x{crop_h} "
          f"samples={len(sample_ts)} detections={len(detections)}")


if __name__ == "__main__":
    sys.exit(main())
