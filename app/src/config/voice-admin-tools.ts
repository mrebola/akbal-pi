// Admin-chat tools the device voice may call. Read-only status tools only:
// an active WiFi scan transmits and changes what the radio is doing, so it
// stays in the web chat.
export const VOICE_EXCLUDED_ADMIN_TOOLS: ReadonlySet<string> = new Set(["scanNearbyWifiNetworks"]);

export const selectVoiceAdminTools = <T extends { function: { name: string } }>(tools: T[]): T[] =>
  tools.filter((tool) => !VOICE_EXCLUDED_ADMIN_TOOLS.has(tool.function.name));
