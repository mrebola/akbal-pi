import { exec } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { Socket } from "net";
import { getCurrentTimeTag } from "../utils";
import { WebDisplayServer } from "./web-display";
import { webAudioBridge } from "./web-audio-bridge";
import dotEnv from "dotenv";

dotEnv.config();

const DOUBLE_CLICK_WINDOW_MS = 800;
const DOUBLE_CLICK_MAX_PRESS_MS = 350;

export interface Status {
  status: string;
  emoji: string;
  text: string;
  terminal_text: string;
  tool_placeholders: Record<string, string>;
  text_input_enabled?: boolean;
  scroll_speed: number;
  scroll_sync?: {
    char_end: number;
    duration_ms: number;
  };
  brightness: number;
  RGB: string;
  battery_color: string;
  battery_level: number | undefined;
  image: string;
  camera_mode: boolean;
  camera_capture?: boolean;
  capture_image_path: string;
  wifi_signal_level: number;
  vpn_connected: boolean;
  rag_icon_visible: boolean;
  image_icon_visible: boolean;
  music_progress: number | undefined;
  music_duration_ms: number | undefined;
  approval_mode: boolean;
  // Generic button-driven carousel overlay, shared by the model picker
  // (model-select-mode.ts), the agent/local picker (mode-select-mode.ts) and
  // the quick menu (quick-menu-mode.ts) — replaces the character GIF with a
  // consistent "card" screen (title, name, description, active badge,
  // position) while browsing or confirming an option, or loading one.
  // model_ui_title distinguishes which of the three is showing ("MODELO" /
  // "MODO" / "MENÚ") — see docs/display-ui.md.
  model_ui: "" | "select" | "confirm" | "loading" | "network";
  model_ui_title: string;
  model_ui_label: string;
  model_ui_description: string;
  // Real elapsed-hold percent while confirming (0-100). Ignored while
  // model_ui === "loading" — that's an indeterminate wait (see
  // docs/display-ui.md), not a measurable percentage.
  model_ui_percent: number;
  model_ui_index: number;
  model_ui_total: number;
  model_ui_active: boolean;
  // Path to a QR PNG (network-info-mode.ts) — only meaningful when
  // model_ui === "network"; chatbot-ui.py pastes it into the card in place
  // of the ring/spinner the confirm/loading modes draw there.
  model_ui_qr_path: string;
  // Voice-command cheat sheet overlay ("ayuda" — see chat-flow/help-mode.ts).
  // Same card look as model_ui, paging through short command pairs; exits
  // via hold/double-click like the other menus, not a dedicated screen.
  help_ui: "" | "view";
  help_ui_body: string;
  help_ui_page: number;
  help_ui_total: number;
  // Simplified WiFi radar screen (see chat-flow/wifi-radar-mode.ts) — a
  // dedicated screen type like model_ui/help_ui above rather than another
  // model_ui variant, since it needs a custom-drawn scene (rings, sweep,
  // plotted points) instead of the shared title/label/description card
  // layout. "unavailable" is shown when no AR9271-class adapter is
  // detected at all; "view" draws the radar with radar_ui_points.
  radar_ui: "" | "view" | "unavailable";
  // featured marks the one point currently named in the bottom text band
  // (see wifi-radar-mode.ts's carousel) — chatbot-ui.py draws a white
  // outline ring around that dot specifically, so it's obvious which
  // network on screen the name/dBm caption below is talking about.
  radar_ui_points: {
    angle: number;
    radius: number;
    strength: "strong" | "mid" | "weak";
    featured: boolean;
  }[];
  radar_ui_count: number;
  radar_ui_channel: number;
  // Small always-on indicator in the top bar (see render_top_bar in
  // chatbot-ui.py) showing whether the device is answering via OpenClaw or
  // the local model — see docs/agent-mode.md.
  top_bar_mode: "local" | "agent" | "";
}

