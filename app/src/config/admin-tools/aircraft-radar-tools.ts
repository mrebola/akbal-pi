// Admin-chat wrapper around the existing voice-flow aircraft radar tools
// (../aircraft-radar-tools.ts, already used by llm-tools.ts for the voice
// assistant) — reused as-is, just tagged with the section/title metadata
// the chat tool-loop needs for deep links and the "running…" chip. Nothing
// here duplicates the ADS-B logic itself.
import { aircraftRadarTools } from "../aircraft-radar-tools";
import { AdminToolDescriptor } from "./types";

export const aircraftRadarAdminTools: AdminToolDescriptor[] = aircraftRadarTools.map((tool) => ({
  tool,
  sectionId: "aircraft-radar",
  title: "Consultando Radar de Aviones…",
}));
