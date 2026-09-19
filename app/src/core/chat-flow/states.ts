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
  enterHelpMode,
  handleHelpClick,
  handleHelpDoubleClick,
  onHelpExit,
} from "./help-mode";
import { isAgentMode, setDeviceMode } from "../../config/device-mode";
import {
  getCurrentModel,
  listOllamaModels,
  switchModelWithProgress,
} from "../../cloud-api/local/ollama-llm";
import { isMusicPlaying, getCurrentTrackTitle, stopMusicPlayback, startPendingMusicPlayback, onMusicTrackChange, onMusicPlaybackEnd } from "../../device/music-player";
import { autoSaveExchange, prepareMemoryPrompt } from "../../config/local-memory";

export const flowStates: Record<FlowName, FlowStateHandler> = {
  sleep: (ctx: ChatFlowContext) => {
    onButtonPressed(() => {
      resetCameraModeControl();
      // Stop any playing music when waking up
      stopMusicPlayback();
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
    onCameraModeExit(null);
    onTextInput((text: string) => {
      if (ctx.currentFlowName !== "sleep") return;
      ctx.answerId += 1;
      ctx.asrText = text;
      display({ status: "recognizing", text, text_input_enabled: false });
      ctx.transitionTo("answer");
    });
    if (ctx.enableCamera) {
      const captureImgPath = `${cameraDir}/capture-${moment().format(
        "YYYYMMDD-HHmmss",
      )}.jpg`;
      onButtonDoubleClick(() => {
        enterCameraMode(captureImgPath);
        ctx.transitionTo("camera");
      });
    }
    display({
      status: "idle",
      emoji: "😴",
      RGB: "#000055",
      rag_icon_visible: false,
      // Always clear the model-select/loading overlay here, since "sleep" is
      // the common return point from every flow — including the idle timeout
      // in "model_select", which has no other cleanup step.
      model_ui: "",
      model_ui_percent: 0,
      help_ui: "",
      ...(getCurrentStatus().text.endsWith("Escuchando...") || !getCurrentStatus().text
        ? {
          text: `Mantén presionado el botón para hablar${ctx.enableCamera ? ",\ndoble clic para abrir la cámara" : ""
            }.`,
        }
        : {}),
    });
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
    display({
      status: "answering...",
      RGB: "#00c8a3",
    });
    const currentAnswerId = ctx.answerId;

    // Local model turn — used directly in "modo local", and as the fallback
    // when "modo agente" doesn't hear back from OpenClaw in time (see below).
    const runLocalAnswer = (): void => {
      onButtonPressed(() => {
        ctx.transitionTo("listening");
      });
      onButtonReleased(noop);
      const {
        partial,
        endPartial,
        getPlayEndPromise,
        stop: stopPlaying,
      } = ctx.streamResponser;
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
      onButtonPressed(() => {
        stopPlaying();
        clearPendingCapturedImgForChat();
        display({ image_icon_visible: false });
        ctx.transitionTo("listening");
      });
      onButtonReleased(noop);
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
        runLocalAnswer();
      };
      onButtonPressed(() => {
        ctx.transitionTo("listening");
      });
      onButtonReleased(noop);
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
      RGB: "#00c8a3",
      ...(ctx.pendingExternalEmoji ? { emoji: ctx.pendingExternalEmoji } : {}),
    });
    onButtonPressed(() => {
      ctx.streamResponser.stop();
      display({ image: "" });
      ctx.transitionTo("listening");
    });
    onButtonReleased(noop);
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
    enterModelSelectMode();
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
        model_ui_percent: 0,
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
      model_ui_label: label,
      model_ui_percent: 0,
      // A single line, no "\n" — the bottom-text renderer (see
      // chatbot-ui.py render_bottom_text) wraps by character width only and
      // doesn't understand embedded newlines, so a literal "\n" here breaks
      // its line-height math instead of producing a clean second line.
      text: `Cargando modelo: ${label}`,
    });

    listOllamaModels()
      .catch(() => [] as string[])
      .then((installed) => {
        if (ctx.currentFlowName !== "model_loading") return;
        if (!installed.some((m) => m.toLowerCase() === tag.toLowerCase())) {
          finish(`Ese modelo ya no está instalado.`);
          return;
        }
        switchModelWithProgress(tag, (percent) => {
          if (ctx.currentFlowName !== "model_loading") return;
          display({ model_ui_percent: percent });
        })
          .then(() => {
            if (ctx.currentFlowName !== "model_loading") return;
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
    const label =
      target === "agent" ? "Modo agente (OpenClaw)" : "Modo local (modelos locales)";

    display({
      status: "mode_loading",
      model_ui: "loading",
      model_ui_label: label,
      model_ui_percent: 50,
      text: `Cambiando a: ${label}`,
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
      model_ui_percent: 0,
      text: `${label} activado.`,
    });
    setTimeout(() => {
      if (ctx.currentFlowName === "mode_loading") {
        ctx.transitionTo("sleep");
      }
    }, 2500);
  },
  help: (ctx: ChatFlowContext) => {
    onHelpExit(() => {
      if (ctx.currentFlowName === "help") {
        ctx.transitionTo("sleep");
      }
    });
    onButtonDoubleClick(() => handleHelpDoubleClick());
    onButtonPressed(noop);
    onButtonReleased(() => handleHelpClick());
    enterHelpMode();
  },
};
