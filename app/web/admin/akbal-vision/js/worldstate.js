// Canonical shared state produced by the tracker and read by hud/ui.
// Coordinates are in VIDEO PIXEL space (see spec). The store is a plain
// holder: the tracker builds whole new states; the render loop reads them.
export function emptyWorldState() {
  return { subjects: {}, primaryId: null, frame: { w: 0, h: 0 }, updatedAt: 0 };
}
export function createWorldStore() {
  let current = emptyWorldState();
  return {
    set(state) { current = state; },
    snapshot() { return current; },
  };
}
