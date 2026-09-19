import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";

const execFileAsync = promisify(execFile);

export type SystemStats = {
  cpuPercent: number;
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
  const [ram, disk] = await Promise.all([getRam(), getDisk()]);
  return { cpuPercent: getCpuPercent(), ram, disk };
}
