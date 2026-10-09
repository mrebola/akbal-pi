// Performance modes (spec). HIGH=MacBook/PC, BALANCED=Pi, LOW=fallback.
export const MODES = {
  HIGH:     { video: { w: 1280, h: 720 }, visionFps: 15, renderFps: 60, landmarks: true,  effects: true  },
  BALANCED: { video: { w: 1280, h: 720 }, visionFps: 10, renderFps: 30, landmarks: true,  effects: false },
  LOW:      { video: { w: 640,  h: 480 }, visionFps: 8,  renderFps: 30, landmarks: false, effects: false },
};
const KEYS = { mode: "av.mode", cameraId: "av.cameraId", debug: "av.debug" };

// All storage access is guarded: private mode / blocked storage must not throw.
// Even READING the globalThis.localStorage property throws in sandboxed iframes,
// so acquiring it goes through this guard too (not just getItem/setItem).
function safeLocalStorage() { try { return globalThis.localStorage || null; } catch { return null; } }
function safeGet(storage, k) { try { return storage ? storage.getItem(k) : null; } catch { return null; } }
function safeSet(storage, k, v) { try { if (storage) storage.setItem(k, v); } catch { /* ignore */ } }

export function createConfig(storage = safeLocalStorage()) {
  const storedMode = safeGet(storage, KEYS.mode);
  let mode = MODES[storedMode] ? storedMode : "HIGH";
  let cameraId = safeGet(storage, KEYS.cameraId) || null;
  let debug = safeGet(storage, KEYS.debug) === "true";
  return {
    get mode() { return mode; },
    setMode(m) { if (MODES[m]) { mode = m; safeSet(storage, KEYS.mode, m); } },
    get cameraId() { return cameraId; },
    setCameraId(id) { cameraId = id || null; safeSet(storage, KEYS.cameraId, id || ""); },
    get debug() { return debug; },
    setDebug(b) { debug = !!b; safeSet(storage, KEYS.debug, b ? "true" : "false"); },
    current() { return MODES[mode]; },
  };
}
