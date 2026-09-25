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
  verified: boolean; // handshake validated with aircrack (v2 lab workflow)
  // The password that cracked this handshake (only written on a verified
  // aircrack match) — surfaced in the past-sessions browser behind the eye
  // toggle. Device-local (~/wardrive-sessions, outside the git tree).
  password?: string;
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
        verified: false,
        password: undefined,
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

  // Per-target info.txt — a human-readable summary of what this handshake
  // is, who it belongs to and what we have. Written on every target update
  // so it stays current (captured/verified state, files present).
  writeTargetInfo(bssid: string, passwordTested?: string): void {
    const t = this.targets.get(bssid);
    if (!t) return;
    const lines: string[] = [];
    lines.push("═══════════════════════════════════════════════");
    lines.push(" WARDRIVE — resumen de auditoría");
    lines.push(` Sesión: ${this.id}`);
    lines.push(` Fecha:  ${new Date(t.startedAt || this.startedAt).toISOString()}`);
    lines.push("═══════════════════════════════════════════════");
    lines.push("");
    lines.push("RED OBJETIVO");
    lines.push(`  SSID:        ${t.ssid || "(oculta / no visto)"}`);
    lines.push(`  BSSID (MAC): ${t.bssid}`);
    lines.push(`  Canal:       ${t.channel}`);
    lines.push(`  Seguridad:   WPA/WPA2 (handshake 4-way capturado)`);
    lines.push("");
    lines.push("RESULTADO");
    lines.push(`  Estado:      ${t.status}`);
    lines.push(`  Método:      ${t.method || "n/d"}`);
    lines.push(`  Intentos:    ${t.attempts}`);
    lines.push(`  Validado:    ${t.verified ? "SÍ — handshake completo y crackeable (KEY FOUND)" : "no verificado con contraseña"}`);
    if (t.error) lines.push(`  Error:       ${t.error}`);
    lines.push("");
    lines.push("CONTRASEÑA PROBADA");
    lines.push(`  ${passwordTested ? passwordTested : "(no se probó ninguna)"}`);
    lines.push("");
    lines.push("CONTRASEÑA ENCONTRADA");
    lines.push(`  ${t.password ? t.password : "(ninguna — handshake no crackeado aún)"}`);
    lines.push("");
    lines.push("ARCHIVOS");
    if (t.files.length === 0) {
      lines.push("  (ninguno)");
    } else {
      for (const f of t.files) {
        const base = path.basename(f);
        const size = this.fileSize(path.join(this.dir, base));
        lines.push(`  ${base}  (${size})`);
      }
    }
    lines.push("");
    lines.push("QUÉ ES ESTE HANDSHAKE");
    lines.push("  Contiene los frames EAPOL M1-M4 del 4-way handshake WPA2");
    lines.push("  entre el AP y un cliente que se reconectó tras un deauth.");
    lines.push("  Es material crackeable offline: el .hc22000 es formato");
    lines.push("  hashcat (-m 22000) y el .cap se puede procesar con aircrack-ng.");
    lines.push("  NO es la contraseña de la red: solo la prueba de que dos");
    lines.push("  pares de llaves se intercambiaron — cracking aparte.");
    try {
      fs.writeFileSync(path.join(this.dir, `${t.bssid.replace(/:/g, "").toLowerCase()}-info.txt`), lines.join("\n") + "\n");
    } catch {
      // Info file is nice-to-have, never fatal.
    }
  }

  private fileSize(p: string): string {
    try {
      const s = fs.statSync(p).size;
      return s > 1024 * 1024 ? `${(s / 1024 / 1024).toFixed(1)} MB` : `${Math.round(s / 1024)} KB`;
    } catch {
      return "?";
    }
  }

  addTargetFile(bssid: string, file: string): void {
    const t = this.targets.get(bssid);
    if (!t || t.files.includes(file)) return;
    t.files.push(file);
    this.writeMeta();
  }

  // Record the password that actually cracked this handshake. Only called
  // on an aircrack KEY FOUND, so the field's existence = verified crack.
  setFoundPassword(bssid: string, password: string): void {
    const t = this.targets.get(bssid);
    if (!t) return;
    t.password = password;
    this.writeMeta();
  }

  // Passwords per target for the /sessions endpoint (past-session browser).
  foundPasswords(): { bssid: string; ssid: string; password: string }[] {
    const out: { bssid: string; ssid: string; password: string }[] = [];
    for (const t of this.targets.values()) {
      if (t.password && t.status === "captured") out.push({ bssid: t.bssid, ssid: t.ssid, password: t.password });
    }
    return out;
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
      // hcxpcapngtool wording (6.3.5, verified on the device):
      //   "EAPOL pairs written to 22000 hash file...: 2 (RC checked)"
      //   "PMKID written to 22000 hash file...: 1 (RC checked)"
      // Older builds print "EAPOL packets written ..." — kept for compat.
      const eapolWritten = /EAPOL pairs written to .+?:\s*(\d+)/i.exec(text)
        || /(\d+)\s+EAPOL packets written/i.exec(text)
        || /EAPOL packets written to .+?:\s*(\d+)/i.exec(text);
      const written = eapolWritten
        ? parseInt(eapolWritten[1] || eapolWritten[2] || "0", 10)
        : 0;
      const pmkidWritten = /PMKID written to .+?:\s*(\d+)/i.exec(text);
      const hasCapture = written > 0 || (pmkidWritten ? parseInt(pmkidWritten[1], 10) > 0 : false);
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