import { ADMIN_TOOL_DESCRIPTORS } from "../config/admin-tools/registry";
import { buildCommandRegistry, ReadOnlyCommand } from "./registry-core";

export { findCommand, READ_ONLY_ALIASES } from "./registry-core";
export type { ReadOnlyCommand } from "./registry-core";

// The live registry, built from the admin tools so /help never drifts from them.
export const commandRegistry = (): ReadOnlyCommand[] =>
  buildCommandRegistry(
    ADMIN_TOOL_DESCRIPTORS.map((d) => ({ name: d.tool.function.name, description: d.tool.function.description })),
  );