export class WhisplayDisplay {
  private currentStatus: Status = {
    status: "starting",
    emoji: "😊",
    text: "",
    terminal_text: "",
    tool_placeholders: {},
    text_input_enabled: false,
    scroll_speed: 3,
    scroll_sync: undefined,
    brightness: 100,
    RGB: "#00FF30",
    battery_color: "#000000",
    battery_level: undefined,
    image: "",
    camera_mode: false,
    capture_image_path: "",
    wifi_signal_level: 0,
    vpn_connected: false,
    rag_icon_visible: false,
    image_icon_visible: false,
    music_progress: undefined,
    music_duration_ms: undefined,
    approval_mode: false,
    model_ui: "",
    model_ui_title: "",
    model_ui_label: "",
    model_ui_description: "",
    model_ui_percent: 0,
    model_ui_index: 0,
    model_ui_total: 0,
    model_ui_active: false,
    model_ui_qr_path: "",
    help_ui: "",
    help_ui_body: "",
    help_ui_page: 0,
    help_ui_total: 0,
    radar_ui: "",
    radar_ui_points: [],
    radar_ui_count: 0,
    radar_ui_channel: 0,
    top_bar_mode: "",
  };

  private client = null as Socket | null;
  private buttonPressedCallback: () => void = () => {};
  private buttonReleasedCallback: () => void = () => {};
  private buttonDoubleClickCallback: (() => void) | null = null;
  private buttonDown = false;
  private onCameraCaptureCallback: () => void = () => {};
  private textInputCallback: (text: string) => void = () => {};
  private isReady: Promise<void>;
  private pythonProcess: any; // Placeholder for Python process if needed
  private buttonPressTimeArray: number[] = [];
  private buttonReleaseTimeArray: number[] = [];
  private webDisplay: WebDisplayServer | null = null;
  private deviceEnabled: boolean;
  private cameraEnabled: boolean;
  private receiveBuffer = "";
  private textCounterTimer: NodeJS.Timeout | null = null;
  private textCounterTemplate: string | null = null;
  private textCounterStartAt = 0;
  private daemonSocketPath = "/tmp/whisplay-daemon.sock";

  constructor() {
    const envDeviceEnabled = parseBoolEnv("WHISPLAY_DEVICE_ENABLED", true);
    const daemonDetected = existsSync(this.daemonSocketPath);
    this.deviceEnabled = envDeviceEnabled || daemonDetected;
    if (!envDeviceEnabled && daemonDetected) {
      console.log(
        `[Display] Detected whisplay-daemon at ${this.daemonSocketPath}, enabling hardware path automatically.`,
      );
    }
    this.cameraEnabled = parseBoolEnv("ENABLE_CAMERA", false);
    const webCameraEnabled = parseBoolEnv("WEB_CAMERA_ENABLED", false);
    if (this.cameraEnabled && !webCameraEnabled) {
      this.ensureCameraDaemon();
    }
    const webEnabled = parseBoolEnv("WHISPLAY_WEB_ENABLED", false);
    if (webEnabled) {
      const port = parseInt(process.env.WHISPLAY_WEB_PORT || "17880", 10);
      const host = process.env.WHISPLAY_WEB_HOST || "0.0.0.0";
      this.webDisplay = new WebDisplayServer({
        host,
        port,
        onButtonPress: () => this.handleButtonPressedEvent(),
        onButtonRelease: () => this.handleButtonReleasedEvent(),
        onTextInput: (text: string) => this.handleTextInputEvent(text),
      });
      this.webDisplay.updateStatus(this.currentStatus);
    }

    if (this.deviceEnabled) {
      this.startPythonProcess();
      this.isReady = new Promise<void>((resolve) => {
        this.connectWithRetry(15, resolve);
      });
    } else {
      this.isReady = Promise.resolve();
    }
  }

