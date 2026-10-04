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
    Enter: "enter", NumpadEnter: "enter",
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
  const quitBtn = $("quit-btn");
  const gameNameEl = $("game-name");
  const closedPanelEl = $("closed-panel");
  const playAgainBtn = $("play-again");
  const fullscreenBtn = $("fullscreen-btn");
  const installHintEl = $("install-hint");
  const screenFrame = $("screen-frame");
  const fsHintEl = $("fs-hint");
  const qrCardEl = $("qr-card");
  const qrImg = $("qr-img");
  const qrMsgEl = $("qr-msg");
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

  // The token comes from the QR URL and is the initial value only. The server
  // rotates it for the web owner and sends the new one in the state as
  // msg.token. It is only ever sent in the "claim" message, never logged or
  // put in the DOM.
  let currentToken = new URLSearchParams(location.search).get("t") || "";
  // Opened from the QR (the URL carries the token): the page is only the pad.
  // Opened directly it keeps the full page: menu, video, volume, Jugar aquí.
  const controlOnly = Boolean(currentToken);
  document.documentElement.classList.toggle("doom-control", controlOnly);

  // The only game is the original DOOM (the server accepts only "doom1").
  const GAME_NAMES = { doom1: "DOOM" };
  const GAMES = Object.keys(GAME_NAMES);
  const urlGame = "doom1";
  // The game that is running, or the last one the server reported. Wins over
  // the URL, so Jugar aquí and Jugar de nuevo never switch games by accident.
  let stateGame = null;
  let closed = false; // the game was closed (Salir or the Pi closed it)

  let socket = null;
  let connected = false;
  let controller = false;
  let running = false;
  let owner = null; // "pi" | "web" | null, from the server state
  let mirror = false; // true when another device or the Pi is playing
  let wasMirror = false; // mirror value from the previous state, to detect entering mirror
  // Set after a stop is sent, until the next state arrives. Blocks a double tap.
  let quitPending = false;
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
    pointers.clear();
    inputs.clear();
    sync();
  }

  function setHint(text) {
    hintEl.textContent = text;
  }

  // The web owner and the control holder may change volume; the server drops
  // the message from anyone else, so the buttons stay off for them too.
  function isWebOwner() {
    return owner === "web" && !mirror;
  }

  function clampVolume(value) {
    return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, value));
  }

  function renderStatus() {
    let text;
    if (!connected) text = "Reconectando con Akbal…";
    else if (closed) text = "El juego fue cerrado.";
    else if (mirror) {
      text = owner === "pi"
        ? "DOOM corre en la Pi. Estás viendo el espejo."
        : "DOOM juega desde otro dispositivo. Estás viendo el espejo.";
    } else if (!running) text = "DOOM no está corriendo en la Pi";
    else if (controller) text = "Tienes el control";
    else text = "Juego en curso. Toca Tomar control para jugar.";
    statusEl.textContent = serverError ? `${text} · Error: ${serverError}` : text;
    // Control-only mode shows the status line only when something blocks the pad.
    statusEl.hidden = controlOnly && connected && running && controller && !mirror && !serverError;

    claimBtn.textContent = controller ? "Soltar control" : "Tomar control";
    claimBtn.disabled = !connected || !currentToken || mirror;
    claimBtn.hidden = controlOnly && (!running || mirror);
    controlsEl.classList.toggle("locked", !controller);
    controlsEl.classList.toggle("mirror", mirror);

    // Jugar aquí starts the game when nothing runs, or takes it over from the
    // Pi when we are only mirroring it.
    playHereBtn.hidden = !(mirror || !running);
    playHereBtn.disabled = !connected;

    // Which game is in play, shown as text only: switching needs a new URL.
    const shownGame = running && stateGame ? GAME_NAMES[stateGame] : null;
    gameNameEl.hidden = !shownGame;
    gameNameEl.textContent = shownGame ? `Juego: ${shownGame}` : "";
    closedPanelEl.hidden = !closed;
    playAgainBtn.disabled = !connected;

    const canStep = connected && (controller || isWebOwner()) && volume !== null;
    volumeDownBtn.disabled = !canStep || volume <= VOLUME_MIN;
    volumeUpBtn.disabled = !canStep || volume >= VOLUME_MAX;
    volumeValueEl.textContent = volume === null ? "—" : `${volume}%`;

    // Only the web owner can stop the game; the server refuses it otherwise.
    quitBtn.hidden = !isWebOwner();
    quitBtn.disabled = !connected || quitPending;

    // Keys are disabled while mirroring. sync() would not send them anyway
    // without control, but the disabled look makes the state clear.
    for (const els of keyEls.values()) {
      for (const el of els) el.disabled = mirror;
    }

    updateConsoleBar();
  }

  function isPortrait() {
    return portraitQuery.matches && window.innerWidth < window.innerHeight;
  }

  // The console bar holds claim, volume and stop. In control-only mode it stays
  // hidden while we hold the control, so the pad gets the whole screen. A closed
  // game hides the bar and the pad; the closed panel offers to play again.
  function updateConsoleBar() {
    const portrait = isPortrait();
    consoleBar.hidden = portrait || closed || (controlOnly && controller);
    controlsEl.hidden = portrait || closed;
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
    rotateHintEl.hidden = !isPortrait();
    updateConsoleBar();
    document.documentElement.style.setProperty("--doom-topbar-h", `${topbarEl.offsetHeight}px`);
  }

  function handleState(msg) {
    // Any state answers the last stop, so the button is usable again unless
    // the game is now gone (renderStatus hides it then).
    quitPending = false;
    running = Boolean(msg.running);
    controller = Boolean(msg.controller);
    owner = msg.owner === "pi" || msg.owner === "web" ? msg.owner : null;
    mirror = Boolean(msg.mirror);
    if (typeof msg.volume === "number") volume = msg.volume;
    audioError = msg.audioError || null;
    musicError = msg.musicError || null;
    serverError = msg.error || null;
    closed = Boolean(msg.closed);
    if (typeof msg.game === "string" && GAMES.includes(msg.game)) stateGame = msg.game;
    else if (!closed && !running) stateGame = null;
    // A closed game leaves no picture behind.
    if (closed) canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    // Rotated token for the web owner. Stored only, never shown or logged.
    if (typeof msg.token === "string" && msg.token) currentToken = msg.token;

    // Turn the video on only when entering mirror (false -> true), so the user
    // can switch it off while mirroring without it coming back on each state.
    if (mirror && !wasMirror && !streamSwitch.checked && !controlOnly) {
      streamSwitch.checked = true;
      canvas.hidden = false;
      send({ type: "stream", on: true });
    }
    wasMirror = mirror;

    // The QR is fetched when the game starts or the owner changes (claimOwner
    // reissues the token then), never on every state.
    if (running !== wasRunning || owner !== wasOwner) {
      wasRunning = running;
      wasOwner = owner;
      if (running) loadQr();
      else showQrMessage();
    }

    renderStatus();
    renderWarnings();
    sync();
  }

  // Desktop only, and only for the admin's own page: the endpoint needs the
  // admin session, and the QR card is hidden on phones by CSS. The image
  // carries the link; the link text itself is never written to the DOM.
  let wasRunning = false;
  let wasOwner = null;
  // Each request gets a number; only the newest answer is shown, so a slow
  // reply for an old token cannot overwrite the current one.
  let qrSeq = 0;
  // Same breakpoint as the CSS desktop layout (doom.css).
  const desktopQuery = window.matchMedia("(min-width: 900px) and (min-height: 500px)");

  function showQrMessage() {
    qrSeq += 1;
    qrImg.hidden = true;
    qrImg.removeAttribute("src");
    qrMsgEl.hidden = false;
  }

  async function loadQr() {
    if (controlOnly || !desktopQuery.matches) return;
    const seq = ++qrSeq;
    try {
      const res = await fetch("/api/doom/control-qr", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = await res.json();
      if (typeof body.qr !== "string" || !body.qr.startsWith("data:image/")) throw new Error("no image");
      if (seq !== qrSeq) return;
      qrImg.src = body.qr;
      qrImg.hidden = false;
      qrMsgEl.hidden = true;
    } catch {
      if (seq === qrSeq) showQrMessage();
    }
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
      if (currentToken) send({ type: "claim", token: currentToken });
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

  // On-screen buttons, touch first. Each finger (pointerId) owns its own keys.
  // While a finger is down it can slide: the button under it decides the keys,
  // so sliding releases the old key and presses the new one without lifting the
  // finger. Lifting, cancelling or losing focus releases everything the finger
  // held. Hover is never used, since touch has none.
  // FIRE also sends Enter: POINTER_KEYS lists every key one button presses.
  const POINTER_KEYS = { fire: ["fire", "enter"] };
  const pointers = new Map(); // pointerId -> { keys: string[] } currently held

  function keysOf(el) {
    const key = el.dataset.key;
    return POINTER_KEYS[key] || [key];
  }

  // Sends only the difference: keys the finger left are released, keys it
  // reached are pressed. No button under the finger means no keys.
  function moveFinger(pointerId, el) {
    const state = pointers.get(pointerId);
    if (!state) return;
    const next = el ? keysOf(el) : [];
    for (const key of state.keys) {
      if (!next.includes(key)) release(`ptr:${pointerId}:${key}`);
    }
    for (const key of next) {
      if (!state.keys.includes(key)) press(`ptr:${pointerId}:${key}`, key);
    }
    state.keys = next;
  }

  function endFinger(pointerId) {
    const state = pointers.get(pointerId);
    if (!state) return;
    pointers.delete(pointerId);
    for (const key of state.keys) release(`ptr:${pointerId}:${key}`);
  }

  // The button under a screen point, but only one that belongs to the pad.
  function buttonAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const el = hit && hit.closest ? hit.closest("[data-key]") : null;
    return el && controlsEl.contains(el) ? el : null;
  }

  document.querySelectorAll("[data-key]").forEach((el) => {
    el.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      if (!controller) setHint("Toma el control primero.");
      pointers.set(event.pointerId, { keys: [] });
      // Capture keeps this finger's moves coming even after it leaves the button.
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // Without capture the moves still reach the window listener below.
      }
      moveFinger(event.pointerId, el);
    });
    // A long press on a touch screen opens the context menu and would swallow
    // the release.
    el.addEventListener("contextmenu", (event) => event.preventDefault());
  });

  window.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    moveFinger(event.pointerId, buttonAt(event.clientX, event.clientY));
  });

  const endPointer = (event) => endFinger(event.pointerId);
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  // Fullscreen works on Android. iPhone Safari has no page fullscreen, so
  // there the install hint points to "Agregar a inicio" instead.
  const fullscreenOk = typeof document.documentElement.requestFullscreen === "function"
    && document.fullscreenEnabled !== false;
  fullscreenBtn.hidden = !fullscreenOk;
  // On desktop only the game goes fullscreen: the frame around the canvas,
  // which also holds the "Esc" hint. The video is turned on first, because a
  // hidden canvas cannot go fullscreen. On phones the page goes fullscreen as before.
  fullscreenBtn.addEventListener("click", () => {
    try {
      let request;
      if (desktopQuery.matches && typeof screenFrame.requestFullscreen === "function") {
        if (canvas.hidden) {
          streamSwitch.checked = true;
          canvas.hidden = false;
          send({ type: "stream", on: true });
        }
        request = screenFrame.requestFullscreen();
      } else {
        request = document.documentElement.requestFullscreen();
      }
      if (request && typeof request.catch === "function") request.catch(() => {});
    } catch {
      // Not allowed here: the page stays as it is.
    }
  });

  document.addEventListener("fullscreenchange", () => {
    fsHintEl.hidden = document.fullscreenElement !== screenFrame;
  });
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true
    || window.matchMedia("(display-mode: standalone)").matches;
  installHintEl.hidden = !isIos || standalone;

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
    } else if (currentToken) {
      send({ type: "claim", token: currentToken });
    }
  });

  streamSwitch.addEventListener("change", () => {
    const on = streamSwitch.checked;
    canvas.hidden = !on;
    if (!on) canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    send({ type: "stream", on });
  });

  // Starts the game in play, or the one in the URL when none is known. Used by
  // Jugar aquí (take over or start) and by Jugar de nuevo after a close.
  function playHere() {
    send({ type: "play-here", game: stateGame || urlGame });
  }

  playHereBtn.addEventListener("click", playHere);
  playAgainBtn.addEventListener("click", playHere);

  // The step is taken from the last volume the server reported, not from a
  // local guess, so the value always matches what the Pi plays.
  function stepVolume(delta) {
    if (volume === null) return;
    send({ type: "volume", value: clampVolume(volume + delta) });
  }

  quitBtn.addEventListener("click", () => {
    if (quitPending) return;
    quitPending = true;
    send({ type: "stop" });
    renderStatus();
  });

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
