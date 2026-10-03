// Turns one driving session's data into the package's files. Pure: the caller
// reads the database and the session folder, this only decides what goes in.
// Without credentials, passwords and capture files stay out; the handshake
// rows still say which network was captured, when and how.

export interface SessionInput {
  drive: { id: string; startedAt: number; endedAt: number | null; distanceM: number; points: number; networks: number; handshakes: number };
  track: { ts: number; lat: number; lon: number; speed_kmh: number | null; heading: number | null; hdop: number | null }[];
  networks: { ssid: string; bssid: string; security: string; channel: number | null; bestRssi: number | null; lat: number | null; lon: number | null; firstSeen: number }[];
  handshakes: { ssid: string; bssid: string; method: string; capturedAt: number; password: string | null; capFile: string; hashFile: string | null }[];
  capFiles: Record<string, Buffer>;
  includeCredentials: boolean;
}

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2));

export const buildSessionFiles = (input: SessionInput): Record<string, Buffer> => {
  const handshakes = input.handshakes.map((h) => {
    const { password, capFile, hashFile, ...rest } = h;
    if (!input.includeCredentials) return rest;
    return { ...rest, password, capFile: `captures/${basename(capFile)}`, hashFile: hashFile ? `captures/${basename(hashFile)}` : null };
  });
  const files: Record<string, Buffer> = {
    "drive.json": json(input.drive),
    "track.json": json(input.track),
    "networks.json": json(input.networks),
    "handshakes.json": json(handshakes),
  };
  if (input.includeCredentials) {
    for (const [name, data] of Object.entries(input.capFiles)) files[name] = data;
  }
  return files;
};

const basename = (path: string): string => path.split(/[\\/]/).pop() || path;