  private maybeEmitDoubleClick(): void {
    if (!this.buttonDoubleClickCallback) return;

    const now = Date.now();
    this.buttonPressTimeArray = this.buttonPressTimeArray.filter(
      (time) => now - time <= DOUBLE_CLICK_WINDOW_MS,
    );
    this.buttonReleaseTimeArray = this.buttonReleaseTimeArray.filter(
      (time) => now - time <= DOUBLE_CLICK_WINDOW_MS,
    );
    if (
      this.buttonPressTimeArray.length < 2 ||
      this.buttonReleaseTimeArray.length < 2
    ) {
      return;
    }

    const firstPress =
      this.buttonPressTimeArray[this.buttonPressTimeArray.length - 2];
    const secondPress =
      this.buttonPressTimeArray[this.buttonPressTimeArray.length - 1];
    const firstRelease =
      this.buttonReleaseTimeArray[this.buttonReleaseTimeArray.length - 2];
    const secondRelease =
      this.buttonReleaseTimeArray[this.buttonReleaseTimeArray.length - 1];
    const firstPressDuration = firstRelease - firstPress;
    const secondPressDuration = secondRelease - secondPress;
    const doubleClickDetected =
      firstPress <= firstRelease &&
      firstRelease <= secondPress &&
      secondPress <= secondRelease &&
      secondRelease - firstPress <= DOUBLE_CLICK_WINDOW_MS &&
      firstPressDuration <= DOUBLE_CLICK_MAX_PRESS_MS &&
      secondPressDuration <= DOUBLE_CLICK_MAX_PRESS_MS;

    if (doubleClickDetected) {
      this.buttonPressTimeArray = [];
      this.buttonReleaseTimeArray = [];
      this.buttonDoubleClickCallback();
    }
  }

