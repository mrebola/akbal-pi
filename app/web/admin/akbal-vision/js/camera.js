// Camera acquisition + hot-switching. getUserMedia requires a secure context
// (https or localhost) — see spec; errors surface as camera.error, never a
// blank screen. facingMode:"user" preferred on first run.
export function createCamera({ video, config, bus }) {
  let stream = null;
  let activeDeviceId = null;

  async function listDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Cámara ${i + 1}` }));
    } catch {
      return [];
    }
  }

  async function start(deviceId = config.cameraId || undefined) {
    stop();
    const v = config.current().video;
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: v.w }, height: { ideal: v.h }, frameRate: { ideal: 30 } }
        : { facingMode: "user", width: { ideal: v.w }, height: { ideal: v.h }, frameRate: { ideal: 30 } },
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      activeDeviceId = track?.getSettings?.().deviceId || deviceId || null;
      if (activeDeviceId) config.setCameraId(activeDeviceId);
      bus.emit("camera.ready", { deviceId: activeDeviceId, width: video.videoWidth, height: video.videoHeight });
      bus.emit("camera.changed", { deviceId: activeDeviceId });
      return true;
    } catch (err) {
      bus.emit("camera.error", { name: err?.name || "Error", message: err?.message || String(err) });
      return false;
    }
  }

  function stop() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  return { listDevices, start, stop, get activeDeviceId() { return activeDeviceId; } };
}
