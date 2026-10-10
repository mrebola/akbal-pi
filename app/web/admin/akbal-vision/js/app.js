import * as THREE from "../../vendor/three.module.min.js";
import { createEventBus } from "./events.js";
import { createConfig } from "./config.js";
import { createWorldStore } from "./worldstate.js";
import { createTracker } from "./tracker.js";
import { createCamera } from "./camera.js";
import { createVision } from "./vision.js";
import { createScene } from "./scene.js";
import { createHud } from "./hud.js";
import { createUI } from "./ui.js";
import { annotate } from "./analysis.js";
import { createMetricsHistory, computeMetrics } from "./metrics.js";
import { nullEstimator, filterEstimates } from "./estimator.js";

const video = document.getElementById("av-video");
const bus = createEventBus();
const config = createConfig();
const store = createWorldStore();
const tracker = createTracker();
const camera = createCamera({ video, config, bus });
const vision = createVision({ video });
const sceneApi = createScene(document.getElementById("av-hud"));
const hud = createHud(sceneApi, THREE);
const ui = createUI({ root: document.getElementById("av-ui"), bus, config, camera });
const metricsHistory = createMetricsHistory();
const estimator = nullEstimator; // Phase A: no-op; Phase B swaps in ONNX/TF.js

// Diegetic fullscreen: hide the admin navbar when idle, show on mouse move.
let navTimer = null;
function pokeNav() {
  document.body.classList.remove("av-navhidden");
  clearTimeout(navTimer);
  navTimer = setTimeout(() => document.body.classList.add("av-navhidden"), 3000);
}
window.addEventListener("mousemove", pokeNav);
window.addEventListener("touchstart", pokeNav);
pokeNav();

// Bus → event log (human-readable lines).
bus.on("camera.ready", () => ui.logEvent("CAMERA READY"));
bus.on("camera.error", (e) => ui.logEvent(`CAMERA ERROR ${e.name}`));
bus.on("vision.ready", () => ui.logEvent("VISION READY"));
bus.on("subject.created", (s) => { ui.logEvent(`SUBJECT ACQUIRED ${s.id}`); ui.flashAcquired(`TARGET ACQUIRED · ${s.id}`); });
bus.on("subject.lost", (s) => ui.logEvent(`SUBJECT LOST ${s.id}`));
bus.on("subject.eyeContact", (s) => ui.logEvent(`EYE CONTACT ${s.id}`));

const steps = [
  { label: "CAMERA", ok: false }, { label: "VISION", ok: false },
  { label: "TRACKER", ok: true }, { label: "RENDERER", ok: true },
];
ui.boot(steps);
ui.logEvent("SYSTEM ONLINE");

const perf = { cameraFps: 0, visionFps: 0, renderFps: 0, inferenceMs: 0, faces: 0 };

async function bootstrap() {
  const camOk = await camera.start();
  steps[0].ok = camOk; ui.boot(steps);
  ui.setDevices(await camera.listDevices()); // labels appear after permission granted
  try { await vision.init(); steps[1].ok = true; bus.emit("vision.ready"); }
  catch { ui.logEvent("VISION FAIL"); }
  ui.boot(steps, true); // final: a failed step now shows a legible SYSTEM ERROR, not a hang
  startLoops();
}

function startLoops() {
  const mode = config.current();

  // Vision loop: throttled, self-pacing (skips, never queues).
  let visionBusy = false, lastVision = 0, visionFrames = 0, visionWindow = performance.now();
  async function visionTick() {
    const now = performance.now();
    if (!visionBusy && now - lastVision >= 1000 / mode.visionFps) {
      visionBusy = true; lastVision = now;
      const t0 = performance.now();
      const dets = vision.detect(now);
      perf.inferenceMs = Math.round(performance.now() - t0);
      perf.faces = dets.length;
      const prev = store.snapshot();
      const { state, events } = tracker.update(dets, prev, now, { w: video.videoWidth, h: video.videoHeight });
      // Hito 2: fill pose/eyeContact/motion and emit eye-contact transitions.
      const frameDiag = Math.hypot(video.videoWidth || 0, video.videoHeight || 0);
      const ann = annotate(state.subjects, prev.subjects, frameDiag);
      // MEASURED metrics (EAR/MAR/gaze/coverage/blink/…) + ESTIMATED seam (no-op in Phase A).
      computeMetrics(state.subjects, prev.subjects, { w: video.videoWidth, h: video.videoHeight }, metricsHistory, now);
      const est = await estimator.estimate(state.subjects, video);
      for (const s of Object.values(state.subjects)) s.estimates = filterEstimates(est[s.id] || {});
      store.set(state);
      for (const ev of [...events, ...ann.events]) bus.emit(ev.type, ev.payload);
      visionFrames++;
      if (now - visionWindow >= 1000) { perf.visionFps = visionFrames; visionFrames = 0; visionWindow = now; }
      visionBusy = false;
    }
    setTimeout(visionTick, 5);
  }
  visionTick();

  // Render loop: rAF, reads WorldState and lerps the HUD.
  let renderFrames = 0, renderWindow = performance.now(), lastClock = 0;
  function renderTick() {
    const cssW = window.innerWidth, cssH = window.innerHeight;
    sceneApi.resize(cssW, cssH);
    const snap = store.snapshot();
    const dims = { cssW, cssH, videoW: video.videoWidth || cssW, videoH: video.videoHeight || cssH, mirror: true };
    hud.update(snap, dims);
    perf.resolution = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "—";
    ui.renderTarget(snap, perf);
    ui.renderLabels(snap, { map: (b) => hud.mapBox(b, dims) });
    renderFrames++;
    const now = performance.now();
    if (now - lastClock >= 1000) { ui.setClock(); lastClock = now; }
    if (now - renderWindow >= 1000) { perf.renderFps = renderFrames; renderFrames = 0; renderWindow = now; }
    requestAnimationFrame(renderTick);
  }
  requestAnimationFrame(renderTick);
}

bootstrap();
