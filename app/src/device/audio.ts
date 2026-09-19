import { spawn, ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { isEmpty, noop, set } from "lodash";
import dotenv from "dotenv";
import { ttsServer, asrServer } from "../cloud-api/server";
import { pluginRegistry } from "../plugin";
import type { ASRPlugin, TTSPlugin, AudioFormat } from "../plugin";
import { ASRServer, TTSResult, TTSServer } from "../type";
import { webAudioBridge } from "./web-audio-bridge";
import { getAudioOutputTarget } from "../config/audio-output";

export { getDynamicVoiceDetectLevel } from "./voice-detect";

dotenv.config();

const detectWhisplaySoundCardRef = (): string | undefined => {
  try {
    const cards = readFileSync("/proc/asound/cards", "utf8");
    const line = cards
      .split("\n")
      .find((item) => /whisplaysound|wm8960soundcard|es8389soundcard/i.test(item));
    const nameMatch = line?.match(/\[([^\]]+)\]/);
    if (nameMatch?.[1]) {
      return nameMatch[1].trim();
    }
    const indexMatch = line?.match(/^\s*(\d+)\s+\[/);
    return indexMatch?.[1];
  } catch (e) {
    return undefined;
  }
};

const soundCardRef =
  process.env.SOUND_CARD_NAME ||
  process.env.SOUND_CARD_INDEX ||
  detectWhisplaySoundCardRef();
const defaultAlsaInputDevice = soundCardRef ? `hw:${soundCardRef},0` : "default";
const defaultAlsaOutputDevice = soundCardRef === "whisplaysound"
  ? "playback"
  : soundCardRef
    ? `plughw:${soundCardRef},0`
    : "default";
const alsaInputDevice = process.env.ALSA_INPUT_DEVICE || defaultAlsaInputDevice;
// ALSA PCM used to reach a Bluetooth speaker: the "pulse" plugin talks to
// pipewire-pulse (already running for the desktop session), which in turn
// plays through PipeWire's current default sink — the paired/connected
// Bluetooth device once selected. No pipewire-alsa package is installed on
// this image, so there's no direct ALSA "pipewire" PCM to target instead.
const BLUETOOTH_ALSA_OUTPUT_DEVICE = "pulse";
// ALSA_OUTPUT_DEVICE, when set, is an explicit escape hatch that always wins
// (e.g. a custom hw:/plughw: device) — it bypasses the HAT/Bluetooth toggle
// below entirely. Otherwise the live getAlsaOutputDevice() below decides
// between the two based on the on-screen/web-admin selection
// (config/audio-output.ts), so switching speakers doesn't need a restart.
const getAlsaOutputDevice = (): string => {
  if (process.env.ALSA_OUTPUT_DEVICE) {
    return process.env.ALSA_OUTPUT_DEVICE;
  }
  return getAudioOutputTarget() === "bluetooth"
    ? BLUETOOTH_ALSA_OUTPUT_DEVICE
    : defaultAlsaOutputDevice;
};
const normalizeAudioFormat = (value: string | undefined, fallback: AudioFormat): AudioFormat => {
  const normalized = (value || "").toLowerCase();
  return normalized === "wav" || normalized === "mp3" ? normalized : fallback;
};

const defaultTtsAudioFormat: AudioFormat = [TTSServer.gemini, TTSServer.piper].includes(ttsServer)
  ? "wav"
  : "mp3";

const selectedTtsPlugin = pluginRegistry.getPlugin("tts", ttsServer) as TTSPlugin | undefined;
const ttsAudioFormat: AudioFormat = normalizeAudioFormat(
  selectedTtsPlugin?.audioFormat,
  defaultTtsAudioFormat,
);

const useWavPlayer = ttsAudioFormat === "wav";
const MP3_SOX_GAIN_DB = "2";

const defaultAsrAudioFormat: AudioFormat = [
  ASRServer.vosk,
  ASRServer.whisper,
  ASRServer.whisperhttp,
  ASRServer.fasterwhisper,
  ASRServer.llm8850whisper,
].includes(asrServer)
  ? "wav"
  : "mp3";

const selectedAsrPlugin = pluginRegistry.getPlugin("asr", asrServer) as ASRPlugin | undefined;

export const recordFileFormat: AudioFormat = normalizeAudioFormat(
  selectedAsrPlugin?.audioFormat,
  defaultAsrAudioFormat,
);

function startPlayerProcess() {
  return null;
}

let recordingProcessList: ChildProcess[] = [];
let currentRecordingReject: (reason?: any) => void = noop;

const removeRecordingProcess = (child: ChildProcess): void => {
  recordingProcessList = recordingProcessList.filter((item) => item !== child);
};

const RECORDING_KILL_GRACE_MS = 1000;

const killRecordingProcess = (child: ChildProcess): void => {
  console.log("Killing recording process", child.pid);
  try {
    child.kill("SIGINT");
  } catch (e) { }
  // SIGINT normally makes sox finish the WAV header and exit, but it's been
  // observed to leave sox stuck holding the ALSA capture device (confirmed
  // via /proc/asound/.../status still RUNNING minutes later) — every
  // subsequent recording then fails instantly (device busy) with no visible
  // error, which looks like the button doing nothing. Force it after a short
  // grace period if it's still alive.
  const pid = child.pid;
  setTimeout(() => {
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    console.warn(`[Audio] Recording process ${pid} didn't exit after SIGINT, sending SIGKILL`);
    try {
      child.kill("SIGKILL");
    } catch (e) { }
  }, RECORDING_KILL_GRACE_MS);
  removeRecordingProcess(child);
};

const killAllRecordingProcesses = (): void => {
  recordingProcessList.forEach((child) => {
    killRecordingProcess(child);
  });
  recordingProcessList.length = 0;
};

export const playWakeupChime = (): Promise<void> => {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      resolve();
    };

    //     play -n \
    // synth 0.10 sine 720 vol 0.4 : \
    // synth 0.12 sine 980 vol 0.35 : \
    // synth 0.14 sine 1320 vol 0.3 \
    // fade q 0.02 0.30 0.08 gain -30

    const chimeProcess = spawn("sox", [
      "-q",
      "-n",
      "-t",
      "alsa",
      getAlsaOutputDevice(),
      "synth",
      "0.10",
      "sine",
      "720",
      "vol",
      "0.4",
      ":",
      "synth",
      "0.12",
      "sine",
      "980",
      "vol",
      "0.35",
      ":",
      "synth",
      "0.14",
      "sine",
      "1320",
      "vol",
      "0.3",
      "fade",
      "q",
      "0.02",
      "0.30",
      "0.08",
      "gain",
      "-30",
    ]);

    chimeProcess.on("error", done);
    chimeProcess.on("exit", done);

    setTimeout(done, 1500);
  });
};

