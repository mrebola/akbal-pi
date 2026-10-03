import { randomBytes, timingSafeEqual } from "node:crypto";

// One control token per DOOM start. It lives in memory only: a restart of
// Akbal, or stopping the game, makes every old QR code useless.
export class ControlTokens {
  private currentToken: Buffer | null = null;

  issue(): string {
    this.currentToken = randomBytes(16);
    return this.currentToken.toString("hex");
  }

  isValid(token: string | null | undefined): boolean {
    if (!this.currentToken || !token || !/^[0-9a-f]{32}$/.test(token)) return false;
    const given = Buffer.from(token, "hex");
    return given.length === this.currentToken.length && timingSafeEqual(given, this.currentToken);
  }

  current(): string | null {
    return this.currentToken ? this.currentToken.toString("hex") : null;
  }

  revokeAll(): void {
    this.currentToken = null;
  }
}
