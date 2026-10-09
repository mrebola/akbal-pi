// Tiny synchronous event bus. The single extensibility seam for future
// sensors (wifi.*/gps.*/adsb.*/voice.*): they only ever emit/on here.
export function createEventBus() {
  const listeners = new Map(); // type -> Set<fn>
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => this.off(type, fn);
    },
    off(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) fn(payload);
    },
  };
}
