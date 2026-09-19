import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

// Where USB storage partitions get mounted if they aren't already (see
// ensureMounted) — created on demand, one subdirectory per partition.
const USB_MOUNT_ROOT = "/mnt/akbal-usb";

export type UsbDevice = {
  bus: string;
  device: string;
  id: string;
  description: string;
};

// `lsusb`'s built-in root hubs aren't "a device someone plugged in" — same
// vendor:product ID (1d6b = Linux Foundation) on every Pi, filtered out so
// the list only shows what's actually been connected.
const ROOT_HUB_ID_PREFIX = "1d6b:";

export async function listUsbDevices(): Promise<UsbDevice[]> {
  try {
    const { stdout } = await execFileAsync("lsusb");
    const devices: UsbDevice[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^Bus (\d+) Device (\d+): ID ([0-9a-f]{4}:[0-9a-f]{4})\s*(.*)$/i);
      if (!match) continue;
      const [, bus, device, id, description] = match;
      if (id.toLowerCase().startsWith(ROOT_HUB_ID_PREFIX)) continue;
      devices.push({ bus, device, id, description: description.trim() });
    }
    return devices;
  } catch (err) {
    console.warn("[usb] listUsbDevices failed:", err);
    return [];
  }
}

type LsblkNode = {
  name: string;
  label: string | null;
  mountpoint: string | null;
  size: string;
  rm: boolean;
  tran: string | null;
  type: string;
  children?: LsblkNode[];
};

export type UsbVolume = {
  name: string; // block device name, e.g. "sda1" — the handle used by the other functions below
  label: string;
  mountPath: string;
  sizeLabel: string;
  mounted: boolean;
};

function flattenUsbPartitions(nodes: LsblkNode[], inheritedTran: string | null = null): LsblkNode[] {
  const result: LsblkNode[] = [];
  for (const node of nodes) {
    const tran = node.tran || inheritedTran;
    if (node.type === "part" && tran === "usb") {
      result.push(node);
    }
    if (node.children) {
      result.push(...flattenUsbPartitions(node.children, tran));
    }
  }
  return result;
}

export async function listUsbVolumes(): Promise<UsbVolume[]> {
  try {
    const { stdout } = await execFileAsync("lsblk", [
      "-J",
      "-o",
      "NAME,LABEL,MOUNTPOINT,SIZE,RM,TRAN,TYPE",
    ]);
    const data = JSON.parse(stdout);
    const partitions = flattenUsbPartitions(data.blockdevices || []);
    return partitions.map((p) => ({
      name: p.name,
      label: p.label || p.name,
      mountPath: p.mountpoint || path.join(USB_MOUNT_ROOT, p.name),
      sizeLabel: p.size,
      mounted: Boolean(p.mountpoint),
    }));
  } catch (err) {
    console.warn("[usb] listUsbVolumes failed:", err);
    return [];
  }
}

// Most USB drives don't auto-mount on a headless service (no desktop
// session for udisks2 to hand it to), so this mounts on demand instead —
// `akbal` already has passwordless sudo on this device (see docs/wifi.md's
// nmcli section for how that was confirmed), used the same way here,
// scoped to just mkdir/mount/umount.
export async function ensureMounted(
  volumeName: string,
): Promise<{ ok: boolean; mountPath?: string; error?: string }> {
  const volumes = await listUsbVolumes();
  const volume = volumes.find((v) => v.name === volumeName);
  if (!volume) {
    return { ok: false, error: "Volumen no encontrado — ¿sigue conectado?" };
  }
  if (volume.mounted) {
    return { ok: true, mountPath: volume.mountPath };
  }
  try {
    await execFileAsync("sudo", ["-n", "mkdir", "-p", volume.mountPath]);
    await execFileAsync("sudo", ["-n", "mount", `/dev/${volumeName}`, volume.mountPath]);
    // Readable by the web admin server (runs as akbal) regardless of the
    // filesystem's own default permissions.
    await execFileAsync("sudo", ["-n", "chmod", "-R", "a+rX", volume.mountPath]).catch(() => {});
    return { ok: true, mountPath: volume.mountPath };
  } catch (err: any) {
    const message = err?.stderr || err?.message || String(err);
    console.warn(`[usb] ensureMounted(${volumeName}) failed:`, message);
    return { ok: false, error: message };
  }
}

