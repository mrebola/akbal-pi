import { FilesetResolver, FaceLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";
import { SELECTED_LANDMARKS } from "./analysis.js";

// MediaPipe FaceLandmarker (vendored, no CDN). VIDEO mode. Outputs, per face:
// selected landmarks + full-extent bbox (video pixels) + the 4x4 facial
// transformation matrix (head pose). Absolute asset URLs (document-relative,
// not module-relative — the page is served from /akbal-vision/).
export function createVision({ video }) {
  let landmarker = null;

  async function init() {
    const files = await FilesetResolver.forVisionTasks("/akbal-vision/vendor/mediapipe");
    landmarker = await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: "/akbal-vision/models/face_landmarker.task" },
      runningMode: "VIDEO",
      numFaces: 4,
      outputFacialTransformationMatrixes: true,
    });
  }

  function detect(nowMs) {
    if (!landmarker || !video.videoWidth) return [];
    const res = landmarker.detectForVideo(video, nowMs);
    const W = video.videoWidth, H = video.videoHeight;
    const faces = res.faceLandmarks || [];
    return faces.map((lm, i) => {
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of lm) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const bbox = { x: minX * W, y: minY * H, w: (maxX - minX) * W, h: (maxY - minY) * H };
      const landmarks = SELECTED_LANDMARKS.filter((idx) => lm[idx]).map((idx) => ({ x: lm[idx].x * W, y: lm[idx].y * H }));
      const m = res.facialTransformationMatrixes?.[i]?.data;
      const matrix = m ? Array.from(m) : null;
      return { bbox, confidence: 1, landmarks, matrix };
    });
  }

  return { init, detect };
}
