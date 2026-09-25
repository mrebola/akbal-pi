import { display } from "../device/display";
import Battery from "../device/battery";

// Module-level singleton — set once startBatteryStatus() runs (from
// index.ts, at boot). Lets other things that just need a battery *reading*
// (the web admin UI's /api/status, device/web-admin-server.ts) reuse the
// one PiSugar connection instead of opening a second one.
let sharedBattery: Battery | null = null;

/**
 * Connect to the battery service and forward level changes to the display
 * (with a colour that reflects how full the battery is).
 */
export function startBatteryStatus(): Battery {
  const battery = new Battery();
  sharedBattery = battery;
  battery.connect().catch(() => {
    console.log("Failed to reconnect to battery service.");
  });
  battery.addListener("batteryLevel", (data: number) => {
    let color = "#34d351";
    if (data <= 30) {
      color = "#ff7700";
    }
    if (data <= 10) {
      color = "#ff0000";
    }
    display({
      battery_level: data,
      battery_color: color,
    });
  });
  return battery;
}

export function getBatteryReading(): { level: number | null; charging: boolean | null; connected: boolean } {
  if (!sharedBattery) {
    return { level: null, charging: null, connected: false };
  }
  // level: null = unreadable (no PiSugar daemon, or the daemon can't reach
  // the I2C chip). Zero is NOT a valid "unreadable" marker — a real 0%
  // battery is plausible — so treat the initial/never-updated 0 the same
  // as garbage: the web UI renders null as "N/A".
  const level = sharedBattery.getBatteryLevel();
  return {
    level: Number.isFinite(level) && level > 0 ? level : null,
    charging: sharedBattery.getBatteryCharging(),
    connected: sharedBattery.isConnected(),
  };
}
