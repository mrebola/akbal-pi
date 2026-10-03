import { LLMTool } from "../../type";
import { AdminSectionId } from "./ui-links";

// One declaration per admin-chat tool instead of three parallel maps
// (schema / func / metadata) that could drift out of sync — see
// registry.ts, which is the single place that reads these. `sensitive`
// is unused in Fase 1 (read-only tools only) but declared now so Fase 2/3
// control tools can opt into the chat confirmation flow by just setting it
// here, without touching the registry or the /api/chat handler again.
export type AdminToolDescriptor = {
  tool: LLMTool;
  sectionId: AdminSectionId;
  // Short label shown in the chat while this tool is running, e.g.
  // "Consultando Radar Wi-Fi…" — see the `admin_tool_call` NDJSON frame in
  // web-admin-server.ts.
  title: string;
  sensitive?: {
    // Rendered to the user before executing; must name the concrete
    // target (BSSID/SSID/etc.) the model proposed, never a generic
    // "¿confirmas?" — see docs/deploy.md's "no es un sandbox descartable"
    // and the wifi-audit allowlist this confirmation sits in front of
    // (UX safeguard only — the allowlist check in wifi-audit/service.ts
    // is the real boundary and stays untouched).
    promptTemplate: (args: Record<string, any>) => string;
  };
};