// Unmounts the partition (flushing any buffered writes) so it's safe to
// physically unplug — same passwordless-sudo scope as ensureMounted above.
// Volumes lsblk never reports as mounted (or already unplugged) are treated
// as already-safe rather than an error, since the end state the caller
// cares about ("safe to remove") already holds.
export async function ejectVolume(
  volumeName: string,
): Promise<{ ok: boolean; error?: string }> {
  const volumes = await listUsbVolumes();
  const volume = volumes.find((v) => v.name === volumeName);
  if (!volume || !volume.mounted) {
    return { ok: true };
  }
  try {
    await execFileAsync("sudo", ["-n", "umount", volume.mountPath]);
    return { ok: true };
  } catch (err: any) {
    const message = err?.stderr || err?.message || String(err);
    console.warn(`[usb] ejectVolume(${volumeName}) failed:`, message);
    return { ok: false, error: message };
  }
}

export type UsbFileEntry = {
  name: string;
  isDir: boolean;
  size: number;
  mtime: string;
};

// Resolves a volume + a user-supplied relative path to a real filesystem
// path, refusing anything that would escape the volume's own mount root
// (the only real security boundary here — everything past this point
// trusts the path).
function resolveSafePath(mountPath: string, relativePath: string): string | null {
  const cleaned = (relativePath || "").replace(/^\/+/, "");
  const resolved = path.resolve(mountPath, cleaned);
  const root = path.resolve(mountPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return resolved;
}

export async function listFiles(
  mountPath: string,
  relativePath: string,
): Promise<{ ok: boolean; entries?: UsbFileEntry[]; error?: string }> {
  const target = resolveSafePath(mountPath, relativePath);
  if (!target) return { ok: false, error: "Ruta inválida" };
  try {
    const names = await fs.promises.readdir(target);
    const entries: UsbFileEntry[] = [];
    for (const name of names) {
      try {
        const stat = await fs.promises.stat(path.join(target, name));
        entries.push({
          name,
          isDir: stat.isDirectory(),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch {
        // Unreadable entry (broken symlink, permissions) — skip it rather
        // than failing the whole listing.
      }
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { ok: true, entries };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function resolveFilePath(mountPath: string, relativePath: string): string | null {
  return resolveSafePath(mountPath, relativePath);
}

export async function findVolume(volumeName: string): Promise<UsbVolume | null> {
  const volumes = await listUsbVolumes();
  return volumes.find((v) => v.name === volumeName) || null;
}

export type UsbWifiAdapter = {
  iface: string;
  chipset: string;
};

// The Pi's own onboard wifi (brcmfmac, see docs/wifi.md) isn't a USB
// device — only interfaces whose /sys/class/net/<iface>/device symlink
// resolves through a "usb" path in its chain are something plugged in.
export async function listUsbWifiAdapters(): Promise<UsbWifiAdapter[]> {
  const netDir = "/sys/class/net";
  const adapters: UsbWifiAdapter[] = [];
  try {
    const ifaces = await fs.promises.readdir(netDir);
    for (const iface of ifaces) {
      const hasWireless = await fs.promises
        .access(path.join(netDir, iface, "wireless"))
        .then(() => true)
        .catch(() => false);
      if (!hasWireless) continue;
      const devicePath = path.join(netDir, iface, "device");
      const realDevicePath = await fs.promises.realpath(devicePath).catch(() => "");
      if (!realDevicePath.includes(`${path.sep}usb`)) continue;
      let chipset = "desconocido";
      try {
        const driverLink = await fs.promises.realpath(path.join(devicePath, "driver"));
        chipset = path.basename(driverLink);
      } catch {
        // No driver symlink (unlikely but not fatal) — leave "desconocido".
      }
      adapters.push({ iface, chipset });
    }
  } catch (err) {
    console.warn("[usb] listUsbWifiAdapters failed:", err);
  }
  return adapters;
}
