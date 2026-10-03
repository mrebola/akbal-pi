import * as path from "path";

// The handshake table stores capture file names without their folder; the folder
// is in session_dir. An absolute path is kept as it is.
export const resolveCapturePath = (name: string, sessionDir: string): string =>
  path.isAbsolute(name) ? name : path.join(sessionDir, name);