const recordAudio = async (
  outputPath: string,
  duration: number = 10,
  voiceDetectLevel: number = 30,
): Promise<string> => {
  // Delegate to browser microphone when web audio is enabled and a client is connected.
  if (webAudioBridge.isAvailable()) {
    console.log(`[WebAudio] Starting browser recording, max ${duration} seconds...`);
    return webAudioBridge.startRecording(outputPath, duration);
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-t",
      "alsa",
      alsaInputDevice,
      "-t",
      recordFileFormat,
      "-c",
      "1",
      "-r",
      "16000",
      outputPath,
      "silence",
      "1",
      "0.1",
      `${voiceDetectLevel}%`,
      "1",
      "0.7",
      `${voiceDetectLevel}%`,
    ];
    console.log(`Starting recording, maximum ${duration} seconds...`);
    currentRecordingReject = reject;
    const recordingProcess = spawn("sox", args);

    recordingProcess.on("error", (err) => {
      killAllRecordingProcesses();
      reject(err);
    });

    recordingProcess.stdout?.on("data", (data) => {
      console.log(data.toString());
    });
    recordingProcess.stderr?.on("data", (data) => {
      console.error(data.toString());
    });

    recordingProcess.on("exit", (code) => {
      removeRecordingProcess(recordingProcess);
      if (code && code !== 0) {
        reject(code);
        return;
      }
      resolve(outputPath);
    });
    recordingProcessList.push(recordingProcess);

    // Set a timeout to kill the recording process after the specified duration
    setTimeout(() => {
      if (recordingProcessList.includes(recordingProcess)) {
        killRecordingProcess(recordingProcess);
        resolve(outputPath);
      }
    }, duration * 1000);
  });
};

