import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import QRCode from "qrcode";

const execFileAsync = promisify(execFile);

export type NetworkInfo = {
  lanIp: string | null;
  tailscaleHostname: string | null; // short form, e.g. "akbal-pi"
  tailscaleFqdn: string | null; // "akbal-pi.border-bonito.ts.net"
  tailscaleIp: string | null;
  port: number;
  url: string; // what actually gets encoded into the QR — prefers the
  // Tailscale DNS name (stable, works from anywhere on the tailnet) over
  // the LAN IP (only reachable on the same network, and can change on DHCP
  // renewal)
};

function getLanIp(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

async function getTailscaleInfo(): Promise<{
  hostname: string | null;
  fqdn: string | null;
  ip: string | null;
}> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--self", "--json"], {
      timeout: 5000,
    });
    const data = JSON.parse(stdout);
    const self = data.Self || {};
    const fqdn = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : null;
    const hostname =
      typeof self.HostName === "string" ? self.HostName : fqdn ? fqdn.split(".")[0] : null;
    const ip = Array.isArray(self.TailscaleIPs)
      ? self.TailscaleIPs.find((addr: string) => !addr.includes(":")) || null
      : null;
    return { hostname, fqdn, ip };
  } catch (err) {
    console.warn("[network-info] tailscale status failed:", err);
    return { hostname: null, fqdn: null, ip: null };
  }
}

export async function getNetworkInfo(port: number): Promise<NetworkInfo> {
  const [lanIp, tailscale] = await Promise.all([getLanIp(), getTailscaleInfo()]);
  const host = tailscale.fqdn || tailscale.ip || lanIp || "localhost";
  return {
    lanIp,
    tailscaleHostname: tailscale.hostname,
    tailscaleFqdn: tailscale.fqdn,
    tailscaleIp: tailscale.ip,
    port,
    url: `http://${host}:${port}`,
  };
}

const QR_PATH = path.join(os.tmpdir(), "akbal-connect-qr.png");

// Regenerated every time the "Conexión web" menu screen is opened (see
// network-info-mode.ts) — the device has no way to detect "the IP just
// changed" on its own, so a fresh render on menu-entry is what keeps this
// from ever going stale, rather than a background watcher.
export async function generateConnectQr(url: string): Promise<string> {
  await QRCode.toFile(QR_PATH, url, {
    type: "png",
    width: 240,
    margin: 1,
    color: { dark: "#50ff78ff", light: "#0b0d0fff" },
  });
  return QR_PATH;
}
