// Reads one cookie from a raw Cookie header and checks it against the admin's
// session tokens. The tokens are hex (see /api/login), and sessionAuth compares
// the raw cookie value too, so nothing is decoded: a malformed percent-escape
// from a LAN client is just an unknown token, never an exception that could
// take the service down.
export function hasValidSessionCookie(
  cookieHeader: string | undefined,
  cookieName: string,
  validSessions: ReadonlySet<string>,
): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    return validSessions.has(part.slice(eq + 1).trim());
  }
  return false;
}
