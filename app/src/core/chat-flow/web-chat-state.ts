// "Modo chat web": the web chat owns the physical device while it is on. The
// flag lives here, free of display imports, so the web routes and the chat
// flow can both read it. Listeners fire only on a real change.

type Listener = (on: boolean) => void;

let on = false;
const listeners = new Set<Listener>();

export function isWebChatModeOn(): boolean {
  return on;
}

export function setWebChatMode(next: boolean): boolean {
  if (next === on) return on;
  on = next;
  for (const listener of listeners) {
    try {
      listener(on);
    } catch (err: any) {
      console.error("[WebChatMode] listener failed:", err?.message || err);
    }
  }
  return on;
}

export function onWebChatModeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
