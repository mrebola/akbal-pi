// Only one client drives the game at a time. The lock is about input, not
// viewing: every client can watch, only the holder's keys reach the engine.
export class ControllerLock {
  private owner: string | null = null;

  claim(clientId: string): boolean {
    if (this.owner === null || this.owner === clientId) {
      this.owner = clientId;
      return true;
    }
    return false;
  }

  release(clientId: string): void {
    if (this.owner === clientId) this.owner = null;
  }

  holder(): string | null {
    return this.owner;
  }

  isHolder(clientId: string): boolean {
    return this.owner === clientId;
  }
}
