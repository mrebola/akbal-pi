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
// (checked with `ollama list` — see docs/llm-model-selection.md).
const MODEL_ALIASES: ModelAlias[] = [
  {
    key: "1",
    tag: "deepseek-r1:1.5b",
    label: "modelo 1, deepseek",
    synonyms: ["1", "uno", "one", "deepseek"],
  },
  {
    key: "2",
    tag: "llama3.2:3b",
    label: "modelo 2, llama 3",
    synonyms: ["2", "dos", "two", "llama3", "llama 3", "ollama3", "ollama 3", "llama"],
  },
  {
    key: "3",
    tag: "qwen3.5:2B",
    label: "modelo 3, qwen 3.5",
    synonyms: ["3", "tres", "three", "qwen3.5", "qwen 3.5", "qwen3 5"],
  },
  {
    key: "4",
    tag: "huihui_ai/qwen3-abliterated:1.7b",
    label: "modelo 4, qwen sin censura",
    synonyms: ["4", "cuatro", "four", "qwen sin censura"],
  },
  {
    key: "5",
    tag: "huihui_ai/qwen3.5-abliterated:2B",
    label: "modelo 5, qwen sin censura 2",
    synonyms: [
      "5",
      "cinco",
      "five",
      "qwen sin censura 2",
      "qwen sin censura dos",
    ],
  },
  {
    key: "6",
    tag: STABLE_MODEL_TAG,
    label: "modelo 6, qwen 3, el más estable",
    synonyms: ["6", "seis", "six", "qwen3", "qwen 3"],
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// Words that can trail "modelo"/"model" without actually naming a target
// (articles, connectors, filler, and the query words above), so they don't
// get mistaken for a (failed) model name.
const NON_TARGET_WORDS = new Set([
  "el", "la", "los", "las", "de", "a", "al", "to", "es", "un", "una",
  "por", "favor", "porfavor", "please", "gracias", "ahora", "mismo", "ya",
  "que", "cuales", "cual", "lista", "opciones", "menu", "which", "list",
  "options", "tenemos", "hay", "modelo", "modelos", "model", "models",
]);

function meaningfulTokens(phrase: string): string[] {
  return phrase.split(" ").filter((w) => w && !NON_TARGET_WORDS.has(w));
}

function findAliasByPhrase(remainder: string): ModelAlias | undefined {
  let best: { alias: ModelAlias; length: number } | undefined;
  for (const alias of MODEL_ALIASES) {
    for (const synonym of alias.synonyms) {
      const normSynonym = normalize(synonym);
      if (!normSynonym) continue;
      if (new RegExp(`\\b${escapeRegExp(normSynonym)}\\b`).test(remainder)) {
        if (!best || normSynonym.length > best.length) {
          best = { alias, length: normSynonym.length };
        }
      }
    }
  }
  return best?.alias;
}

function matchModelCommand(norm: string): VoiceCommand | null {
  if (!MODEL_WORD.test(norm)) return null;

  const afterModelWord = norm.match(/model(o)?s?\b\s*(.*)$/);
  const candidatePhrase = afterModelWord ? afterModelWord[2] : "";
  const tokens = meaningfulTokens(candidatePhrase);
  const remainder = tokens.join(" ");
  const alias = remainder ? findAliasByPhrase(remainder) : undefined;

  if (alias) return { type: "model_switch", alias };

  const hasIntent = MODEL_INTENT.test(norm) || MODEL_QUERY_INTENT.test(norm);
  if (!hasIntent) return null;

  if (!remainder) return { type: "model_menu" };
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
  const options = MODEL_ALIASES.map((a) => a.label).join(". ");
  return (
    `Tenemos estos modelos. ${options}. ` +
    `Para cambiar, decí "cambia el modelo a" y el número o el nombre, por ` +
    `ejemplo "cambia el modelo a 1" o "cambia el modelo a deepseek". ` +
    `Ahora mismo estoy usando el ${currentLabel}.`
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
