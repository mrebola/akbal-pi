// The WiFi radar can see dozens of access points, but a tool result has to be
// short for the small local model. Without a name it returns the first fifteen;
// with a name it searches all of them, so a network outside those fifteen is
// still found.
export interface ApLike {
  ssid?: string | null;
}

export const findAccessPoints = <T extends ApLike>(aps: T[], ssid?: string, limit = 15): T[] => {
  const query = (ssid || "").trim().toLowerCase();
  if (!query) return aps.slice(0, limit);
  return aps.filter((ap) => (ap.ssid || "").toLowerCase().includes(query));
};
