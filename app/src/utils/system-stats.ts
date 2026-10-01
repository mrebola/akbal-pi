import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";

const execFileAsync = promisify(execFile);

export type SystemStats = {
  cpuPercent: number;
  cpuTempC: number | null;
  ram: { usedBytes: number; totalBytes: number; percent: number };
  disk: { usedBytes: number; totalBytes: number; percent: number };
};

// A 1-minute load average isn't an instantaneous CPU%, but it's a cheap,
// non-blocking read — good enough for a topbar indicator that only
// refreshes once a minute anyway (no /proc/stat before/after sampling).
function getCpuPercent(): number {
  const cores = os.cpus().length || 1;
  const load = os.loadavg()[0];
  return Math.min(100, Math.round((load / cores) * 100));
}

async function getRam(): Promise<{ usedBytes: number; totalBytes: number; percent: number }> {
  try {
    const meminfo = await fs.promises.readFile("/proc/meminfo", "utf8");
    const totalKb = parseInt(/MemTotal:\s+(\d+)/.exec(meminfo)?.[1] || "0", 10);
    const availableKb = parseInt(/MemAvailable:\s+(\d+)/.exec(meminfo)?.[1] || "0", 10);
    if (!totalKb) throw new Error("MemTotal missing");
    const totalBytes = totalKb * 1024;
    const usedBytes = (totalKb - availableKb) * 1024;
    return { usedBytes, totalBytes, percent: Math.round((usedBytes / totalBytes) * 100) };
  } catch {
    // Non-Linux dev machine, or /proc unreadable — os.freemem() is less
    // accurate (doesn't count reclaimable cache as available) but works
    // everywhere.
    const totalBytes = os.totalmem();
    const usedBytes = totalBytes - os.freemem();
    return { usedBytes, totalBytes, percent: Math.round((usedBytes / totalBytes) * 100) };
  }
}

// Raspberry Pi (and most Linux SBCs) expose the SoC temperature as a plain
// millidegree-C integer file — no vcgencmd dependency needed. null on
// anything else (dev machine, a board without this thermal zone).
async function getCpuTempC(): Promise<number | null> {
  try {
    const raw = await fs.promises.readFile("/sys/class/thermal/thermal_zone0/temp", "utf8");
    const milliC = parseInt(raw.trim(), 10);
    return Number.isFinite(milliC) ? Math.round(milliC / 100) / 10 : null;
  } catch {
    return null;
  }
}

async function getDisk(): Promise<{ usedBytes: number; totalBytes: number; percent: number }> {
  try {
    const { stdout } = await execFileAsync("df", ["-k", "/"]);
    const lines = stdout.trim().split("\n");
    const parts = lines[lines.length - 1].trim().split(/\s+/);
    const totalBytes = parseInt(parts[1], 10) * 1024;
    const usedBytes = parseInt(parts[2], 10) * 1024;
    return { usedBytes, totalBytes, percent: Math.round((usedBytes / totalBytes) * 100) };
  } catch (err) {
    console.warn("[system-stats] df failed:", err);
    return { usedBytes: 0, totalBytes: 0, percent: 0 };
  }
}

export async function getSystemStats(): Promise<SystemStats> {
  const [ram, disk, cpuTempC] = await Promise.all([getRam(), getDisk(), getCpuTempC()]);
  return { cpuPercent: getCpuPercent(), cpuTempC, ram, disk };
}

// First non-internal IPv4 — "the IP" for a LAN admin page showing the device
// its own address (helps whoever's troubleshooting "why can't I reach
// Akbal"). Picks the first match deterministically (sorted by interface
// name) rather than an arbitrary object-iteration order.
export function getLocalIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces).sort()) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}
