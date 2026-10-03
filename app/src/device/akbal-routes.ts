import path from "path";
import * as fs from "fs";
import Router from "@koa/router";
import { driveDb } from "../wardrive/drive-db";
import { dataDir } from "../utils/dir";
import { buildSessionFiles, SessionInput } from "../akbal/session-files";
import { buildManifest } from "../akbal/format";
import { packPackage, readPackage } from "../akbal/package";
import { SharedSessions } from "../akbal/shared-store";

// Imported sessions live apart from this Pi's own captures.
export const sharedSessions = new SharedSessions(path.join(dataDir, "shared-sessions"));
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// Reads one of this Pi's sessions into the package's input shape.
const sessionInput = (id: string, includeCredentials: boolean): SessionInput | null => {
  const row = driveDb.sessions().find((s) => s.id === id);
  if (!row) return null;
  const handshakes = driveDb
    .listHandshakes()
    .filter((h) => h.session_id === id)
    .map((h) => ({
      ssid: h.ssid,
      bssid: h.bssid,
      method: h.method,
      capturedAt: h.captured_at,
      password: h.password,
      capFile: h.cap_file,
      hashFile: h.hash_file,
    }));
  const capFiles: Record<string, Buffer> = {};
  if (includeCredentials) {
    for (const h of handshakes) {
      for (const file of [h.capFile, h.hashFile]) {
        if (file && fs.existsSync(file)) capFiles[`captures/${path.basename(file)}`] = fs.readFileSync(file);
      }
    }
  }
  return {
    drive: {
      id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      distanceM: row.distance_m,
      points: row.points,
      networks: row.networks,
      handshakes: row.handshakes,
    },
    track: driveDb.trackPoints(id).map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, speedKmh: null, heading: null, hdop: null })),
    networks: driveDb.sessionNetworks(id).map((n) => ({
      ssid: n.ssid,
      bssid: n.bssid,
      security: n.security,
      channel: n.channel,
      bestRssi: n.best_rssi,
      lat: n.lat,
      lon: n.lon,
      firstSeen: n.first_seen,
    })),
    handshakes,
    capFiles,
    includeCredentials,
  };
};

const readBody = (req: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("el archivo supera 200 MB"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export const registerAkbalRoutes = (router: Router): void => {
  // Downloads one session as a .akbal package. Credentials are included by
  // default; credentials=0 leaves passwords and handshake captures out.
  router.get("/api/wardrive/drive/sessions/:id/export.akbal", (ctx) => {
    const includeCredentials = String(ctx.query.credentials ?? "1") !== "0";
    const input = sessionInput(ctx.params.id, includeCredentials);
    if (!input) {
      ctx.status = 404;
      ctx.body = { error: "sesión no encontrada" };
      return;
    }
    const files = buildSessionFiles(input);
    const manifest = buildManifest(files, { credentials: includeCredentials, origin: "akbal-pi" });
    const bytes = packPackage(manifest, files);
    ctx.set("Content-Disposition", `attachment; filename="${ctx.params.id}.akbal"`);
    ctx.type = "application/octet-stream";
    ctx.body = bytes;
  });

  // Loads a .akbal package as a shared session. Nothing is stored unless the
  // package verifies; a session id already present is refused, not overwritten.
  router.post("/api/wardrive/drive/sessions/import", async (ctx) => {
    try {
      const bytes = await readBody(ctx.req);
      const { manifest, files } = readPackage(bytes);
      const drive = JSON.parse(files["drive.json"]?.toString("utf8") || "null");
      if (!drive?.id) throw new Error("el paquete no trae la sesión");
      sharedSessions.save(drive.id, files, { origin: manifest.origin, credentials: manifest.credentials });
      ctx.body = { ok: true, id: drive.id };
    } catch (err: any) {
      ctx.status = 400;
      ctx.body = { error: err?.message || String(err) };
    }
  });

  router.get("/api/wardrive/drive/shared", (ctx) => {
    ctx.body = sharedSessions.list();
  });

  router.post("/api/wardrive/drive/shared/delete", (ctx) => {
    const id = String((ctx.request.body as any)?.id || "");
    if (!sharedSessions.remove(id)) {
      ctx.status = 404;
      ctx.body = { error: "sesión compartida no encontrada" };
      return;
    }
    ctx.body = { ok: true };
  });
};

