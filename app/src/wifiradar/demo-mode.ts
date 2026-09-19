import { Aggregator } from "./aggregator";
import { RawFrameEvent, SecurityKind } from "./types";

// Feeds the exact same Aggregator.ingest() path real AR9271 capture does —
// event detection (NEW_AP, OPEN_NETWORK, WEP, DUPLICATE_SSID, DEAUTH_BURST,
// AP_LOST...) is identical in demo mode, not a separate mocked-up version
// of it. Only the frame source is fake.
const SECURITIES: SecurityKind[] = ["WPA2/3", "WPA2/3", "WPA2/3", "WPA", "OPEN", "WEP"];
const SSID_POOL = [
  "CasaVerde_5G",
  "RedFamiliar",
  "Oficina_Norte",
  "CyberCafe_WiFi",
  "Vecino_2.4G",
  "TP-LINK_8A21",
  "INFINITUM_A3F2",
  "Totalplay-DEMO",
  "MiFi_Portable",
  "GuestNetwork",
  "IoT_Bridge",
  "Almacen_WiFi",
  "Bodega_Central",
  "Patio_Trasero",
  "RedInvitados",
];
const VENDOR_PREFIXES = ["B8:27:EB", "3C:5A:B4", "F4:F5:D8", "00:1A:11", "AC:63:BE", "F8:8F:CA", "90:16:BA"];
const CHANNELS_24 = [1, 3, 6, 9, 11];

function randomMac(): string {
  const prefix = VENDOR_PREFIXES[Math.floor(Math.random() * VENDOR_PREFIXES.length)];
  const rest = Array.from({ length: 3 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join(":");
  return `${prefix}:${rest}`.toUpperCase();
}

type DemoAp = {
  bssid: string;
  ssid: string;
  channel: number;
  security: SecurityKind;
  baseRssi: number;
  clients: string[];
};

export class DemoGenerator {
  private aps: DemoAp[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private churnTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private aggregator: Aggregator) {}

  start(): void {
    this.spawnInitialAps();
    this.tickTimer = setInterval(() => this.tick(), 350);
    this.churnTimer = setInterval(() => this.churn(), 8000);
  }

  private spawnInitialAps(): void {
    const count = 8 + Math.floor(Math.random() * 5);
    const shuffled = [...SSID_POOL].sort(() => Math.random() - 0.5).slice(0, count);
    this.aps = shuffled.map((ssid, i) => ({
      bssid: randomMac(),
      ssid,
      channel: CHANNELS_24[i % CHANNELS_24.length],
      security: SECURITIES[Math.floor(Math.random() * SECURITIES.length)],
      baseRssi: -40 - Math.floor(Math.random() * 50),
      clients: Array.from({ length: Math.floor(Math.random() * 4) }, () => randomMac()),
    }));
  }

  private tick(): void {
    const now = Date.now();
    for (const ap of this.aps) {
      const jitter = Math.floor(Math.random() * 8) - 4;
      const rssi = Math.max(-95, Math.min(-30, ap.baseRssi + jitter));
      const beacon: RawFrameEvent = {
        kind: "beacon",
        bssid: ap.bssid,
        ssid: ap.ssid,
        channel: ap.channel,
        rssi,
        security: ap.security,
        timestamp: now,
      };
      this.aggregator.ingest(beacon);
      for (const client of ap.clients) {
        if (Math.random() < 0.5) {
          this.aggregator.ingest({
            kind: "data",
            bssid: ap.bssid,
            client,
            rssi: Math.max(-95, Math.min(-30, rssi - 5)),
            timestamp: now,
          });
        }
      }
    }
    // Rare simulated deauth burst — exercises the DEAUTH_BURST alert path
    // in demo mode too, same threshold/cooldown logic as real capture.
    if (Math.random() < 0.01 && this.aps.length > 0) {
      const target = this.aps[Math.floor(Math.random() * this.aps.length)];
      const client = target.clients[0] || randomMac();
      for (let i = 0; i < 12; i++) {
        this.aggregator.ingest({ kind: "deauth", bssid: target.bssid, client, timestamp: now });
      }
    }
  }

  private churn(): void {
    if (this.aps.length < 14 && Math.random() < 0.3) {
      const ssid = SSID_POOL[Math.floor(Math.random() * SSID_POOL.length)];
      this.aps.push({
        bssid: randomMac(),
        ssid: `${ssid}_${Math.floor(Math.random() * 99)}`,
        channel: CHANNELS_24[Math.floor(Math.random() * CHANNELS_24.length)],
        security: SECURITIES[Math.floor(Math.random() * SECURITIES.length)],
        baseRssi: -50 - Math.floor(Math.random() * 40),
        clients: [],
      });
    } else if (this.aps.length > 6 && Math.random() < 0.2) {
      // Just stop simulating this AP — it naturally ages into AP_LOST and
      // later gets pruned by aggregator.sweep(), same as a real AP being
      // unplugged, instead of a special "remove" path.
      this.aps.splice(Math.floor(Math.random() * this.aps.length), 1);
    }
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.churnTimer) clearInterval(this.churnTimer);
    this.tickTimer = null;
    this.churnTimer = null;
  }
}
