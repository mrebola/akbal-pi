import { setVolumeByAmixer, getCurrentLogPercent } from "../../utils/volume";
import {
  getCurrentModel,
  setCurrentModel,
  listOllamaModels,
} from "../../cloud-api/local/ollama-llm";

// Volume and model-switch voice commands are matched here, in plain JS,
// BEFORE the recognized text ever reaches the LLM. Doing this through LLM
// tool-calling instead would attach every tool's schema to every single
// chat request (not just these commands), which measured ~15x slower
// responses on this hardware — see docs/llm-model-selection.md. This keeps
// normal conversation exactly as fast as before.

const STABLE_MODEL_TAG = "qwen3:1.7b";

type ModelAlias = {
  key: string;
  tag: string;
  label: string;
  synonyms: string[];
};

// Short, spoken-friendly names for the models actually installed on this Pi
// (checked with `ollama list` — see docs/llm-model-selection.md). The
// discarded Qwen3.5-4B-Uncensored-GGUF is intentionally left out: it's slow
// and doesn't stop generating, so it's not offered as a voice option.
const MODEL_ALIASES: ModelAlias[] = [
  {
    key: "uno",
    tag: STABLE_MODEL_TAG,
    label: "modelo uno, el más rápido y estable",
    synonyms: ["uno", "one", "1", "rapido", "rápido", "fast", "estable"],
  },
  {
    key: "dos",
    tag: "huihui_ai/qwen3.5-abliterated:2B",
    label: "modelo dos, el que uso normalmente",
    synonyms: ["dos", "two", "2"],
  },
];

export type VoiceCommand =
  | { type: "volume"; action: "set"; percent: number }
  | { type: "volume"; action: "increase" }
  | { type: "volume"; action: "decrease" }
  | { type: "model_menu" }
  | { type: "model_switch"; alias: ModelAlias }
  | { type: "model_switch_failed" };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VOLUME_WORD = /\bvolum(en|e)\b/;
const VOLUME_UP_PHRASES = [
  "subele",
  "sube el volumen",
  "sube volumen",
  "aumenta el volumen",
  "aumentar el volumen",
  "mas volumen",
  "dale mas volumen",
  "pon mas volumen",
  "turn up the volume",
  "volume up",
  "increase the volume",
  "increase volume",
  "louder",
];
const VOLUME_DOWN_PHRASES = [
  "bajale",
  "baja el volumen",
  "baja volumen",
  "disminuye el volumen",
  "disminuir el volumen",
  "menos volumen",
  "pon menos volumen",
  "turn down the volume",
  "volume down",
  "decrease the volume",
  "decrease volume",
  "lower the volume",
  "quieter",
];

function matchVolumeCommand(norm: string): VoiceCommand | null {
  if (VOLUME_WORD.test(norm)) {
    const numberMatch = norm.match(/(\d{1,3})/);
    if (numberMatch) {
      const percent = Math.min(100, Math.max(0, parseInt(numberMatch[1], 10)));
      return { type: "volume", action: "set", percent };
    }
    if (
      /\b(sube|subir|aumenta|aumentar)\b/.test(norm) ||
      VOLUME_UP_PHRASES.some((p) => norm.includes(p))
    ) {
      return { type: "volume", action: "increase" };
    }
    if (
      /\b(baja|bajar|disminuye|disminuir)\b/.test(norm) ||
      VOLUME_DOWN_PHRASES.some((p) => norm.includes(p))
    ) {
      return { type: "volume", action: "decrease" };
    }
  }
  if (VOLUME_UP_PHRASES.some((p) => norm.includes(p))) {
    return { type: "volume", action: "increase" };
  }
  if (VOLUME_DOWN_PHRASES.some((p) => norm.includes(p))) {
    return { type: "volume", action: "decrease" };
  }
  return null;
}

const MODEL_WORD = /\bmodel(o)?s?\b/;
const MODEL_INTENT =
  /\b(cambia|cambiar|switch|change|usa|usar|use|pon|selecciona|elige)\b/;
