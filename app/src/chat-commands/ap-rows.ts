import { findAccessPoints } from "../config/admin-tools/ap-search";
import type { AccessPointRow } from "./format";

// Pure: keeps the fields the formatter needs. A name searches every access
// point; no name keeps the first fifteen (the same limit as the tool).
export const toAccessPointRows = (
  aps: { ssid: string | null; channel: number | null; rssi: number | null; security: string | null; clients: number | null; bssid?: string }[],
  query: string,
): AccessPointRow[] =>
  findAccessPoints(aps, query || undefined).map((a) => ({
    ssid: a.ssid,
    channel: a.channel,
    rssi: a.rssi,
    security: a.security,
    clients: a.clients,
  }));