const recordAudioManually = (
  outputPath: string
): { result: Promise<string>; stop: () => void } => {
  // Delegate to browser microphone when web audio is enabled and a client is connected.
  if (webAudioBridge.isAvailable()) {
    console.log(`[WebAudio] Starting manual browser recording...`);
    return webAudioBridge.startManualRecording(outputPath);
  }

  let stopFunc: () => void = noop;
  const result = new Promise<string>((resolve, reject) => {
    currentRecordingReject = reject;
    const recordingProcess = spawn("sox", [
      "-t",
      "alsa",
      alsaInputDevice,
      "-t",
      recordFileFormat,
      "-c",
      "1",
      "-r",
      "16000",
      outputPath,
    ]);

    recordingProcess.on("error", (err) => {
      removeRecordingProcess(recordingProcess);
      reject(err);
    });

    recordingProcess.stderr?.on("data", (data) => {
      console.error(data.toString());
    });
    recordingProcessList.push(recordingProcess);
    stopFunc = () => {
      killRecordingProcess(recordingProcess);
    };
    recordingProcess.on("exit", (code, signal) => {
      removeRecordingProcess(recordingProcess);
      // A signal (SIGINT/SIGKILL from stop()/killRecordingProcess above) or
      // a clean 0 is the normal "button released, recording done" path.
      // Anything else means sox failed right after spawning — most often the
      // ALSA device was still busy from a previous recording that didn't
      // actually exit — and outputPath is empty/invalid, so surface it as a
      // real error instead of silently "succeeding" with a bad file (that
      // used to just look like the button doing nothing).
      if (signal || code === 0 || code === null) {
        resolve(outputPath);
      } else {
        reject(new Error(`sox exited with code ${code}`));
      }
    });
  });
  return {
    result,
    stop: stopFunc,
  };
};

const stopRecording = (): void => {
  // Also stop any in-progress web recording.
  webAudioBridge.stopRecording();

  if (!isEmpty(recordingProcessList)) {
    killAllRecordingProcesses();
    try {
      currentRecordingReject();
    } catch (e) { }
    console.log("Recording stopped");
  } else {
    console.log("No recording process running");
  }
};

interface Player {
  isPlaying: boolean;
  process: ChildProcess | null;
}

const player: Player = {
  isPlaying: false,
  process: null,
};

setTimeout(() => {
  player.process = startPlayerProcess();
}, 5000);

