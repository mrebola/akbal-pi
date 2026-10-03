import type { ReadOnlyCommand } from "./registry-core";

// Commands that are not admin functions. /estado reads the radar, GPS, clock
// and memory in one answer, so it has no single tool behind it.
export const BUILT_IN_COMMANDS: { alias: string; description: string }[] = [
  { alias: "estado", description: "radar, GPS, reloj y memoria" },
];

// Built from the registry, so a new read-only function shows up here with no edit.
export const buildHelp = (registry: ReadOnlyCommand[]): string => {
  const lines = [
    ...registry.map((c) => `/${c.alias} · ${c.description}`),
    ...BUILT_IN_COMMANDS.map((c) => `/${c.alias} · ${c.description}`),
    "/ask <pregunta> · pregunta abierta al LLM local",
  ];
  return ["Comandos disponibles:", ...lines].join("\n");
};
