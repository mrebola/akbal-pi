import fs from "fs";
import path from "path";

const envPath = path.join(__dirname, "../..", ".env");

// Updates (or appends) a single KEY=value line in the project's .env file,
// so runtime changes (e.g. switching the active LLM model by voice) survive
// a service restart. Leaves every other line untouched.
export function persistEnvVar(key: string, value: string): void {
  try {
    const content = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf8")
      : "";
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^#?\\s*${key}=.*$`, "m");
    const nextContent = pattern.test(content)
      ? content.replace(pattern, line)
      : `${content.replace(/\n+$/, "")}\n${line}\n`;
    fs.writeFileSync(envPath, nextContent);
  } catch (error: any) {
    console.error(`[EnvFile] Failed to persist ${key}:`, error.message);
  }
}
