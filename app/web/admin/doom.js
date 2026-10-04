// Control page for DOOM on the Pi. Plain script, no build step.
// Protocol and control policy: docs/superpowers/specs/2026-10-03-doom-design.md
(() => {
  "use strict";

  // Same table as BROWSER_TO_KEY in app/src/doom/keymap.ts. Keep them in sync:
  // the server rejects any key name that is not in DOOM_KEYS.
  const BROWSER_TO_KEY = {
    ArrowUp: "forward", KeyW: "forward",
    ArrowDown: "back", KeyS: "back",
    ArrowLeft: "left",
    ArrowRight: "right",
    KeyA: "strafeLeft",
    KeyD: "strafeRight",
    ControlLeft: "fire", ControlRight: "fire", Space: "fire",
    KeyE: "use",
    ShiftLeft: "run", ShiftRight: "run",
    Escape: "menu",
    Digit1: "weapon1", Digit2: "weapon2", Digit3: "weapon3", Digit4: "weapon4",
    Digit5: "weapon5", Digit6: "weapon6", Digit7: "weapon7",
  };

  // Standard Gamepad mapping: buttons 12-15 are the D-pad, 0 = A, 1 = B,
  // 2 = X, 9 = Start. Other layouts will not match these indexes.
  const GP_DPAD = { forward: 12, back: 13, left: 14, right: 15 };
  const GP_BUTTONS = { fire: 0, use: 1, run: 2, menu: 9 };
  const GP_KEYS = [...Object.keys(GP_DPAD), ...Object.keys(GP_BUTTONS)];
  const STICK_THRESHOLD = 0.5;

  const RETRY_MIN_MS = 2000;
  const RETRY_MAX_MS = 10000;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const hintEl = $("hint");
  const claimBtn = $("claim");
  const playHereBtn = $("play-here");
  const volumeDownBtn = $("volume-down");
  const volumeUpBtn = $("volume-up");
  const volumeValueEl = $("volume-value");
  const consoleBar = $("console-bar");
  const warningsEl = $("warnings");
  const audioWarningEl = $("audio-warning");
  const musicWarningEl = $("music-warning");
  const rotateHintEl = $("rotate-hint");
  const topbarEl = $("topbar");
  const streamSwitch = $("stream");
  const controlsEl = $("controls");
  const canvas = $("screen");
  const canvasCtx = canvas.getContext("2d");

  const VOLUME_MIN = 0;
  const VOLUME_MAX = 100;
  const VOLUME_STEP = 5;
  const portraitQuery = window.matchMedia("(orientation: portrait)");

  // The token comes from the QR URL. It is only ever sent in the "claim"
  // message, never logged or put in the DOM.
  const token = new URLSearchParams(location.search).get("t") || "";

  let socket = null;
  let connected = false;
  let controller = false;
  let running = false;
  let owner = null; // "pi" | "web" | null, from the server state
  let mirror = false; // true when another device or the Pi is playing
  let volume = null; // last volume the server reported (0..100), null until known
  let audioError = null;
  let musicError = null;
  let serverError = null;
  let retryDelay = RETRY_MIN_MS;
  let retryTimer = null;

  // Every source of input (pointer, keyboard, gamepad) registers a token here.
  // The key is only released on the server when no source still holds it, so
  // releasing one source cannot cancel a key that another source still holds.
  const inputs = new Map(); // token -> key name
  // Keys the server currently has down for us.
  const sent = new Set();
  const keyEls = new Map(); // key name -> [button elements]

  document.querySelectorAll("[data-key]").forEach((el) => {
    const list = keyEls.get(el.dataset.key) || [];
    list.push(el);
    keyEls.set(el.dataset.key, list);
  });

  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  function paint(active) {
    for (const [key, els] of keyEls) {
      const on = active.has(key);
      for (const el of els) el.classList.toggle("is-down", on);
    }
  }

  // Sends only the difference against what the server already has down.
  // Without control nothing new is sent, but local state still updates so the
  // pressed highlight matches the physical input.
  function sync() {
    const want = new Set(inputs.values());
    paint(want);
    if (!connected || !controller) {
      // The server does not release keys when we lose control, so send the
      // ups ourselves. send() is a no-op once the socket is gone, which covers
      // the close case.
      for (const key of sent) send({ type: "key", key, down: false });
      sent.clear();
      return;
    }
    for (const key of want) {
      if (!sent.has(key)) send({ type: "key", key, down: true });
    }
    for (const key of sent) {
      if (!want.has(key)) send({ type: "key", key, down: false });
    }
    sent.clear();
    for (const key of want) sent.add(key);
  }

  function press(source, key) {
    inputs.set(source, key);
    sync();
  }

  function release(source) {
    if (inputs.delete(source)) sync();
  }

  function releaseAll() {
    inputs.clear();
    sync();
  }

  function setHint(text) {
    hintEl.textContent = text;
  }

  // Only the web owner's own socket is allowed to change volume; the server
  // drops the message from anyone else, so the buttons stay off for them too.
  function isWebOwner() {
    return owner === "web" && !mirror;
  }

  function clampVolume(value) {
    return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, value));
  }

  function renderStatus() {
    let text;
    if (!connected) text = "Reconectando con Akbal…";
    else if (mirror) {
      text = owner === "pi"
        ? "DOOM corre en la Pi. Estás viendo el espejo."
        : "DOOM juega desde otro dispositivo. Estás viendo el espejo.";
    } else if (!running) text = "DOOM no está corriendo en la Pi";
    else if (controller) text = "Tienes el control";
    else text = "Juego en curso. Toca Tomar control para jugar.";
    statusEl.textContent = serverError ? `${text} · Error: ${serverError}` : text;

    claimBtn.textContent = controller ? "Soltar control" : "Tomar control";
    claimBtn.disabled = !connected || !token || mirror;
    controlsEl.classList.toggle("locked", !controller);
    controlsEl.classList.toggle("mirror", mirror);

    // Jugar aquí starts the game when nothing runs, or takes it over from the
    // Pi when we are only mirroring it.
    playHereBtn.hidden = !(mirror || !running);
    playHereBtn.disabled = !connected;

    const canStep = connected && isWebOwner() && volume !== null;
    volumeDownBtn.disabled = !canStep || volume <= VOLUME_MIN;
    volumeUpBtn.disabled = !canStep || volume >= VOLUME_MAX;
    volumeValueEl.textContent = volume === null ? "—" : `${volume}%`;

    // Keys are disabled while mirroring. sync() would not send them anyway
    // without control, but the disabled look makes the state clear.
    for (const els of keyEls.values()) {
      for (const el of els) el.disabled = mirror;
    }

    if (!token) setHint("Falta el token en la URL. Abre esta página desde el QR de la Pi.");
  }

  function renderWarnings() {
    audioWarningEl.hidden = !audioError;
    audioWarningEl.textContent = audioError ? `Sin sonido: ${audioError}` : "";
    musicWarningEl.hidden = !musicError;
    musicWarningEl.textContent = musicError ? `Sin música: ${musicError}` : "";
    warningsEl.hidden = !audioError && !musicError;
  }

  // Portrait hides the controls and shows the rotate hint. The hint sits
  // under the topbar so the hamburger menu still works to leave this page.
  function renderOrientation() {
    const portrait = portraitQuery.matches && window.innerWidth < window.innerHeight;
    rotateHintEl.hidden = !portrait;
    controlsEl.hidden = portrait;
    consoleBar.hidden = portrait;
    document.documentElement.style.setProperty("--doom-topbar-h", `${topbarEl.offsetHeight}px`);
  }

  function handleState(msg) {
    running = Boolean(msg.running);
    controller = Boolean(msg.controller);
    owner = msg.owner === "pi" || msg.owner === "web" ? msg.owner : null;
    mirror = Boolean(msg.mirror);
    if (typeof msg.volume === "number") volume = msg.volume;
    audioError = msg.audioError || null;
    musicError = msg.musicError || null;
    serverError = msg.error || null;

    // A mirror always sees the game, so turn the video on once. The user can
    // still switch it off afterwards.
    if (mirror && !streamSwitch.checked) {
      streamSwitch.checked = true;
      canvas.hidden = false;
      send({ type: "stream", on: true });
    }

    renderStatus();
    renderWarnings();
    sync();
  }

  function drawFrame(buffer) {
    // Video is opt-in. If a frame arrives after the switch is off, drop it.
    // While a frame is still decoding, newer frames are skipped on purpose:
    // stale frames would only add latency.
    if (!streamSwitch.checked || drawFrame.busy) return;
    drawFrame.busy = true;
    createImageBitmap(new Blob([buffer], { type: "image/jpeg" }))
      .then((bitmap) => {
        canvasCtx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      })
      .catch(() => {})
      .finally(() => {
        drawFrame.busy = false;
      });
  }

  function scheduleReconnect() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  function connect() {
    retryTimer = null;
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/doom";
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      connected = true;
      retryDelay = RETRY_MIN_MS;
      // Claim goes first so the stream toggle restored below reaches a client
      // that already has its control state.
      if (token) send({ type: "claim", token });
      if (streamSwitch.checked) send({ type: "stream", on: true });
      renderStatus();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg && msg.type === "state") handleState(msg);
      } else {
        drawFrame(event.data);
      }
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      connected = false;
      controller = false;
      sent.clear();
      renderStatus();
      sync();
      scheduleReconnect();
    };
  }

  // On-screen buttons. Pointer events cover touch, pen and mouse. Up is sent
  // on pointerup, pointerleave and pointercancel, so a finger that slides off
  // or a browser gesture cannot leave a key stuck down on the server.
  document.querySelectorAll("[data-key]").forEach((el) => {
    const key = el.dataset.key;
    el.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      if (!controller) setHint("Toma el control primero.");
      press(`ptr:${event.pointerId}:${key}`, key);
    });
    const up = (event) => release(`ptr:${event.pointerId}:${key}`);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", up);
    el.addEventListener("pointercancel", up);
    // A long press on a touch screen opens the context menu and would swallow
    // the release.
    el.addEventListener("contextmenu", (event) => event.preventDefault());
  });

  // Keyboard. keydown/keyup are prevented for mapped codes so Space does not
  // scroll or toggle the focused switch, and so arrows do not scroll the page.
  window.addEventListener("keydown", (event) => {
    if (!Object.prototype.hasOwnProperty.call(BROWSER_TO_KEY, event.code)) return;
    event.preventDefault();
    if (event.repeat) return;
    press(`kbd:${event.code}`, BROWSER_TO_KEY[event.code]);
  });

  window.addEventListener("keyup", (event) => {
    if (!Object.prototype.hasOwnProperty.call(BROWSER_TO_KEY, event.code)) return;
    event.preventDefault();
    release(`kbd:${event.code}`);
  });

  // If the window loses focus, keyup and pointerup may never arrive. Dropping
  // all held input here prevents a key from staying down on the Pi.
  window.addEventListener("blur", releaseAll);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAll();
  });

  claimBtn.addEventListener("click", () => {
    if (controller) {
      send({ type: "release" });
    } else if (token) {
      send({ type: "claim", token });
    }
  });

  streamSwitch.addEventListener("change", () => {
    const on = streamSwitch.checked;
    canvas.hidden = !on;
    if (!on) canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    send({ type: "stream", on });
  });

  playHereBtn.addEventListener("click", () => {
    send({ type: "play-here" });
  });

  // The step is taken from the last volume the server reported, not from a
  // local guess, so the value always matches what the Pi plays.
  function stepVolume(delta) {
    if (volume === null) return;
    send({ type: "volume", value: clampVolume(volume + delta) });
  }

  volumeDownBtn.addEventListener("click", () => stepVolume(-VOLUME_STEP));
  volumeUpBtn.addEventListener("click", () => stepVolume(VOLUME_STEP));

  portraitQuery.addEventListener("change", renderOrientation);
  window.addEventListener("resize", renderOrientation);

  // Gamepad. Polled every animation frame because the Gamepad API has no
  // reliable button events across browsers. Only changes reach sync().
  function readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  function pollGamepad() {
    const active = new Set();
    const pad = readGamepad();
    if (pad) {
      for (const [key, index] of Object.entries(GP_DPAD)) {
        if (pad.buttons[index] && pad.buttons[index].pressed) active.add(key);
      }
      for (const [key, index] of Object.entries(GP_BUTTONS)) {
        if (pad.buttons[index] && pad.buttons[index].pressed) active.add(key);
      }
      const x = pad.axes[0] || 0;
      const y = pad.axes[1] || 0;
      if (x < -STICK_THRESHOLD) active.add("left");
      if (x > STICK_THRESHOLD) active.add("right");
      if (y < -STICK_THRESHOLD) active.add("forward");
      if (y > STICK_THRESHOLD) active.add("back");
    }

    let changed = false;
    for (const key of GP_KEYS) {
      const source = `gp:${key}`;
      const on = active.has(key);
      if (on && !inputs.has(source)) {
        inputs.set(source, key);
        changed = true;
      } else if (!on && inputs.has(source)) {
        inputs.delete(source);
        changed = true;
      }
    }
    if (changed) sync();
    requestAnimationFrame(pollGamepad);
  }

  renderStatus();
  renderWarnings();
  renderOrientation();
  connect();
  requestAnimationFrame(pollGamepad);
})();
