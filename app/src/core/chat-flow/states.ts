import moment from "moment";
import { compact, noop } from "lodash";
import {
  onButtonPressed,
  onButtonReleased,
  onButtonDoubleClick,
  display,
  getCurrentStatus,
  onCameraCapture,
  onTextInput,
  isButtonDown,
} from "../../device/display";
import {
  recordAudio,
  recordAudioManually,
  recordFileFormat,
  getDynamicVoiceDetectLevel,
} from "../../device/audio";
import { chatWithLLMStream } from "../../cloud-api/server";
import { summaryTextWithLLM } from "../../cloud-api/llm";
import { getSystemPromptWithKnowledge } from "../Knowledge";
import { enableRAG } from "../../cloud-api/knowledge";
import { cameraDir } from "../../utils/dir";
import {
  clearPendingCapturedImgForChat,
  getLatestGenImg,
  getLatestDisplayImg,
  setLatestCapturedImg,
  setPendingCapturedImgForChat,
} from "../../utils/image";
import { sendWhisplayIMMessage } from "../../cloud-api/whisplay-im/whisplay-im";
import { ChatFlowContext, FlowName, FlowStateHandler } from "./types";
import {
  enterCameraMode,
  handleCameraModePress,
  handleCameraModeRelease,
  onCameraModeExit,
  resetCameraModeControl,
} from "./camera-mode";
import { DEFAULT_EMOJI } from "../../utils";
import { matchVoiceCommand, handleVoiceCommand, aliasForTag } from "./voice-commands";
import {
  enterModelSelectMode,
  handleModelSelectCancel,
  handleModelSelectPress,
  handleModelSelectRelease,
  onModelSelectCancel,
  onModelSelectConfirm,
  onModelSelectTimeout,
} from "./model-select-mode";
import {
  enterModeSelectMode,
  handleModeSelectCancel,
  handleModeSelectPress,
  handleModeSelectRelease,
  onModeSelectCancel,
  onModeSelectConfirm,
  onModeSelectTimeout,
} from "./mode-select-mode";
import {
  enterAudioOutputSelectMode,
  handleAudioOutputSelectCancel,
  handleAudioOutputSelectPress,
  handleAudioOutputSelectRelease,
  onAudioOutputSelectCancel,
  onAudioOutputSelectConfirm,
  onAudioOutputSelectTimeout,
} from "./audio-output-select-mode";
import {
  enterHelpMode,
  handleHelpDoubleClick,
  handleHelpPress,
  handleHelpRelease,
  onHelpExit,
} from "./help-mode";
import {
  enterQuickMenuMode,
  handleQuickMenuCancel,
  handleQuickMenuPress,
  handleQuickMenuRelease,
  onQuickMenuCancel,
  onQuickMenuConfirm,
  onQuickMenuTimeout,
} from "./quick-menu-mode";
import {
  enterVolumeAdjustMode,
  handleVolumeAdjustDoubleClick,
  handleVolumeAdjustPress,
  handleVolumeAdjustRelease,
  onVolumeAdjustExit,
} from "./volume-adjust-mode";
import {
  enterWifiManagerMode,
  exitWifiManagerMode,
  handleWifiManagerCancel,
  handleWifiManagerPress,
  handleWifiManagerRelease,
  onWifiManagerDone,
} from "./wifi-manager-mode";
import {
  enterNetworkInfoMode,
  handleNetworkInfoDoubleClick,
  handleNetworkInfoPress,
  handleNetworkInfoRelease,
  onNetworkInfoExit,
} from "./network-info-mode";
import {
  enterWifiRadarMode,
  handleWifiRadarDoubleClick,
  handleWifiRadarPress,
  handleWifiRadarRelease,
  onWifiRadarExit,
} from "./wifi-radar-mode";
import { isAgentMode, setDeviceMode } from "../../config/device-mode";
import { setAudioOutputTarget } from "../../config/audio-output";
import { connectSpeaker } from "../../device/bluetooth-audio";
import { jukebox } from "../../device/music-jukebox";
import {
  DEFAULT_OLLAMA_MODEL,
  getCurrentModel,
  listOllamaModels,
  switchModel,
} from "../../cloud-api/local/ollama-llm";
import { isMusicPlaying, getCurrentTrackTitle, stopMusicPlayback, startPendingMusicPlayback, onMusicTrackChange, onMusicPlaybackEnd } from "../../device/music-player";
import { autoSaveExchange, prepareMemoryPrompt } from "../../config/local-memory";

// Shared "is this a click or a hold" threshold — used both for the sleep ->
// quick-menu/push-to-talk split below and for the speaking-state controls
// (registerSpeakingButtonControls), so the whole device has one consistent
// press/hold feel instead of a different number per screen.
const CLICK_MAX_MS = 400;

// "click → detener voz, mantener → interrumpir y hablar" while Akbal is
// thinking or speaking — shared by the local flow (runLocalAnswer, in
// "answer") and the external one ("external_answer"). A short click just
// silences whatever's playing/being awaited and returns to idle; holding
// past CLICK_MAX_MS interrupts and immediately starts push-to-talk (the
// button is still down when we hand off to "listening", same as the hold
// path out of "sleep").
function registerSpeakingButtonControls(
  ctx: ChatFlowContext,
  stop: () => void,
): void {
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let interrupted = false;
  onButtonDoubleClick(null);
  onButtonPressed(() => {
    interrupted = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      interrupted = true;
      stop();
      clearPendingCapturedImgForChat();
      display({ image_icon_visible: false });
      ctx.transitionTo("listening");
    }, CLICK_MAX_MS);
  });
  onButtonReleased(() => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (interrupted) return; // already handed off to "listening" above
    stop();
    clearPendingCapturedImgForChat();
    display({ image_icon_visible: false });
    ctx.transitionTo("sleep");
  });
}

