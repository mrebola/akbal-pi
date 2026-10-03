export interface ClientsLike {
  ssid?: string | null;
  clients?: number | null;
}

// Access points ordered by connected clients, most first. Only networks with at
// least one client are returned: "0 clients" is not a top network.
export const topByClients = <T extends ClientsLike>(aps: T[], n: number): T[] =>
  aps
    .filter((ap) => typeof ap.clients === "number" && ap.clients > 0)
    .sort((a, b) => (b.clients as number) - (a.clients as number))
    .slice(0, n);