const playAudioData = (params: TTSResult): Promise<void> => {
  // Delegate to browser speaker when web audio is enabled and a client is connected.
  if (webAudioBridge.isAvailable()) {
    console.log("[WebAudio] Sending audio to browser for playback.");
    return webAudioBridge.playAudioData(params, ttsAudioFormat);
  }

  const { duration: audioDuration, filePath, base64, buffer } = params;
  if (audioDuration <= 0 || (!filePath && !base64 && !buffer)) {
    console.log("No audio data to play, skipping playback.");
    return Promise.resolve();
  }
  // play wav file using aplay
  if (filePath) {
    return Promise.race([
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, audioDuration + 1000);
      }),
      new Promise<void>((resolve, reject) => {
        console.log("Playback duration:", audioDuration);
        player.isPlaying = true;
        const process = spawn("sox", ["-q", filePath, "-t", "alsa", getAlsaOutputDevice()]);
        process.on("close", (code: number) => {
          player.isPlaying = false;
          if (code !== 0) {
            console.error(`Audio playback error: ${code}`);
            reject(code);
          } else {
            console.log("Audio playback completed");
            resolve();
          }
        });
      }),
    ]).catch((error) => {
      console.error("Audio playback error:", error);
    });
  }

  // play wav/mp3 buffer based on configured TTS format
  return new Promise((resolve, reject) => {
    const audioBuffer = base64 ? Buffer.from(base64, "base64") : buffer;
    console.log("Playback duration:", audioDuration);
    player.isPlaying = true;

    if (ttsAudioFormat === "wav") {
      const process = spawn("sox", [
        "-q",
        "-t",
        "wav",
        "-",
        "-t",
        "alsa",
        getAlsaOutputDevice(),
      ]);
      player.process = process;
      process.stdin?.on("error", (err) => {
        console.error("Sox stdin error:", err.message);
      });
      let stderr = "";
      process.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      let settled = false;
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        player.isPlaying = false;
        if (player.process === process) {
          player.process = null;
        }
        process.kill();
        console.error("Audio playback timed out.");
        resolve();
      }, audioDuration + 2000);
      process.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        player.isPlaying = false;
        if (player.process === process) {
          player.process = null;
        }
        if (code !== 0) {
          console.error(`Audio playback error: ${code}`);
          if (stderr.trim()) {
            console.error(stderr.trim());
          }
          reject(code);
        } else {
          console.log("Audio playback completed");
          resolve();
        }
      });
      process.stdin?.end(audioBuffer);
      return;
    }

    const process = spawn("sox", [
      "-q",
      "-t",
      "mp3",
      "-",
      "-t",
      "alsa",
      getAlsaOutputDevice(),
      "gain",
      MP3_SOX_GAIN_DB,
    ]);
    player.process = process;
    process.stdin?.on("error", (err) => {
      console.error("Sox stdin error:", err.message);
    });
    let stderr = "";
    process.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      player.isPlaying = false;
      if (player.process === process) {
        player.process = null;
      }
      process.kill();
      console.error("Audio playback timed out.");
      resolve();
    }, audioDuration + 2000);
    process.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      player.isPlaying = false;
      if (player.process === process) {
        player.process = null;
      }
      if (code !== 0) {
        console.error(`Audio playback error: ${code}`);
        if (stderr.trim()) {
          console.error(stderr.trim());
        }
        reject(code);
      } else {
        console.log("Audio playback completed");
        resolve();
      }
    });
    process.stdin?.end(audioBuffer);
  });
};

const stopPlaying = (): void => {
  // Also stop any in-progress web playback.
  webAudioBridge.stopPlayback();

  if (player.isPlaying) {
    try {
      console.log("Stopping audio playback");
      const process = player.process;
      if (process) {
        process.stdin?.end();
        process.kill();
      }
    } catch { }
    player.isPlaying = false;
    // Recreate process
    setTimeout(() => {
      player.process = startPlayerProcess();
    }, 500);
  } else {
    console.log("No audio currently playing");
  }
};

// Close audio player when exiting program
process.on("SIGINT", () => {
  try {
    if (player.process) {
      player.process.stdin?.end();
      player.process.kill();
    }
  } catch { }
  process.exit();
});

/**
 * Kill the persistent TTS player process to free the ALSA device.
 * Resolves once the process has fully exited AND a post-exit settling
 * delay has elapsed so that ALSA fully releases the hardware.
 * Must be paired with restoreAudioPlayer() when done.
 */
const releaseAudioPlayer = (): Promise<void> => {
  const proc = player.process;
  player.process = null;
  player.isPlaying = false;

  if (!proc) {
    return Promise.resolve();
  }

  const waitForExit = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(resolve, 3000);

    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      proc.stdin?.end();
      proc.kill();
    } catch {}
  });

  // After process exit, wait for ALSA device to fully release
  return waitForExit.then(() => new Promise((r) => setTimeout(r, 500)));
};

/**
 * Recreate the persistent TTS player process after releaseAudioPlayer().
 */
const restoreAudioPlayer = (): void => {
  if (!player.process) {
    player.process = startPlayerProcess();
  }
};

export {
  recordAudio,
  recordAudioManually,
  stopRecording,
  playAudioData,
  stopPlaying,
  releaseAudioPlayer,
  restoreAudioPlayer,
};
