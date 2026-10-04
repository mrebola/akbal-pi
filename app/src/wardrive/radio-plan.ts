// Radio-count rules for a wardrive session. Pure functions so the mapping
// from the requested mode to the radios actually used stays testable without
// hardware.

export const RADIO_MODES = ["auto", "single", "dual", "triple"] as const;
export type RadioMode = (typeof RADIO_MODES)[number];

export function parseRadioMode(raw: unknown): RadioMode | null {
  return (RADIO_MODES as readonly string[]).includes(raw as string) ? (raw as RadioMode) : null;
}

// How many connected monitor-capable radios a session uses for a mode:
// auto takes all of them, the others cap at 1, 2 or 3 (whatever is connected
// when there are fewer).
export function radioCountForMode(mode: RadioMode, connected: number): number {
  const n = Math.max(0, Math.floor(connected));
  if (mode === "auto") return n;
  if (mode === "single") return Math.min(1, n);
  if (mode === "dual") return Math.min(2, n);
  return Math.min(3, n);
}

export type ActiveRadio = { iface: string; role: "attack" | "discovery" };

// Radios running right now, with their role. The attack radio is listed last.
export function activeRadiosOf(discoveryIfaces: string[], attackIface: string | null): ActiveRadio[] {
  const out: ActiveRadio[] = discoveryIfaces.map((iface) => ({ iface, role: "discovery" as const }));
  if (attackIface) out.push({ iface: attackIface, role: "attack" });
  return out;
}
