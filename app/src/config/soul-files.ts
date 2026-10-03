// Backs the web admin's Settings > Soul tab (device/web-admin-server.ts's
// /api/soul/* routes) — lets the person running the device edit Akbal's
// identity files from the browser instead of SSH-ing in.
//
// Deliberately a FIXED allowlist, not a generic "write any file" primitive:
// the POST handler can only ever touch one of these exact paths, picked by
// `id`, never a path the request supplies itself.
import fs from "fs";
import path from "path";
import { soulFilePath, knowledgeDir } from "../utils/dir";
import { enableRAG } from "../cloud-api/knowledge";
import { indexKnowledgeCollection } from "../core/Knowledge";

export type SoulFileKind = "soul" | "knowledge";

type SoulFileDescriptor = {
  id: string;
  label: string;
  kind: SoulFileKind;
  path: string;
};

// "soul" (config/llm-config.ts's getBasePersonaPrompt/getSystemPrompt) is
// re-read live on every turn — editing it here takes effect on the very
// next message, no restart. "knowledge" files feed the RAG (core/
// Knowledge.ts) instead — those need a re-embed to actually change what
// gets retrieved, which saving here triggers automatically (see
// triggerKnowledgeReindex below).
const SOUL_FILES: SoulFileDescriptor[] = [
  { id: "soul", label: "Personalidad (soul.md)", kind: "soul", path: soulFilePath },
  { id: "identidad", label: "Identidad", kind: "knowledge", path: path.join(knowledgeDir, "akbal-identidad.md") },
  { id: "capacidades", label: "Capacidades", kind: "knowledge", path: path.join(knowledgeDir, "akbal-capacidades.md") },
  { id: "bitacora", label: "Bitácora", kind: "knowledge", path: path.join(knowledgeDir, "akbal-bitacora.md") },
];

const findDescriptor = (id: string): SoulFileDescriptor | undefined => SOUL_FILES.find((f) => f.id === id);

const safeReadFile = (filePath: string): string => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

export type SoulFilePayload = { id: string; label: string; kind: SoulFileKind; content: string };

export const listSoulEditableFiles = (): SoulFilePayload[] =>
  SOUL_FILES.map((f) => ({ id: f.id, label: f.label, kind: f.kind, content: safeReadFile(f.path) }));

let reindexInFlight = false;

// Fire-and-forget: indexKnowledgeCollection() only ever prompts on stdin
// (promptYesNo) when the embedding dimension changed — a different
// EMBEDDING_SERVER/model, never a plain content edit — so calling it from
// an HTTP handler is safe for what this tab actually does. It logs its own
// progress to the service's console; there's no finer-grained progress to
// surface here than "started"/"failed".
export const triggerKnowledgeReindex = (): { ok: boolean; error?: string } => {
  if (!enableRAG) return { ok: false, error: "RAG deshabilitado (ENABLE_RAG)" };
  if (reindexInFlight) return { ok: true };
  reindexInFlight = true;
  indexKnowledgeCollection()
    .catch((err: any) => console.error("[Soul] Knowledge reindex failed:", err?.message || err))
    .finally(() => {
      reindexInFlight = false;
    });
  return { ok: true };
};

export const writeSoulEditableFile = (
  id: string,
  content: string,
): { ok: true; reindexing: boolean } | { ok: false; error: string } => {
  const descriptor = findDescriptor(id);
  if (!descriptor) return { ok: false, error: `Archivo desconocido: ${id}` };
  fs.mkdirSync(path.dirname(descriptor.path), { recursive: true });
  fs.writeFileSync(descriptor.path, content, "utf8");
  const reindex = descriptor.kind === "knowledge" ? triggerKnowledgeReindex() : { ok: false };
  return { ok: true, reindexing: reindex.ok };
};
