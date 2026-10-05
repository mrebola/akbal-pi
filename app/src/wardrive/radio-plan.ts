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

// Attack slots a running session can host AT THE SAME TIME. With 2+ radios
// one of them must keep discovering (fresh air picture while others attack),
// so the cap is radios − 1; single has no separate attack radio at all (its
// shared radio attacks with the whole discovery pipeline paused — that
// global pause is still governed by the caller, this function just says how
// many radios can host an hcxdumptool round concurrently).
export function maxConcurrentAttackers(mode: RadioMode, connected: number): number {
  const n = Math.max(0, Math.floor(connected));
  if (mode === "single") return 0;
  if (n <= 1) return 0;
  if (mode === "dual") return 1;
  return Math.min(n - 1, 2); // triple and auto: one radio always stays on discovery
}

export type ActiveRadio = { iface: string; role: "attack" | "discovery" | "attacking" };

// Radios running right now, with their role. "attacking" = that radio is
// hosting an hcxdumptool round right now (a discovery radio mid-round).
export function activeRadiosOf(
  discoveryIfaces: string[],
  attackIface: string | null,
  attackingIfaces: string[] = [],
): ActiveRadio[] {
  const attacking = new Set(attackingIfaces);
  const out: ActiveRadio[] = discoveryIfaces.map((iface) => ({
    iface,
    role: attacking.has(iface) ? ("attacking" as const) : ("discovery" as const),
  }));
  if (attackIface && !attacking.has(attackIface)) out.push({ iface: attackIface, role: "attack" });
  return out;
}
