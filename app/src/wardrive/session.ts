import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { AttackStep } from "./types";

const execFileAsync = promisify(execFile);

// Session persistence: every wardrive session writes ONLY into its own
// folder under ~/wardrive-sessions/<id>/. Handshakes (.pcapng/.hc22000),
// logs and a summary live here and are never committed to the repo —
// this path lives entirely outside the git tree on the device.
export const SESSIONS_ROOT = path.join(process.env.HOME || "/home/akbal", "wardrive-sessions");

export type SessionTargetSnapshot = {
  bssid: string;
  ssid: string;
  channel: number;
  status: string;
  method: string;
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string;
  files: string[];
};

// Step-by-step progress for UI reconnection: full history of what happened.
export type AttackProgressEntry = {
  ts: number;
  step: AttackStep;
  message: string;
  command?: string;
  output?: string;
};

export class WardriveSession {
  readonly id: string;
  readonly dir: string;
  readonly startedAt: number;
  endedAt: number | null = null;
  private targets = new Map<string, SessionTargetSnapshot>();
  private progressLog = new Map<string, AttackProgressEntry[]>(); // bssid -> entries

  constructor() {
    this.startedAt = Date.now();
    // 20260919-024533 — timestamp + nothing else: SSIDs can contain slashes
    // and other filesystem-hostile characters, so they never go in the path.
    this.id = new Date(this.startedAt)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+$/, "")
      .replace("T", "-");
    this.dir = path.join(SESSIONS_ROOT, this.id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.writeMeta();
  }

  // Record a step for UI reconnection. Written to progress-<bssid>.jsonl
  // and kept in memory for the live session.
  addProgress(bssid: string, step: AttackStep, message: string, command?: string, output?: string): void {
    const entry: AttackProgressEntry = { ts: Date.now(), step, message, command, output };
    const list = this.progressLog.get(bssid) || [];
    list.push(entry);
    this.progressLog.set(bssid, list);
    // Persist as JSONL (one JSON object per line, append-only).
    try {
      const fname = path.join(this.dir, `progress-${bssid.replace(/:/g, "").toLowerCase()}.jsonl`);
      fs.appendFileSync(fname, JSON.stringify(entry) + "\n");
    } catch {
      // Progress logs are nice-to-have, never fatal.
    }
  }

  // Load persisted progress for a target (UI reopens mid-attack).
  getProgress(bssid: string): AttackProgressEntry[] {
    const fname = path.join(this.dir, `progress-${bssid.replace(/:/g, "").toLowerCase()}.jsonl`);
    try {
      const lines = fs.readFileSync(fname, "utf8").split("\n").filter(Boolean);
      return lines.map((l) => JSON.parse(l));
    } catch {
      return this.progressLog.get(bssid) || [];
    }
  }

  ensureTarget(bssid: string, ssid: string, channel: number): void {
    if (!this.targets.has(bssid)) {
      this.targets.set(bssid, {
        bssid,
        ssid,
        channel,
        status: "idle",
        method: "",
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        error: "",
        files: [],
      });
      this.writeMeta();
    }
  }

  updateTarget(bssid: string, patch: Partial<SessionTargetSnapshot>): void {
    const t = this.targets.get(bssid);
    if (!t) return;
    Object.assign(t, patch);
    this.writeMeta();
  }

  addTargetFile(bssid: string, file: string): void {
    const t = this.targets.get(bssid);
    if (!t || t.files.includes(file)) return;
    t.files.push(file);
    this.writeMeta();
  }

  hasCaptured(bssid: string): boolean {
    return this.targets.get(bssid)?.status === "captured";
  }

  // hcxpcapngtool converts whatever hcxdumptool caught into .hc22000 hashes
  // AND tells us whether an actual EAPOL/PMKID frame is in there (exit 0 +
  // "frames written" vs "no handshakes written" wording). The .hc22000 file
  // is the standard crack-ready format for later offline analysis; the
  // pcapng is kept as the raw evidence.
  async convertCapture(pcapngPath: string): Promise<{ hasCapture: boolean; hashFile: string | null }> {
    // Accepts both hcxdumptool .pcapng and airodump-ng .cap inputs.
    const hashPath = pcapngPath.replace(/\.(pcapng|cap)$/i, ".hc22000");
    try {
      const { stdout, stderr } = await execFileAsync("hcxpcapngtool", [
        "-o", hashPath,
        pcapngPath,
      ]);
      const text = `${stdout}\n${stderr}`;
      // hcxpcapngtool prints "written" counts; 0 EAPOL messages means the
      // capture ran but nothing usable was in it.
      const eapolWritten = /(\d+)\s+EAPOL packets written|EAPOL packets written to .+: (\d+)/i.exec(text);
      const written = eapolWritten
        ? parseInt(eapolWritten[1] || eapolWritten[2] || "0", 10)
        : 0;
      const hasCapture = written > 0 || /PMKID.*written\s*:\s*[1-9]/i.test(text);
      return { hasCapture, hashFile: hasCapture ? path.basename(hashPath) : null };
    } catch {
      return { hasCapture: false, hashFile: null };
    }
  }

  private writeMeta(): void {
    const meta = {
      id: this.id,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      targets: [...this.targets.values()],
    };
    try {
      fs.writeFileSync(path.join(this.dir, "session.json"), JSON.stringify(meta, null, 2));
    } catch (err) {
      console.warn("[wardrive] session.json write failed:", err);
    }
  }

  end(): void {
    if (this.endedAt) return;
    this.endedAt = Date.now();
    this.writeMeta();
  }
}