export const flowStates: Record<FlowName, FlowStateHandler> = {
  sleep: (ctx: ChatFlowContext) => {
    resetCameraModeControl();
    onCameraModeExit(null);
    onButtonDoubleClick(null);
    // "click corto → menú rápido, mantener → push-to-talk": don't know
    // which one this press is until either it's released early (click) or
    // CLICK_MAX_MS passes while still held (hold) — see docs/display-ui.md.
    let heldPastThreshold = false;
    let pushToTalkTimer: ReturnType<typeof setTimeout> | null = null;
    onButtonPressed(() => {
      stopMusicPlayback();
      heldPastThreshold = false;
      pushToTalkTimer = setTimeout(() => {
        pushToTalkTimer = null;
        heldPastThreshold = true;
        ctx.transitionTo("listening");
      }, CLICK_MAX_MS);
    });
    onButtonReleased(() => {
      if (pushToTalkTimer) {
        clearTimeout(pushToTalkTimer);
        pushToTalkTimer = null;
      }
      if (heldPastThreshold) return; // already handed off to "listening" above
      ctx.transitionTo("quick_menu");
    });
    onTextInput((text: string) => {
      if (ctx.currentFlowName !== "sleep") return;
      ctx.answerId += 1;
      ctx.asrText = text;
      display({ status: "recognizing", text, text_input_enabled: false });
      ctx.transitionTo("answer");
    });
    display({
      status: "idle",
      emoji: "😴",
      RGB: "#000055",
      rag_icon_visible: false,
      // Always clear the menu-carousel/help/radar/wardrive overlay here,
      // since "sleep" is the common return point from every flow —
      // including the idle timeouts, which have no other cleanup step.
      // radar_ui/wardrive_ui in particular have to be cleared explicitly:
      // render_frame checks them independently of model_ui/help_ui, so
      // leaving either truthy would keep that screen stuck on top forever
      // after returning here.
      model_ui: "",
      model_ui_percent: 0,
      help_ui: "",
      radar_ui: "",
      wardrive_ui: "",
      top_bar_mode: isAgentMode() ? "agent" : "local",
      ...(getCurrentStatus().text.endsWith("Escuchando...") || !getCurrentStatus().text
        ? { text: "Click: menú · Mantén: hablar" }
        : {}),
    });
  },
  quick_menu: (ctx: ChatFlowContext) => {
    onQuickMenuConfirm((key) => {
      if (key === "model") {
        ctx.transitionTo("model_select");
        return;
      }
      if (key === "mode") {
        ctx.transitionTo("mode_select");
        return;
      }
      if (key === "audio_output") {
        ctx.transitionTo("audio_output_select");
        return;
      }
      if (key === "jukebox") {
        ctx.transitionTo("jukebox");
        return;
      }
      if (key === "help") {
        ctx.transitionTo("help");
        return;
      }
      if (key === "volume") {
        ctx.transitionTo("volume_adjust");
        return;
      }
      if (key === "wifi") {
        ctx.transitionTo("wifi_manager");
        return;
      }
      if (key === "network") {
        ctx.transitionTo("network_info");
        return;
      }
      if (key === "wifiradar") {
        ctx.transitionTo("wifi_radar");
        return;
      }
      const captureImgPath = `${cameraDir}/capture-${moment().format(
        "YYYYMMDD-HHmmss",
      )}.jpg`;
      enterCameraMode(captureImgPath);
      ctx.transitionTo("camera");
    });
    onQuickMenuTimeout(() => {
      if (ctx.currentFlowName === "quick_menu") ctx.transitionTo("sleep");
    });
    onQuickMenuCancel(() => {
      if (ctx.currentFlowName === "quick_menu") ctx.transitionTo("sleep");
    });
    onButtonDoubleClick(() => handleQuickMenuCancel());
    onButtonPressed(() => handleQuickMenuPress());
    onButtonReleased(() => handleQuickMenuRelease());
    enterQuickMenuMode(ctx.enableCamera);
  },
  camera: (ctx: ChatFlowContext) => {
    onButtonDoubleClick(null);
    onButtonPressed(() => {
      handleCameraModePress();
    });
    onButtonReleased(() => {
      handleCameraModeRelease();
    });
    onCameraCapture(() => {
      const captureImagePath = getCurrentStatus().capture_image_path;
      if (!captureImagePath) {
        return;
      }
      setLatestCapturedImg(captureImagePath);
      setPendingCapturedImgForChat(captureImagePath);
      display({ image_icon_visible: true });
    });
    onCameraModeExit(() => {
      if (ctx.currentFlowName === "camera") {
        ctx.transitionTo("sleep");
      }
    });
    display({
      status: "camera",
      emoji: "📷",
      RGB: "#00ff88",
    });
  },
  music: (ctx: ChatFlowContext) => {
    // Start deferred music playback when entering music state
    startPendingMusicPlayback();

    // Update display when track changes during continuous playback
    onMusicTrackChange((title) => {
      if (ctx.currentFlowName === "music") {
        display({ text: `Reproduciendo: ${title}` });
      }
    });

    // Return to sleep when non-continuous playback finishes
    onMusicPlaybackEnd(() => {
      if (ctx.currentFlowName === "music") {
        onMusicTrackChange(null);
        onMusicPlaybackEnd(null);
        ctx.transitionTo("sleep");
      }
    });

    onButtonDoubleClick(null);
    onButtonPressed(() => {
      // Stop music immediately when button is pressed
      onMusicTrackChange(null);
      onMusicPlaybackEnd(null);
      stopMusicPlayback();
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);

    const trackTitle = getCurrentTrackTitle();
    display({
      status: "music",
      emoji: "🎹",
      RGB: "#0066aa",
      text:
        ctx.musicDisplayText ||
        (isMusicPlaying() && trackTitle
          ? `Reproduciendo: ${trackTitle}`
          : "Modo música. Presiona el botón para hablar."),
      rag_icon_visible: false,
    });
  },
  jukebox: (ctx: ChatFlowContext) => {
    // Dedicated Cypher OST player mode. One-button controls:
    //   short click = play/pausa · doble click = siguiente · mantener = salir
    // The screen shows a big transport icon reflecting the action/state, the
    // track title and a progress bar (see render_music_screen in chatbot-ui.py).
    let pressAt = 0;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    const HOLD_EXIT_MS = 700; // a deliberate hold, vs a quick click
    const CONTROLS_HINT = "Clic: play/pausa · Doble: siguiente\nMantén: salir";
    // Briefly flash an action icon (e.g. "next") over the steady state icon.
    let flashIcon: string | null = null;
    let flashUntil = 0;

    const iconFor = (s: ReturnType<typeof jukebox.status>): string => {
      if (flashIcon && Date.now() < flashUntil) return flashIcon;
      if (!s.playing) return "play";
      return s.paused ? "pause" : "play";
    };

    const render = () => {
      const s = jukebox.status();
      display({
        status: "music",
        model_ui: "", // clear any leftover quick-menu card / loading spinner
        music_ui: "player",
        music_icon: iconFor(s),
        music_title: s.available ? s.title || "Música Cypher OST" : "Sin música",
        music_progress: s.durationMs > 0 ? s.positionMs / s.durationMs : -1,
        music_duration_ms: s.durationMs,
        text: CONTROLS_HINT,
        rag_icon_visible: false,
      });
    };

    const flash = (icon: string) => {
      flashIcon = icon;
      flashUntil = Date.now() + 1000;
      render();
    };

    const stopTimers = () => {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
    };

    const leave = () => {
      stopTimers();
      jukebox.setOnChange(null);
      jukebox.stop();
      display({ music_ui: "" }); // turn off the player screen
      ctx.transitionTo("sleep");
    };

    jukebox.setOnChange(() => {
      if (ctx.currentFlowName === "jukebox") render();
    });

    onButtonDoubleClick(() => {
      if (ctx.currentFlowName === "jukebox") {
        flash("next");
        void jukebox.next().then(render);
      }
    });
    onButtonPressed(() => {
      pressAt = Date.now();
    });
    onButtonReleased(() => {
      // Ignore the stray release from the quick-menu hold that entered this mode.
      if (!pressAt) return;
      const held = Date.now() - pressAt;
      pressAt = 0;
      if (held >= HOLD_EXIT_MS) {
        flash("exit");
        setTimeout(leave, 250);
      } else {
        void jukebox.playPause().then(render);
      }
    });

    if (!jukebox.isActive()) {
      void jukebox.play(0).then(render);
    } else {
      render();
    }
    progressTimer = setInterval(() => {
      if (ctx.currentFlowName === "jukebox") render();
      else stopTimers();
    }, 1000);
  },
  listening: (ctx: ChatFlowContext) => {
    ctx.enterMusicAfterAnswer = false;
    ctx.musicDisplayText = "";
    ctx.isFromWakeListening = false;
    ctx.answerId += 1;
    ctx.wakeSessionActive = false;
    ctx.endAfterAnswer = false;
    onButtonDoubleClick(null);
    ctx.currentRecordFilePath = `${ctx.recordingsDir
      }/user-${Date.now()}.${recordFileFormat}`;
    onButtonPressed(noop);
    const listeningStartedAt = Date.now();
    // If button was already released before we entered this state, go back to sleep
    if (!isButtonDown()) {
      console.log("[listening] Button already released, returning to sleep");
      ctx.transitionTo("sleep");
      return;
    }
    const { result, stop } = recordAudioManually(ctx.currentRecordFilePath);
    let shouldIgnoreRecordingResult = false;
    const handleRelease = () => {
      if (Date.now() - listeningStartedAt < 500) {
        // Too short to be meaningful — stop recording and return to sleep
        console.log("[listening] Button released too quickly, returning to sleep");
        shouldIgnoreRecordingResult = true;
        stop();
        ctx.transitionTo("sleep");
        return;
      }
      stop();
      display({
        RGB: "#ff6800",
        image: "",
      });
    };
    onButtonReleased(handleRelease);
    result
      .then(() => {
        if (shouldIgnoreRecordingResult) return;
        ctx.transitionTo("asr");
      })
      .catch((err) => {
        console.error("Error during recording:", err);
        ctx.transitionTo("sleep");
      });
    display({
      status: "listening",
      emoji: DEFAULT_EMOJI,
      RGB: "#00ff00",
      text: "Escuchando...",
      rag_icon_visible: false,
    });
  },
  wake_listening: (ctx: ChatFlowContext) => {
    ctx.enterMusicAfterAnswer = false;
    ctx.musicDisplayText = "";
    ctx.isFromWakeListening = true;
    ctx.answerId += 1;
    ctx.currentRecordFilePath = `${ctx.recordingsDir
      }/user-${Date.now()}.${recordFileFormat}`;
    onButtonPressed(() => {
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    display({
      status: "detecting",
      emoji: DEFAULT_EMOJI,
      RGB: "#00ff00",
      text: "Detectando nivel de voz...",
      rag_icon_visible: false,
    });
    getDynamicVoiceDetectLevel().then((level) => {
      display({
        status: "listening",
        emoji: DEFAULT_EMOJI,
        RGB: "#00ff00",
        text: `(Nivel detectado: ${level}%) Escuchando...`,
        rag_icon_visible: false,
      });
      recordAudio(ctx.currentRecordFilePath, ctx.wakeRecordMaxSec, level)
        .then(() => {
          ctx.transitionTo("asr");
        })
        .catch((err) => {
          console.error("Error during auto recording:", err);
          ctx.endWakeSession();
          ctx.transitionTo("sleep");
        });
    });
  },
  asr: (ctx: ChatFlowContext) => {
    display({
      status: "recognizing",
    });
    onButtonDoubleClick(null);
    Promise.race([
      ctx.recognizeAudio(ctx.currentRecordFilePath, ctx.isFromWakeListening),
      new Promise<string>((resolve) => {
        onButtonPressed(() => {
          resolve("[UserPress]");
        });
        onButtonReleased(noop);
      }),
    ]).then(async (result) => {
      if (ctx.currentFlowName !== "asr") return;
      if (result === "[UserPress]") {
        ctx.transitionTo("listening");
        return;
      }
      if (result) {
        console.log("Audio recognized result:", result);
        ctx.asrText = result;
        ctx.endAfterAnswer = ctx.shouldEndAfterAnswer(result);
        if (ctx.wakeSessionActive) {
          ctx.wakeSessionLastSpeechAt = Date.now();
        }
        display({ status: "recognizing", text: result });
        // Volume/model voice commands are handled directly here, without
        // going through the LLM — see voice-commands.ts for why.
        const voiceCommand = matchVoiceCommand(result);
        if (voiceCommand) {
          if (voiceCommand.type === "help_menu") {
            ctx.transitionTo("help");
            return;
          }
          if (voiceCommand.type === "volume") {
            const reply = await handleVoiceCommand(voiceCommand);
            if (ctx.currentFlowName !== "asr") return;
            ctx.pendingExternalReply = reply;
            ctx.transitionTo("external_answer");
            return;
          }
          if (voiceCommand.type === "model_switch") {
            ctx.pendingModelSwitchTag = voiceCommand.alias.tag;
            ctx.pendingModelSwitchLabel = voiceCommand.alias.label;
            ctx.transitionTo("model_loading");
            return;
          }
          if (voiceCommand.type === "model_current") {
            const activeTag = getCurrentModel();
            const label = aliasForTag(activeTag)?.label || activeTag;
            ctx.pendingExternalReply = `Estoy usando el ${label}.`;
            ctx.transitionTo("external_answer");
            return;
          }
          if (voiceCommand.type === "device_mode_menu") {
            ctx.pendingDeviceModeSwitch = voiceCommand.target || "";
            ctx.transitionTo("mode_select");
            return;
          }
          // "model_menu" (generic "cambia modelo") and "model_switch_failed"
          // (misheard model name) both open the visual, button-driven menu
          // instead of guessing — see model-select-mode.ts.
          ctx.transitionTo("model_select");
          return;
        }
        ctx.transitionTo("answer");
        return;
      }
      if (ctx.wakeSessionActive) {
        if (ctx.shouldContinueWakeSession()) {
          ctx.transitionTo("wake_listening");
        } else {
          ctx.endWakeSession();
          ctx.transitionTo("sleep");
        }
        return;
      }
      ctx.transitionTo("sleep");
    });
  },
  answer: (ctx: ChatFlowContext) => {
    ctx.enterMusicAfterAnswer = false;
    ctx.musicDisplayText = "";
    ctx.resetToolCallDisplay();
    ctx.answerDisplayText = "";
    // "Pensando" (local) and "Agente" (waiting on OpenClaw) look and sound
    // the same as each other today — different caption + accent so it's
    // clear at a glance which one's actually answering (see states.ts
    // fallbackToLocal for when this can silently change mid-turn).
    display(
      isAgentMode()
        ? { status: "agente...", emoji: "🌐", RGB: "#7a5cff", text: "Agente pensando..." }
        : { status: "answering...", emoji: DEFAULT_EMOJI, RGB: "#00c8a3", text: "Pensando..." },
    );
    const currentAnswerId = ctx.answerId;

    // Local model turn — used directly in "modo local", and as the fallback
    // when "modo agente" doesn't hear back from OpenClaw in time (see below).
    const runLocalAnswer = (): void => {
      const {
        partial,
        endPartial,
        getPlayEndPromise,
        stop: stopPlaying,
      } = ctx.streamResponser;
      registerSpeakingButtonControls(ctx, stopPlaying);
      let llmResponseText = "";
      const isCurrentAnswer = (): boolean =>
        currentAnswerId === ctx.answerId && ctx.currentFlowName === "answer";
      const trackingPartial = (text: string): void => {
        if (!isCurrentAnswer()) return;
        llmResponseText += text;
        partial(text);
        ctx.updateAnswerDisplayText(llmResponseText);
      };
      let resolveLlmDone: () => void = () => {};
      const llmDonePromise = new Promise<void>((resolve) => {
        resolveLlmDone = resolve;
      });
      ctx.partialThinking = "";
      ctx.thinkingSentences = [];
      Promise.all([
        [() => Promise.resolve().then(() => ""), getSystemPromptWithKnowledge]
        [enableRAG ? 1 : 0](ctx.asrText),
        Promise.resolve().then(() => prepareMemoryPrompt(ctx.asrText)),
      ])
        .then(([res, memoryPrompt]: [string, string]) => {
          let knowledgePrompt = res;
          if (res) {
            console.log("Retrieved knowledge for RAG:\n", res);
          }
          if (ctx.knowledgePrompts.includes(res)) {
            console.log(
              "[RAG] Knowledge prompt already used in this session, skipping to avoid repetition.",
            );
            knowledgePrompt = "";
          }
          if (knowledgePrompt) {
            ctx.knowledgePrompts.push(knowledgePrompt);
          }
          display({
            rag_icon_visible: Boolean(enableRAG && knowledgePrompt),
          });
          const prompt: {
            role: "system" | "user";
            content: string;
          }[] = compact([
            memoryPrompt
              ? {
                role: "system",
                content: memoryPrompt,
              }
              : null,
            knowledgePrompt
              ? {
                role: "system",
                content: knowledgePrompt,
              }
              : null,
            {
              role: "user",
              content: ctx.asrText,
            },
          ]);
          chatWithLLMStream(
            prompt,
            trackingPartial,
            () => {
              if (isCurrentAnswer()) {
                endPartial();
              }
              resolveLlmDone();
            },
            (partialThinking) =>
              isCurrentAnswer() &&
              ctx.partialThinkingCallback(partialThinking),
            (functionName: string, result?: string) => {
              if (!isCurrentAnswer()) return;
              if (
                functionName === "endConversation" &&
                result?.startsWith("[success]")
              ) {
                ctx.endAfterAnswer = true;
              }
              if (
                functionName === "generateImage" &&
                result?.startsWith("[success]")
              ) {
                const img = getLatestGenImg();
                if (img) {
                  display({ image: img });
                }
              }
              if (
                functionName.startsWith("playMusic") &&
                result?.startsWith("[success]")
              ) {
                ctx.enterMusicAfterAnswer = true;
                ctx.musicDisplayText = result.replace(/^\[success\]/, "").trim();
              }
              if (!result) {
                ctx.appendToolCallDisplay(functionName);
              } else if (
                functionName === "runCommand" &&
                result.startsWith("[success] status=running")
              ) {
                const jobId = result.match(/\bjob_id=([^\s]+)/)?.[1];
                if (jobId) {
                  ctx.keepCommandToolDisplayRunning(jobId);
                } else {
                  ctx.finishToolCallDisplay(functionName);
                }
              } else if (
                result.includes("status=completed")
              ) {
                const jobId = result.match(/\bjob_id=([^\s]+)/)?.[1];
                if (jobId) {
                  ctx.finishCommandToolDisplay(jobId);
                }
                ctx.finishToolCallDisplay(functionName);
              } else {
                ctx.finishToolCallDisplay(functionName);
              }
            },
          ).catch((error) => {
            console.error("[answer] LLM stream failed:", error);
            if (isCurrentAnswer()) {
              endPartial();
            }
            resolveLlmDone();
          });
        })
        .catch((error) => {
          console.error("[answer] Failed to prepare prompt:", error);
          if (currentAnswerId === ctx.answerId) {
            resolveLlmDone();
            ctx.transitionTo("sleep");
          }
        });
      llmDonePromise.then(() => getPlayEndPromise()).then(() => {
        if (ctx.currentFlowName === "answer") {
          autoSaveExchange(ctx.asrText, llmResponseText, summaryTextWithLLM);
          clearPendingCapturedImgForChat();
          display({ image_icon_visible: false });
          if (ctx.wakeSessionActive || ctx.endAfterAnswer) {
            if (ctx.endAfterAnswer) {
              ctx.endWakeSession();
              ctx.transitionTo("sleep");
            } else {
              ctx.transitionTo("wake_listening");
            }
            return;
          }
          if (ctx.enterMusicAfterAnswer) {
            ctx.transitionTo("music");
            return;
          }
          const img = getLatestDisplayImg();
          if (img) {
            ctx.transitionTo("image");
          } else {
            ctx.transitionTo("sleep");
          }
        }
      });
    };

    if (isAgentMode()) {
      ctx.agentReplyExpired = false;
      const prompt: { role: "user"; content: string }[] = [
        { role: "user", content: ctx.asrText },
      ];
      const timeoutMs = parseInt(
        process.env.AGENT_REPLY_TIMEOUT_MS || "20000",
        10,
      );
      let fellBackToLocal = false;
      // Whichever happens first wins: OpenClaw's reply (handled in
      // ChatFlow.ensureAgentBridge, which transitions to "external_answer")
      // or this fallback. The other becomes a no-op — via the
      // currentFlowName/answerId check below, or agentReplyExpired on the
      // bridge side once we've already moved on.
      const fallbackToLocal = (reason: string): void => {
        if (fellBackToLocal) return;
        if (ctx.currentFlowName !== "answer" || currentAnswerId !== ctx.answerId) return;
        fellBackToLocal = true;
        ctx.agentReplyExpired = true;
        console.log(`[answer] ${reason} — falling back to the local model.`);
        // The fallback always uses the best local model (see
        // docs/llm-model-selection.md), not whatever a previous "modelo X"
        // voice command left active — a dropped OpenClaw connection
        // shouldn't also mean a worse local answer.
        const ensureBestModel =
          getCurrentModel().toLowerCase() === DEFAULT_OLLAMA_MODEL.toLowerCase()
            ? Promise.resolve()
            : switchModel(DEFAULT_OLLAMA_MODEL).catch((err) => {
              console.error(
                "[answer] Failed to switch to the default local model for fallback:",
                err,
              );
            });
        ensureBestModel.then(() => {
          if (ctx.currentFlowName !== "answer" || currentAnswerId !== ctx.answerId) return;
          runLocalAnswer();
        });
      };
      registerSpeakingButtonControls(ctx, () => ctx.streamResponser.stop());
      setTimeout(() => fallbackToLocal("OpenClaw did not reply in time"), timeoutMs);
      sendWhisplayIMMessage(prompt)
        .then((ok) => {
          if (!ok) {
            fallbackToLocal("Failed to reach the whisplay-im bridge");
            return;
          }
          clearPendingCapturedImgForChat();
        })
        .catch(() => fallbackToLocal("whisplay-im bridge request threw"));
      return;
    }

    runLocalAnswer();
  },
  image: (ctx: ChatFlowContext) => {
    onButtonPressed(() => {
      display({ image: "" });
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
  },
  approval: (ctx: ChatFlowContext) => {
    const request = ctx.pendingApprovalRequest;
    if (!request) {
      ctx.transitionTo("sleep");
      return;
    }

    onButtonDoubleClick(null);
    let pressStartedAt = 0;
    let finished = false;
    let timeout: NodeJS.Timeout | null = null;
    const parsedLongPressMs = parseInt(
      process.env.WHISPLAY_IM_APPROVAL_LONG_PRESS_MS || "900",
      10,
    );
    const longPressMs = Number.isFinite(parsedLongPressMs)
      ? Math.max(500, parsedLongPressMs)
      : 900;

    const finish = (approved: boolean): void => {
      if (finished) return;
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      request.respond(approved);
      ctx.pendingApprovalRequest = null;
      display({
        status: approved ? "Allowed" : "Denied",
        emoji: approved ? "✅" : "⛔",
        text: approved ? "Operación permitida." : "Operación denegada.",
        RGB: approved ? "#00c8a3" : "#ff3030",
        approval_mode: false,
        scroll_speed: 0,
      });
      setTimeout(() => {
        if (ctx.currentFlowName === "approval") {
          ctx.transitionTo("sleep");
        }
      }, 600);
    };

    timeout = setTimeout(() => finish(false), request.timeoutMs);
    onButtonPressed(() => {
      pressStartedAt = Date.now();
    });
    onButtonReleased(() => {
      const pressDuration = Date.now() - pressStartedAt;
      finish(pressDuration < longPressMs);
    });

    const lines = compact([
      request.tool ? `[${request.tool}] ${request.title}` : request.title,
      request.text,
    ]);
    display({
      status: "Confirm",
      emoji: "🔐",
      text: lines.join("\n\n"),
      RGB: "#ffb000",
      approval_mode: true,
      text_input_enabled: false,
      scroll_speed: 2,
      image: "",
    });
  },
  external_answer: (ctx: ChatFlowContext) => {
    if (!ctx.pendingExternalReply && !ctx.pendingExternalImageUrl) {
      ctx.transitionTo("sleep");
      return;
    }
    ctx.resetToolCallDisplay();
    ctx.answerDisplayText = "";
    display({
      status: "answering...",
      emoji: ctx.pendingExternalEmoji || "🌐",
      RGB: "#7a5cff",
    });
    registerSpeakingButtonControls(ctx, () => {
      ctx.streamResponser.stop();
      display({ image: "" });
    });
    const replyText = ctx.pendingExternalReply;
    const replyEmoji = ctx.pendingExternalEmoji;
    const replyImageUrl = ctx.pendingExternalImageUrl;
    ctx.currentExternalEmoji = replyEmoji;
    ctx.pendingExternalReply = "";
    ctx.pendingExternalEmoji = "";
    ctx.pendingExternalImageUrl = "";

    // Display the image if one was provided
    if (replyImageUrl) {
      display({ image: replyImageUrl });
    }

    if (replyText) {
      void ctx.streamExternalReply(replyText, replyEmoji);
      ctx.streamResponser.getPlayEndPromise().then(() => {
        if (ctx.currentFlowName !== "external_answer") return;
        if (ctx.wakeSessionActive || ctx.endAfterAnswer) {
          if (ctx.endAfterAnswer) {
            ctx.endWakeSession();
            ctx.transitionTo("sleep");
          } else {
            ctx.transitionTo("wake_listening");
          }
        } else if (replyImageUrl) {
          // Stay in image display mode after TTS finishes
          ctx.transitionTo("image");
        } else {
          ctx.transitionTo("sleep");
        }
      });
    } else {
      // Image only, no text to speak — go to image display mode
      ctx.transitionTo("image");
    }
  },
  model_select: (ctx: ChatFlowContext) => {
    onModelSelectConfirm((alias) => {
      ctx.pendingModelSwitchTag = alias.tag;
      ctx.pendingModelSwitchLabel = alias.label;
      ctx.transitionTo("model_loading");
    });
    onModelSelectTimeout(() => {
      if (ctx.currentFlowName === "model_select") {
        ctx.transitionTo("sleep");
      }
    });
    onModelSelectCancel(() => {
      if (ctx.currentFlowName === "model_select") {
        ctx.transitionTo("sleep");
      }
    });
    // Double click backs out without picking a model — the idle timeout
    // above is only a fallback for walking away mid-menu.
    onButtonDoubleClick(() => handleModelSelectCancel());
    onButtonPressed(() => handleModelSelectPress());
    onButtonReleased(() => handleModelSelectRelease());
    void enterModelSelectMode();
  },
  model_loading: (ctx: ChatFlowContext) => {
    onButtonDoubleClick(null);
    onButtonPressed(noop);
    onButtonReleased(noop);
    const tag = ctx.pendingModelSwitchTag;
    const label = ctx.pendingModelSwitchLabel || tag;
    ctx.pendingModelSwitchTag = "";
    ctx.pendingModelSwitchLabel = "";

    const finish = (text: string): void => {
      display({
        status: "idle",
        model_ui: "",
        text,
      });
      setTimeout(() => {
        if (ctx.currentFlowName === "model_loading") {
          ctx.transitionTo("sleep");
        }
      }, 2500);
    };

    display({
      status: "model_loading",
      model_ui: "loading",
      model_ui_title: "MODELO",
      model_ui_label: label,
      model_ui_description: "",
      // No percent — Ollama has no real progress API for loading an
      // already-downloaded model into memory, so the screen shows an
      // indeterminate spinner instead (see chatbot-ui.py render_model_ui_screen).
      text: "Preparando modelo...",
    });

    listOllamaModels()
      .catch(() => [] as string[])
      .then((installed) => {
        if (ctx.currentFlowName !== "model_loading") return;
        if (!installed.some((m) => m.toLowerCase() === tag.toLowerCase())) {
          finish(`Ese modelo ya no está instalado.`);
          return;
        }
        switchModel(tag)
          .then(() => {
            if (ctx.currentFlowName !== "model_loading") return;
            // Picking a specific local model is an explicit "answer with
            // this, locally" choice — if modo agente was active, switch to
            // modo local instead of loading the model just to keep routing
            // to OpenClaw. Doesn't apply to the agent-fallback's own
            // switchModel call in the "answer" state, which calls it
            // directly rather than going through this flow state.
            if (isAgentMode()) {
              setDeviceMode("local");
              display({ top_bar_mode: "local" });
            }
            finish(`Modelo "${label}" listo para contestar.`);
          })
          .catch(() => {
            if (ctx.currentFlowName !== "model_loading") return;
            finish(`No se pudo cargar el modelo "${label}".`);
          });
      });
  },
  mode_select: (ctx: ChatFlowContext) => {
    onModeSelectConfirm((option) => {
      ctx.pendingDeviceModeSwitch = option.key;
      ctx.transitionTo("mode_loading");
    });
    onModeSelectTimeout(() => {
      if (ctx.currentFlowName === "mode_select") {
        ctx.transitionTo("sleep");
      }
    });
    onModeSelectCancel(() => {
      if (ctx.currentFlowName === "mode_select") {
        ctx.transitionTo("sleep");
      }
    });
    // Double click backs out without switching mode — same "no silent
    // change" reasoning as model_select (see mode-select-mode.ts).
    onButtonDoubleClick(() => handleModeSelectCancel());
    onButtonPressed(() => handleModeSelectPress());
    onButtonReleased(() => handleModeSelectRelease());
    enterModeSelectMode(ctx.pendingDeviceModeSwitch || undefined);
  },
  mode_loading: (ctx: ChatFlowContext) => {
    onButtonDoubleClick(null);
    onButtonPressed(noop);
    onButtonReleased(noop);
    const target = ctx.pendingDeviceModeSwitch || "local";
    ctx.pendingDeviceModeSwitch = "";
    const label = target === "agent" ? "Modo agente" : "Modo local";

    display({
      status: "mode_loading",
      model_ui: "loading",
      model_ui_title: "MODO",
      model_ui_label: label,
      model_ui_description: "",
      text: "Preparando...",
    });

    // No real warm-up step here (unlike an Ollama model load) — starting the
    // bridge server, if needed, is effectively instant. The brief loading
    // screen is only to keep the switch feeling deliberate, consistent with
    // model_loading.
    if (target === "agent") {
      ctx.ensureAgentBridge();
    }
    setDeviceMode(target);

    display({
      status: "idle",
      model_ui: "",
      top_bar_mode: target,
      text: `${label} activado.`,
    });
    setTimeout(() => {
      if (ctx.currentFlowName === "mode_loading") {
        ctx.transitionTo("sleep");
      }
    }, 2500);
  },
  audio_output_select: (ctx: ChatFlowContext) => {
    onAudioOutputSelectConfirm((option) => {
      ctx.pendingAudioOutputSwitch = option.key;
      ctx.pendingAudioOutputLabel = option.label;
      ctx.transitionTo("audio_output_loading");
    });
    onAudioOutputSelectTimeout(() => {
      if (ctx.currentFlowName === "audio_output_select") {
        ctx.transitionTo("sleep");
      }
    });
    onAudioOutputSelectCancel(() => {
      if (ctx.currentFlowName === "audio_output_select") {
        ctx.transitionTo("sleep");
      }
    });
    // Double click backs out without switching speaker — same "no silent
    // change" reasoning as mode_select.
    onButtonDoubleClick(() => handleAudioOutputSelectCancel());
    onButtonPressed(() => handleAudioOutputSelectPress());
    onButtonReleased(() => handleAudioOutputSelectRelease());
    void enterAudioOutputSelectMode();
  },
  audio_output_loading: (ctx: ChatFlowContext) => {
    onButtonDoubleClick(null);
    onButtonPressed(noop);
    onButtonReleased(noop);
    const target = ctx.pendingAudioOutputSwitch || "hat";
    const label = ctx.pendingAudioOutputLabel || "Bocina de la Pi";
    ctx.pendingAudioOutputSwitch = "";
    ctx.pendingAudioOutputLabel = "";

    // Picking a specific Bluetooth speaker needs its MAC connected first (the
    // radio holds only one A2DP speaker at a time, so this also disconnects
    // any other one). "hat" and legacy "bluetooth" need no connect step.
    const mac = target.startsWith("bt:") ? target.slice(3) : null;

    display({
      status: "audio_output_loading",
      model_ui: "loading",
      model_ui_title: "AUDIO",
      model_ui_label: label,
      model_ui_description: "",
      text: mac ? "Conectando bocina..." : "Preparando...",
    });

    const finish = (ok: boolean) => {
      if (ok) {
        setAudioOutputTarget(target);
        display({
          status: "idle",
          model_ui: "",
          text: `${label} activada.`,
        });
      } else {
        display({
          status: "idle",
          model_ui: "",
          text: `No se pudo conectar ${label}.`,
        });
      }
      setTimeout(() => {
        if (ctx.currentFlowName === "audio_output_loading") {
          ctx.transitionTo("sleep");
        }
      }, 2500);
    };

    if (mac) {
      void connectSpeaker(mac)
        .then((res) => finish(res.ok))
        .catch(() => finish(false));
    } else {
      finish(true);
    }
  },
  help: (ctx: ChatFlowContext) => {
    onHelpExit(() => {
      if (ctx.currentFlowName === "help") {
        ctx.transitionTo("sleep");
      }
    });
    onButtonDoubleClick(() => handleHelpDoubleClick());
    onButtonPressed(() => handleHelpPress());
    onButtonReleased(() => handleHelpRelease());
    enterHelpMode();
  },
  volume_adjust: (ctx: ChatFlowContext) => {
    onVolumeAdjustExit(() => {
      if (ctx.currentFlowName === "volume_adjust") {
        ctx.transitionTo("sleep");
      }
    });
    onButtonDoubleClick(() => handleVolumeAdjustDoubleClick());
    onButtonPressed(() => handleVolumeAdjustPress());
    onButtonReleased(() => handleVolumeAdjustRelease());
    enterVolumeAdjustMode();
  },
  wifi_manager: (ctx: ChatFlowContext) => {
    onWifiManagerDone(() => {
      exitWifiManagerMode();
      if (ctx.currentFlowName === "wifi_manager") {
        ctx.transitionTo("sleep");
      }
    });
    onButtonDoubleClick(() => handleWifiManagerCancel());
    onButtonPressed(() => handleWifiManagerPress());
    onButtonReleased(() => handleWifiManagerRelease());
    void enterWifiManagerMode();
  },
  network_info: (ctx: ChatFlowContext) => {
    onNetworkInfoExit(() => {
      if (ctx.currentFlowName === "network_info") {
        ctx.transitionTo("sleep");
      }
    });
    onButtonDoubleClick(() => handleNetworkInfoDoubleClick());
    onButtonPressed(() => handleNetworkInfoPress());
    onButtonReleased(() => handleNetworkInfoRelease());
    enterNetworkInfoMode();
  },
  wifi_radar: (ctx: ChatFlowContext) => {
    onWifiRadarExit(() => {
      if (ctx.currentFlowName === "wifi_radar") {
        ctx.transitionTo("sleep");
      }
    });
    onButtonDoubleClick(() => handleWifiRadarDoubleClick());
    onButtonPressed(() => handleWifiRadarPress());
    onButtonReleased(() => handleWifiRadarRelease());
    enterWifiRadarMode();
  },
};
