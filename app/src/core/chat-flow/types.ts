import { StreamResponser } from "../StreamResponsor";
import type { WhisplayIMApprovalRequest } from "../../device/im-bridge";
import type { DeviceMode } from "../../config/device-mode";
import type { AudioOutputTarget } from "../../config/audio-output";

export type FlowName =
  | "sleep"
  | "camera"
  | "music"
  | "jukebox"
  | "listening"
  | "wake_listening"
  | "asr"
  | "answer"
  | "image"
  | "approval"
  | "external_answer"
  | "model_select"
  | "model_loading"
  | "mode_select"
  | "mode_loading"
  | "audio_output_select"
  | "audio_output_loading"
  | "help"
  | "quick_menu"
  | "volume_adjust"
  | "wifi_manager"
  | "network_info"
  | "wifi_radar";

export type FlowStateHandler = (ctx: ChatFlowContext) => void;

export interface ChatFlowContext {
  currentFlowName: FlowName;
  recordingsDir: string;
  currentRecordFilePath: string;
  asrText: string;
  streamResponser: StreamResponser;
  partialThinking: string;
  thinkingSentences: string[];
  answerId: number;
  enableCamera: boolean;
  knowledgePrompts: string[];
  wakeSessionActive: boolean;
  wakeSessionStartAt: number;
  wakeSessionLastSpeechAt: number;
  wakeSessionIdleTimeoutMs: number;
  wakeRecordMaxSec: number;
  wakeEndKeywords: string[];
  endAfterAnswer: boolean;
  pendingExternalReply: string;
  pendingExternalEmoji: string;
  pendingExternalImageUrl: string;
  pendingModelSwitchTag: string;
  pendingModelSwitchLabel: string;
  pendingDeviceModeSwitch: DeviceMode | "";
  pendingAudioOutputSwitch: AudioOutputTarget | "";
  pendingAudioOutputLabel: string;
  pendingApprovalRequest: WhisplayIMApprovalRequest | null;
  agentReplyExpired: boolean;
  currentExternalEmoji: string;
  isFromWakeListening: boolean;
  enterMusicAfterAnswer: boolean;
  musicDisplayText: string;
  toolDisplayText: string;
  answerDisplayText: string;

  transitionTo: (flowName: FlowName) => void;
  composeAnswerDisplayText: (text?: string) => string;
  updateAnswerDisplayText: (text: string) => void;
  appendToolCallDisplay: (functionName: string) => void;
  finishToolCallDisplay: (functionName: string) => void;
  keepCommandToolDisplayRunning: (jobId: string) => void;
  finishCommandToolDisplay: (jobId: string) => void;
  resetToolCallDisplay: () => void;
  recognizeAudio: (path: string, isFromAutoListening?: boolean) => Promise<string>;
  partialThinkingCallback: (partialThinking: string) => void;
  startWakeSession: () => void;
  endWakeSession: () => void;
  shouldContinueWakeSession: () => boolean;
  shouldEndAfterAnswer: (text: string) => boolean;
  streamExternalReply: (text: string, emoji?: string) => Promise<void>;
  ensureAgentBridge: () => void;
}