  startPythonProcess(): void {
    if (!this.deviceEnabled) {
      return;
    }
    const command = `cd ${resolve(
      __dirname,
      "../../python",
    )} && python3 chatbot-ui.py`;
    console.log("Starting Python process...");
    this.pythonProcess = exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Error starting Python process:", error);
        return;
      }
      console.log("Python process stdout:", stdout);
      console.error("Python process stderr:", stderr);
    });
    this.pythonProcess.stdout.on("data", (data: any) =>
      console.log(data.toString()),
    );
    this.pythonProcess.stderr.on("data", (data: any) =>
      console.error(data.toString()),
    );
  }

  killPythonProcess(): void {
    if (!this.deviceEnabled) {
      return;
    }
    if (this.pythonProcess) {
      console.log("Killing Python process...", this.pythonProcess.pid);
      try {
        this.pythonProcess.kill();
      } catch (error) {
        console.warn("Failed to terminate Python process:", error);
      }
      try {
        process.kill(this.pythonProcess.pid, "SIGKILL");
      } catch (error: any) {
        if (error?.code !== "ESRCH") {
          console.warn("Failed to force-kill Python process:", error);
        }
      }
      this.pythonProcess = null;
    }
  }

  async connectWithRetry(
    retries: number = 10,
    outerResolve: () => void,
  ): Promise<void> {
    if (!this.deviceEnabled) {
      outerResolve();
      return;
    }
    await new Promise((resolve, reject) => {
      const attemptConnection = (attempt: number) => {
        this.connect()
          .then(() => {
            resolve(true);
          })
          .catch((err) => {
            if (attempt < retries) {
              console.log(`Connection attempt ${attempt} failed, retrying...`);
              setTimeout(() => attemptConnection(attempt + 1), 5000);
            } else {
              console.error("Failed to connect after multiple attempts:", err);
              reject(err);
            }
          });
      };
      attemptConnection(1);
    });
    outerResolve();
  }

  async connect(): Promise<void> {
    console.log("Connecting to local display socket...");
    return new Promise<void>((resolve, reject) => {
      // 销毁原来的this.client
      if (this.client) {
        this.client.destroy();
      }
      this.client = new Socket();
      this.client.connect(12345, "0.0.0.0", () => {
        console.log("Connected to local display socket");
        this.receiveBuffer = "";
        this.sendToDisplay(JSON.stringify(this.currentStatus));
        resolve();
      });
      this.client.on("data", (data: Buffer) => {
        this.receiveBuffer += data.toString();
        while (this.receiveBuffer.includes("\n")) {
          const newlineIndex = this.receiveBuffer.indexOf("\n");
          const line = this.receiveBuffer.slice(0, newlineIndex).trim();
          this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);
          if (!line || line === "OK") {
            continue;
          }
          console.log(
            `[${getCurrentTimeTag()}] Received data from Whisplay hat:`,
            line,
          );
          try {
            const json = JSON.parse(line);
            if (json.event === "button_pressed") {
              this.handleButtonPressedEvent();
            }
            if (json.event === "button_released") {
              this.handleButtonReleasedEvent();
            }
            if (json.event === "camera_capture") {
              this.handleCameraCaptureEvent();
            }
            if (json.event === "exit_camera_mode") {
              this.display({ camera_mode: false });
            }
            if (json.event === "app_exit_requested") {
              console.log("[WhisplayApp] Exit requested by daemon");
              cleanup();
              process.exit(0);
            }
          } catch {
            // ignore invalid non-json lines
          }
        }
      });
      this.client.on("error", (err: any) => {
        // 如果是ECONNREFUSED
        if (err.code === "ECONNREFUSED") {
          reject(err);
        }
      });
    });
  }

  onButtonPressed(callback: () => void): void {
    this.buttonPressedCallback = callback;
  }

  onButtonReleased(callback: () => void): void {
    this.buttonReleasedCallback = callback;
  }

  onButtonDoubleClick(callback: (() => void) | null): void {
    this.buttonDoubleClickCallback = callback || null;
  }

  onCameraCapture(callback: () => void): void {
    this.onCameraCaptureCallback = callback;
  }

  onTextInput(callback: (text: string) => void): void {
    this.textInputCallback = callback;
  }

  private async sendToDisplay(data: string): Promise<void> {
    if (!this.deviceEnabled) {
      return;
    }
    await this.isReady;
    try {
      this.client?.write(`${data}\n`, "utf8", () => {
        // console.log("send", data);
      });
    } catch (error) {
      console.error("Failed to update display.");
    }
  }

  getCurrentStatus(): Status {
    return this.currentStatus;
  }

  private stopTextCounter(): void {
    if (this.textCounterTimer) {
      clearInterval(this.textCounterTimer);
      this.textCounterTimer = null;
    }
    this.textCounterTemplate = null;
    this.textCounterStartAt = 0;
  }

  private startTextCounter(template: string): void {
    this.stopTextCounter();
    this.textCounterTemplate = template;
    this.textCounterStartAt = Date.now();
    this.textCounterTimer = setInterval(() => {
      if (!this.textCounterTemplate) {
        this.stopTextCounter();
        return;
      }
      const elapsedSec = Math.floor((Date.now() - this.textCounterStartAt) / 1000);
      const renderedText = this.textCounterTemplate.replace(
        /\{count\}/g,
        `${elapsedSec}`,
      );
      if (this.currentStatus.text === renderedText) {
        return;
      }
      this.currentStatus.text = renderedText;
      const data = JSON.stringify({ text: renderedText, brightness: 100 });
      this.sendToDisplay(data);
      this.webDisplay?.updateStatus(this.currentStatus);
    }, 1000);
  }

  async display(newStatus: Partial<Status> = {}): Promise<void> {
    const previousText = this.currentStatus.text || "";
    const hasTextOverride = Object.prototype.hasOwnProperty.call(
      newStatus,
      "text",
    );
    const normalizedStatus: Partial<Status> = { ...newStatus };
    if (hasTextOverride) {
      const incomingText = `${newStatus.text ?? ""}`;
      if (incomingText.includes("{count}")) {
        this.startTextCounter(incomingText);
        const initialText = incomingText.replace(/\{count\}/g, "0");
        normalizedStatus.text = initialText;
      } else {
        this.stopTextCounter();
      }
    }

    const {
      status,
      emoji,
      text,
      terminal_text,
      tool_placeholders,
      text_input_enabled,
      RGB,
      brightness,
      scroll_sync,
      battery_level,
      battery_color,
      image,
      camera_mode,
      camera_capture,
      capture_image_path,
      wifi_signal_level,
      vpn_connected,
      rag_icon_visible,
      image_icon_visible,
      music_progress,
      music_duration_ms,
      approval_mode,
      model_ui,
      model_ui_title,
      model_ui_label,
      model_ui_description,
      model_ui_percent,
      model_ui_index,
      model_ui_total,
      model_ui_active,
      model_ui_qr_path,
      help_ui,
      help_ui_body,
      help_ui_page,
      help_ui_total,
      radar_ui,
      radar_ui_points,
      radar_ui_count,
      radar_ui_channel,
      top_bar_mode,
    } = {
      ...this.currentStatus,
      ...normalizedStatus,
    };

    const changedValues = Object.entries(normalizedStatus).filter(
      ([key, value]) => (this.currentStatus as any)[key] !== value,
    );

    const isTextChanged = changedValues.some(([key]) => key === "text");

    this.currentStatus.status = status;
    this.currentStatus.emoji = emoji;
    this.currentStatus.text = text;
    this.currentStatus.terminal_text = terminal_text;
    this.currentStatus.tool_placeholders = tool_placeholders;
    this.currentStatus.text_input_enabled = text_input_enabled;
    this.currentStatus.RGB = RGB;
    this.currentStatus.brightness = brightness;
    this.currentStatus.scroll_sync = scroll_sync;
    this.currentStatus.battery_level = battery_level;
    this.currentStatus.battery_color = battery_color;
    this.currentStatus.image = image;
    this.currentStatus.camera_mode = camera_mode;
    this.currentStatus.capture_image_path = capture_image_path;
    this.currentStatus.wifi_signal_level = wifi_signal_level;
    this.currentStatus.vpn_connected = vpn_connected;
    this.currentStatus.rag_icon_visible = rag_icon_visible;
    this.currentStatus.image_icon_visible = image_icon_visible;
    this.currentStatus.music_progress = music_progress;
    this.currentStatus.music_duration_ms = music_duration_ms;
    this.currentStatus.approval_mode = approval_mode;
    this.currentStatus.model_ui = model_ui;
    this.currentStatus.model_ui_title = model_ui_title;
    this.currentStatus.model_ui_label = model_ui_label;
    this.currentStatus.model_ui_description = model_ui_description;
    this.currentStatus.model_ui_percent = model_ui_percent;
    this.currentStatus.model_ui_index = model_ui_index;
    this.currentStatus.model_ui_total = model_ui_total;
    this.currentStatus.model_ui_active = model_ui_active;
    this.currentStatus.model_ui_qr_path = model_ui_qr_path;
    this.currentStatus.help_ui = help_ui;
    this.currentStatus.help_ui_body = help_ui_body;
    this.currentStatus.help_ui_page = help_ui_page;
    this.currentStatus.help_ui_total = help_ui_total;
    this.currentStatus.radar_ui = radar_ui;
    this.currentStatus.radar_ui_points = radar_ui_points;
    this.currentStatus.radar_ui_count = radar_ui_count;
    this.currentStatus.radar_ui_channel = radar_ui_channel;
    this.currentStatus.top_bar_mode = top_bar_mode;

    const changedValuesObj = Object.fromEntries(changedValues);
    changedValuesObj.brightness = 100;
    if (
      isTextChanged &&
      typeof changedValuesObj.text === "string" &&
      changedValuesObj.text.startsWith(previousText)
    ) {
      changedValuesObj.text_delta = changedValuesObj.text.slice(previousText.length);
      delete changedValuesObj.text;
    }
    const data = JSON.stringify(changedValuesObj);
    if (isTextChanged) {
      console.log("send data:", formatDisplayPayloadForLog(changedValuesObj));
    }

    if (normalizedStatus.camera_capture) {
      const capturePath = normalizedStatus.capture_image_path || this.currentStatus.capture_image_path;
      if (capturePath) {
        const webCamEnabled = parseBoolEnv("WEB_CAMERA_ENABLED", false);
        if (webCamEnabled && webAudioBridge.isCameraAvailable()) {
          // Request capture from browser camera regardless of physical device state.
          webAudioBridge
            .requestCameraCapture(capturePath)
            .then(() => this.handleCameraCaptureEvent())
            .catch((e) =>
              console.error("[WebCamera] Capture failed:", e),
            );
        } else if (!this.deviceEnabled) {
          // No physical hardware and no web camera: use the Pi camera daemon.
          this.sendCameraDaemonCommand("capture", { path: capturePath });
          this.handleCameraCaptureEvent();
        }
        // When deviceEnabled=true and no web camera: chatbot-ui.py handles the capture.
      }
    }

    this.sendToDisplay(data);
    this.webDisplay?.updateStatus(this.currentStatus);
  }

  private handleButtonPressedEvent(): void {
    this.buttonDown = true;
    this.buttonPressTimeArray.push(Date.now());
    console.log("emit pressed");
    this.buttonPressedCallback();
  }

  private handleButtonReleasedEvent(): void {
    this.buttonDown = false;
    this.buttonReleaseTimeArray.push(Date.now());
    console.log("emit released");
    this.buttonReleasedCallback();
    this.maybeEmitDoubleClick();
  }

  isButtonDown(): boolean {
    return this.buttonDown;
  }

  private handleCameraCaptureEvent(): void {
    this.onCameraCaptureCallback();
  }

  private handleTextInputEvent(text: string): void {
    this.textInputCallback(text);
  }

  stopWebDisplay(): void {
    this.webDisplay?.close();
    this.webDisplay = null;
  }

  private ensureCameraDaemon(): void {
    const command = `cd ${resolve(
      __dirname,
      "../../python",
    )} && python3 camera.py --ensure-daemon`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.warn("[CameraDaemon] ensure failed:", error.message);
        return;
      }
      if (stdout?.trim()) {
        console.log(stdout.trim());
      }
      if (stderr?.trim()) {
        console.warn(stderr.trim());
      }
    });
  }

  private sendCameraDaemonCommand(
    cmd: string,
    payload: Record<string, unknown> = {},
  ): void {
    const port = parseInt(process.env.WHISPLAY_CAMERA_DAEMON_PORT || "18765", 10);
    const socket = new Socket();
    socket.setTimeout(1000);
    socket.connect(port, "127.0.0.1", () => {
      socket.write(`${JSON.stringify({ cmd, ...payload })}\n`);
      socket.end();
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("timeout", () => {
      socket.destroy();
    });
  }
}

// Create a singleton instance to maintain backward compatibility
const displayInstance = new WhisplayDisplay();

export const display = displayInstance.display.bind(displayInstance);
export const getCurrentStatus =
  displayInstance.getCurrentStatus.bind(displayInstance);
export const onButtonPressed =
  displayInstance.onButtonPressed.bind(displayInstance);
export const onButtonReleased =
  displayInstance.onButtonReleased.bind(displayInstance);
export const onButtonDoubleClick =
  displayInstance.onButtonDoubleClick.bind(displayInstance);
export const onCameraCapture =
  displayInstance.onCameraCapture.bind(displayInstance);
export const onTextInput =
  displayInstance.onTextInput.bind(displayInstance);
export const isButtonDown =
  displayInstance.isButtonDown.bind(displayInstance);

// Other modules with their own teardown needs (WifiRadarService restoring
// the AR9271 out of monitor mode, killing its capture process — see
// wifiradar/service.ts / device/web-admin-server.ts) register here instead
// of adding their own competing SIGINT/SIGTERM listeners: process.exit()
// inside the *first* listener for a given signal stops Node from calling
// any listener registered after it, so this is the one place that gets to
// run async cleanup before the process actually exits.
type ShutdownHook = () => void | Promise<void>;
const shutdownHooks: ShutdownHook[] = [];
export function registerShutdownHook(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

const SHUTDOWN_HOOK_TIMEOUT_MS = 2000;

async function runShutdownHooks(): Promise<void> {
  await Promise.all(
    shutdownHooks.map((hook) =>
      Promise.race([
        Promise.resolve().then(hook),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_HOOK_TIMEOUT_MS)),
      ]).catch((err) => console.warn("[Shutdown] hook failed:", err)),
    ),
  );
}

