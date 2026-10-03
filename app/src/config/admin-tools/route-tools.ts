import { AdminSectionId } from "./ui-links";

// Keyword routing for the web chat. The small local model picks the wrong tool
// when every tool is offered (it answered an aircraft question with the WiFi
// radar). When the question names a subsystem, only that subsystem's tools are
// sent; a question naming none keeps the full list.
const ROUTES: { section: AdminSectionId; pattern: RegExp }[] = [
  { section: "aircraft-radar", pattern: /avi[oó]n|aeronave|vuelo|adsb|ads-b|hackrf/i },
  { section: "wifiradar", pattern: /\bwi-?fi\b|\bssid\b|\bbssid\b|access point/i },
  { section: "gps", pattern: /\bgps\b|gnss|sat[eé]lite/i },
  { section: "wardrive", pattern: /wardriv/i },
  { section: "wifi-audit", pattern: /handshake|audit/i },
];

export const sectionsForMessage = (message: string): AdminSectionId[] =>
  ROUTES.filter((route) => route.pattern.test(message)).map((route) => route.section);

export const selectToolsForMessage = <T extends { sectionId: AdminSectionId }>(
  message: string,
  tools: T[],
): T[] => {
  const wanted = new Set(sectionsForMessage(message));
  if (wanted.size === 0) return tools;
  return tools.filter((tool) => wanted.has(tool.sectionId));
};