const MODEL_QUERY_INTENT =
  /\b(que|cuales|cual|lista|opciones|menu|which|list|options|tenemos|hay)\b/;

function findAliasByToken(token: string): ModelAlias | undefined {
  return MODEL_ALIASES.find((alias) => alias.synonyms.includes(token));
}

function extractRequestedModelToken(norm: string): string | null {
  const afterConnector = norm.match(
    /model(o)?s?\b[^a-z0-9]*(?:a|al|to|es)\s+([a-z0-9]+)/,
  );
  if (afterConnector) return afterConnector[2];
  const afterVerb = norm.match(
    /\b(usa|usar|use|pon)\b[^a-z0-9]*model(o)?\b\s+([a-z0-9]+)/,
  );
  if (afterVerb) return afterVerb[3];
  return null;
}

function matchModelCommand(norm: string): VoiceCommand | null {
  if (!MODEL_WORD.test(norm)) return null;
  if (!MODEL_INTENT.test(norm) && !MODEL_QUERY_INTENT.test(norm)) return null;
  const token = extractRequestedModelToken(norm);
  if (!token) return { type: "model_menu" };
  const alias = findAliasByToken(token);
  if (alias) return { type: "model_switch", alias };
  return { type: "model_switch_failed" };
}

export function matchVoiceCommand(rawText: string): VoiceCommand | null {
  const norm = normalize(rawText || "");
  if (!norm) return null;
  return matchModelCommand(norm) || matchVolumeCommand(norm);
}

function aliasForTag(tag: string): ModelAlias | undefined {
  return MODEL_ALIASES.find((a) => a.tag.toLowerCase() === tag.toLowerCase());
}

function buildModelMenuText(): string {
  const current = getCurrentModel();
  const currentLabel = aliasForTag(current)?.label || current;
  const options = MODEL_ALIASES.map((a) => `${a.key}: ${a.label}`).join(". ");
  return (
    `Tenemos estos modelos. ${options}. ` +
    `Para cambiar, decí "cambia el modelo a" y el nombre, por ejemplo ` +
    `"cambia el modelo a uno". Ahora mismo estoy usando el ${currentLabel}.`
  );
}

export async function handleVoiceCommand(
  command: VoiceCommand,
): Promise<string> {
  switch (command.type) {
    case "volume": {
      if (command.action === "set") {
        setVolumeByAmixer(command.percent);
        return `Volumen ajustado a ${command.percent} por ciento.`;
      }
      const currentLogPercent = getCurrentLogPercent();
      if (command.action === "increase") {
        if (currentLogPercent >= 100) return "El volumen ya está al máximo.";
        const next = Math.min(currentLogPercent + 10, 100);
        setVolumeByAmixer(next);
        return `Volumen subido a ${next} por ciento.`;
      }
      if (currentLogPercent <= 0) return "El volumen ya está al mínimo.";
      const next = Math.max(currentLogPercent - 10, 0);
      setVolumeByAmixer(next);
      return `Volumen bajado a ${next} por ciento.`;
    }
    case "model_menu":
      return buildModelMenuText();
    case "model_switch": {
      const installed = await listOllamaModels().catch(() => [] as string[]);
      const isInstalled = installed.some(
        (tag) => tag.toLowerCase() === command.alias.tag.toLowerCase(),
      );
      if (!isInstalled) {
        setCurrentModel(STABLE_MODEL_TAG);
        return `Ese modelo ya no está instalado. Dejé activado el más estable. ${buildModelMenuText()}`;
      }
      if (command.alias.tag.toLowerCase() === getCurrentModel().toLowerCase()) {
        return `Ya estoy usando el ${command.alias.label}.`;
      }
      setCurrentModel(command.alias.tag);
      return `Listo, cambié al ${command.alias.label}.`;
    }
    case "model_switch_failed":
      setCurrentModel(STABLE_MODEL_TAG);
      return `No reconocí ese modelo, dejé el más estable activado. ${buildModelMenuText()}`;
    default:
      return "";
  }
}