async function cleanup(): Promise<void> {
  console.log("Cleaning up display process before exit...");
  displayInstance.killPythonProcess();
  displayInstance.stopWebDisplay();
  await runShutdownHooks();
}

// KillMode=control-group in the systemd unit delivers SIGTERM to every
// process in the service's cgroup — in practice this process ends up
// seeing more than one SIGTERM in quick succession while shutting down.
// Without a re-entrancy guard, a *second* signal arriving mid-cleanup
// would start a completely independent second call to shutdown() — and
// since a shutdown hook can clear its own "still working" state (e.g.
// WifiRadarService nulling monitorIface) before its own async work
// actually finishes, that second call can reach process.exit() *first*
// and kill the process out from under the original call's in-flight
// cleanup. Confirmed the hard way: WIFIRADAR's monitor-mode restore was
// getting cut off mid-flight this way, leaving the AR9271 stuck in
// monitor mode after every stop. One shared promise means every signal
// after the first just waits on the same in-flight shutdown instead of
// racing it.
let shutdownPromise: Promise<void> | null = null;
function shutdown(exitCode: number): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = cleanup().then(() => process.exit(exitCode));
  }
  return shutdownPromise;
}

// Last-resort safety net for any exit path that skips shutdown() above
// (which already calls these once, before its own process.exit()) — a
// plain 'exit' listener can't do async work, the event loop is already
// stopping. Wrapped defensively: an exception thrown inside an 'exit'
// listener can never be caught by anything (confirmed the hard way — an
// ESRCH from a redundant kill on an already-gone process crashed the app
// hard right here, with no way for the outer signal handlers to recover).
process.on("exit", () => {
  try {
    displayInstance.killPythonProcess();
    displayInstance.stopWebDisplay();
  } catch (err) {
    console.warn("[Shutdown] exit handler failed:", err);
  }
});
["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    console.log(`Received ${signal}, exiting...`);
    void shutdown(0);
  });
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  void shutdown(1);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  void shutdown(1);
});
process.on("keyboardInterrupt", () => {
  console.log("Keyboard Interrupt received, killing Python process...");
  cleanup();
  process.exit(0);
});

function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) {
    return defaultValue;
  }
  return raw.toLowerCase() === "true" || raw === "1";
}

function formatDisplayPayloadForLog(payload: Record<string, any>): string {
  const logPayload = { ...payload };

  if (typeof logPayload.text_delta === "string") {
    logPayload.deltaText = summarizeLogText(logPayload.text_delta);
    delete logPayload.text_delta;
  }

  if (typeof logPayload.text === "string") {
    logPayload.textPreview = summarizeLogText(logPayload.text);
    logPayload.textLength = logPayload.text.length;
    delete logPayload.text;
  }

  return JSON.stringify(logPayload);
}

function summarizeLogText(text: string, maxChars = 80): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... (${text.length} chars)`;
}
