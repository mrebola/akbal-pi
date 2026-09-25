import { connect, Socket } from "net";
import { EventEmitter } from "events";

class PiSugarBattery extends EventEmitter {
  private client: Socket | null = null;
  private batteryLevel: number = 0;
  private batteryCharging: boolean | null = null;
  private connected: boolean = false;
  private interval: NodeJS.Timeout | null = null;

  constructor() {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = connect(8423, "0.0.0.0", () => {
        console.log("Connected to battery service");
        this.connected = true;
        this.interval = setInterval(() => {
          if (this.connected && this.client) {
            this.client.write("get battery\n");
            // Same PiSugar daemon protocol, a second known command — used
            // by the web admin UI's battery indicator (see
            // device/web-admin-server.ts). Harmless if the daemon doesn't
            // support it: the response just won't match either prefix
            // below and gets ignored.
            this.client.write("get battery_charging\n");
          }
        }, 5000);
        resolve();
      });

      this.client.on("data", (data: Buffer) => {
        const message = data.toString();
        if (message.startsWith("battery:")) {
          const level = parseInt(message.split(":")[1], 10);
          // The PiSugar daemon answers even on hardware failure (e.g.
          // "battery: I2C not connected") — parseInt gives NaN there. Keep
          // the last good reading instead of poisoning the cache with NaN
          // (JSON.stringify turns NaN into null and the web UI renders
          // "null%").
          if (!Number.isNaN(level)) {
            this.batteryLevel = level;
            this.emit("batteryLevel", level);
          }
        } else if (message.startsWith("battery_charging:")) {
          const charging = message.split(":")[1].trim() === "true";
          this.batteryCharging = charging;
          this.emit("batteryCharging", charging);
        }
      });

      this.client.on("error", (err: Error) => {
        console.error("Battery service error:", err);
        this.connected = false;
        if (this.interval) clearInterval(this.interval);
        reject(err);
      });

      this.client.on("end", () => {
        console.log("Disconnected from battery service");
        this.connected = false;
        if (this.interval) clearInterval(this.interval);
      });
    });
  }

  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.connected = false;
    }
  }

  getBatteryLevel(): number {
    return this.batteryLevel;
  }

  // null until the daemon has answered at least one "get battery_charging"
  // — some PiSugar firmware/daemon versions don't support it.
  getBatteryCharging(): boolean | null {
    return this.batteryCharging;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export default PiSugarBattery;
