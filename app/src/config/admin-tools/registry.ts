// Central registry for the admin WEB CHAT's own tool set — deliberately
// separate from app/src/config/llm-tools.ts (the voice-flow registry).
// Attaching every admin tool to every voice turn would send far more tool
// schemas than the Pi can afford per-request (see the "far too slow on
// this hardware" note in cloud-api/local/ollama-llm.ts) — so this registry
// is only ever read by the /api/chat handler in web-admin-server.ts.
//
// Adding a new admin-chat tool: write its LLMTool in a sibling file (see
// wifiradar-tools.ts for the shape), export an AdminToolDescriptor[] from
// it, and add that array to ADMIN_TOOL_DESCRIPTORS below. That's the only
// registration step — adminTools/adminFuncMap/adminToolMeta are derived.
import { LLMTool } from "../../type";
import { AdminToolDescriptor } from "./types";
import { AdminSectionId } from "./ui-links";
import { wifiradarAdminTools } from "./wifiradar-tools";
import { gnssAdminTools } from "./gnss-tools";
import { wifiAuditAdminTools } from "./wifi-audit-tools";
import { wardriveAdminTools } from "./wardrive-tools";
import { systemAdminTools } from "./system-tools";
import { aircraftRadarAdminTools } from "./aircraft-radar-tools";

export const ADMIN_TOOL_DESCRIPTORS: AdminToolDescriptor[] = [
  ...systemAdminTools,
  ...wifiradarAdminTools,
  ...aircraftRadarAdminTools,
  ...gnssAdminTools,
  ...wifiAuditAdminTools,
  ...wardriveAdminTools,
];

export const adminTools: LLMTool[] = ADMIN_TOOL_DESCRIPTORS.map((d) => d.tool);

export const adminFuncMap: Record<string, (params: any) => Promise<string>> = ADMIN_TOOL_DESCRIPTORS.reduce(
  (acc, d) => {
    acc[d.tool.function.name] = d.tool.func;
    return acc;
  },
  {} as Record<string, (params: any) => Promise<string>>,
);

export const adminToolMeta: Record<string, AdminToolDescriptor> = ADMIN_TOOL_DESCRIPTORS.reduce(
  (acc, d) => {
    acc[d.tool.function.name] = d;
    return acc;
  },
  {} as Record<string, AdminToolDescriptor>,
);

// Tool schemas for one UI section — what /api/chat sends the model besides
// the always-on `settings`/general ones, keeping per-turn payload small
// regardless of how many sections exist overall (see system-tools.ts,
// tagged "settings", which is always relevant). `activeSection` comes from
// the frontend's current hash/path (app.js), same signal topbar.js already
// derives to highlight the active nav item.
export const adminToolsForSection = (activeSection: AdminSectionId | null): LLMTool[] =>
  ADMIN_TOOL_DESCRIPTORS.filter((d) => d.sectionId === "settings" || d.sectionId === activeSection).map(
    (d) => d.tool,
  );
