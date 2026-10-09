import { FilesetResolver, FaceDetector } from "../vendor/mediapipe/vision_bundle.mjs";

// MediaPipe FaceDetector loaded 100% from vendored assets (no CDN). Runs in
// VIDEO mode against the <video> frame. Output bboxes are in video pixel space.
export function createVision({ video }) {
  let detector = null;

  async function init() {
    const files = await FilesetResolver.forVisionTasks("../vendor/mediapipe");
    detector = await FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: "../models/blaze_face_short_range.tflite" },
      runningMode: "VIDEO",
    });
  }

  function detect(nowMs) {
    if (!detector || !video.videoWidth) return [];
    const res = detector.detectForVideo(video, nowMs);
    return (res.detections || []).map((d) => {
      const bb = d.boundingBox; // originX/originY/width/height in pixels
      return {
        bbox: { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height },
        confidence: d.categories?.[0]?.score ?? 0,
      };
    });
  }

  return { init, detect };
}
