#!/usr/bin/env bash
# Downloads MediaPipe Tasks Vision runtime (WASM+loader) and the face models
# into vendored, gitignored paths so Akbal Vision runs with NO CDN and works
# offline afterwards. Pinned versions for reproducibility.
set -euo pipefail
cd "$(dirname "$0")"
MP_VER="0.10.18"
mkdir -p vendor/mediapipe models

echo "[akbal-vision] MediaPipe tasks-vision ${MP_VER}…"
curl -fsSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs" \
  -o vendor/mediapipe/vision_bundle.mjs
for f in vision_wasm_internal.js vision_wasm_internal.wasm; do
  curl -fsSL "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm/${f}" \
    -o "vendor/mediapipe/${f}"
done

echo "[akbal-vision] face_detector model…"
curl -fsSL "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite" \
  -o models/blaze_face_short_range.tflite

echo "[akbal-vision] face_landmarker model…"
curl -fsSL "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" \
  -o models/face_landmarker.task

echo "[akbal-vision] done. Assets under vendor/mediapipe/ and models/."
