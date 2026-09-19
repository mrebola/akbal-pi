import { display } from "../../device/display";
import { getAudioOutputTarget, bluetoothTarget } from "../../config/audio-output";
import { listPairedSpeakers } from "../../device/bluetooth-audio";

// Button-driven speaker picker, entered from the quick menu (states.ts).
// Deliberately mirrors mode-select-mode.ts's press/hold/confirm timing so the
// on-device UX is consistent — the same "a misheard/short click should never
// silently flip where the assistant speaks" reasoning applies here.
export type AudioOutputOption = { key: string; label: string; description: string };

const HAT_OPTION: AudioOutputOption = {
  key: "hat",
  label: "Bocina de la Pi",
  description: "Altavoz del HAT Whisplay",
};

// Options are HAT + one entry per paired Bluetooth speaker, rebuilt each time
// the picker is opened so newly paired speakers show up automatically.
let options: AudioOutputOption[] = [HAT_OPTION];

const buildOptions = async (): Promise<AudioOutputOption[]> => {
  try {
    const speakers = await listPairedSpeakers();
    return [
      HAT_OPTION,
      ...speakers.map((sp) => ({
        key: bluetoothTarget(sp.mac),
        label: sp.name,
        description: sp.connected ? "Bluetooth · conectada" : "Bluetooth · emparejada",
      })),
    ];
  } catch {
    return [HAT_OPTION];
  }
};

const SHORT_PRESS_MAX_MS = 400;
// Matches mode-select-mode.ts / model-select-mode.ts / quick-menu-mode.ts.
const CONFIRM_HOLD_MS = 900;
const HOLD_TICK_MS = 60;
const IDLE_TIMEOUT_MS = 20000;

let selectedIndex = 0;
let pressStartedAt = 0;
let holdTicker: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let onConfirmCallback: (option: AudioOutputOption) => void = () => {};
let onTimeoutCallback: () => void = () => {};
let onCancelCallback: () => void = () => {};

function clearHoldTimers(): void {
  if (holdTicker) {
    clearInterval(holdTicker);
    holdTicker = null;
  }
  if (confirmTimer) {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => onTimeoutCallback(), IDLE_TIMEOUT_MS);
}

function currentOption(): AudioOutputOption {
  return options[selectedIndex] || HAT_OPTION;
}

function renderSelectScreen(): void {
  const option = currentOption();
  const isActive = getAudioOutputTarget() === option.key;
  display({
    status: "audio_output_select",
    model_ui: "select",
    model_ui_title: "AUDIO",
    model_ui_label: option.label,
    model_ui_description: option.description,
    model_ui_index: selectedIndex + 1,
    model_ui_total: options.length,
    model_ui_active: isActive,
    text: "Click: siguiente · Mantén: elegir",
  });
}

export function resetAudioOutputSelectControl(): void {
  clearHoldTimers();
  clearIdleTimer();
  pressStartedAt = 0;
}

export function onAudioOutputSelectConfirm(
  callback: (option: AudioOutputOption) => void,
): void {
  onConfirmCallback = callback;
}

export function onAudioOutputSelectTimeout(callback: () => void): void {
  onTimeoutCallback = callback;
}

export function onAudioOutputSelectCancel(callback: () => void): void {
  onCancelCallback = callback;
}

// Explicit "get me out of here" gesture, bound to a double click (see
// states.ts) — same as mode-select-mode.ts.
export function handleAudioOutputSelectCancel(): void {
  resetAudioOutputSelectControl();
  onCancelCallback();
}

export async function enterAudioOutputSelectMode(): Promise<void> {
  resetAudioOutputSelectControl();
  // Listing paired speakers shells out to bluetoothctl, so show a brief
  // placeholder while it runs.
  display({
    status: "audio_output_select",
    model_ui: "loading",
    model_ui_title: "AUDIO",
    model_ui_label: "Buscando bocinas...",
    model_ui_description: "",
    text: "",
  });
  options = await buildOptions();
  const activeKey = getAudioOutputTarget();
  const idx = options.findIndex((o) => o.key === activeKey);
  selectedIndex = idx >= 0 ? idx : 0;
  renderSelectScreen();
  armIdleTimer();
}

export function handleAudioOutputSelectPress(): void {
  clearIdleTimer();
  pressStartedAt = Date.now();
  holdTicker = setInterval(() => {
    const elapsed = Date.now() - pressStartedAt;
    const percent = Math.min(100, Math.round((elapsed / CONFIRM_HOLD_MS) * 100));
    display({
      status: "audio_output_select",
      model_ui: "confirm",
      model_ui_title: "AUDIO",
      model_ui_label: currentOption().label,
      model_ui_description: currentOption().description,
      model_ui_percent: percent,
      text: "Manteniendo presionado...",
    });
  }, HOLD_TICK_MS);
  confirmTimer = setTimeout(() => {
    clearHoldTimers();
    onConfirmCallback(currentOption());
  }, CONFIRM_HOLD_MS);
}

export function handleAudioOutputSelectRelease(): void {
  const duration = Date.now() - pressStartedAt;
  clearHoldTimers();
  pressStartedAt = 0;
  if (duration > 0 && duration <= SHORT_PRESS_MAX_MS) {
    selectedIndex = (selectedIndex + 1) % options.length;
  }
  renderSelectScreen();
  armIdleTimer();
}
