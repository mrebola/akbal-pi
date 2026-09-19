import crypto from "crypto";

// MAC/BSSID anonymization — on by default per the WIFIRADAR privacy spec:
// "AA:BB:CC:••:••:••", full MAC only when a client explicitly asks for it
// (see websocket query param handling in web-admin-server.ts).
export function anonymizeMac(mac: string): string {
  const parts = mac.split(":");
  if (parts.length !== 6) return mac;
  return `${parts[0]}:${parts[1]}:${parts[2]}:••:••:••`;
}

// A stable, one-way identifier for a real MAC — used as the frontend's
// object-identity key. The anonymized display string alone can't serve
// that purpose: two different real APs from the same vendor collapse to
// the same "AA:BB:CC:••:••:••" once anonymized, which would make the
// frontend silently merge two distinct devices into one node.
export function hashMac(mac: string): string {
  return crypto.createHash("sha256").update(mac).digest("hex").slice(0, 12);
}
