// Mirrors the NAV hierarchy in app/web/admin/topbar.js — the single source
// of truth for "where does section X live in the admin UI". Kept as its
// own tiny module (not derived from topbar.js, which is frontend-only JS)
// so the chat tool-loop (web-admin-server.ts) can turn "which admin-tools
// sections were touched this turn" into deep links the user can click,
// without the LLM ever having to generate markdown/URLs itself.
//
// sectionId values match the `id` used by admin-tools/registry.ts
// descriptors, which in turn match topbar.js's NAV ids (wifiradar,
// wifi-audit, wardrive, aircraft-radar, gps, crack-station, settings).
export type AdminSectionId =
  | "wifiradar"
  | "wifi-audit"
  | "wardrive"
  | "aircraft-radar"
  | "gps"
  | "crack-station"
  | "settings";

export type AdminSectionLink = { label: string; href: string };

// "page" sections (topbar.js kind:"page") are standalone routes; "panel"
// sections (kind:"panel") are tabs inside the chat shell (index.html),
// reached via a hash link back to it — same distinction topbar.js makes.
export const ADMIN_SECTION_LINKS: Record<AdminSectionId, AdminSectionLink> = {
  wifiradar: { label: "Radar Wi-Fi", href: "/wifiradar" },
  "aircraft-radar": { label: "Radar de Aviones", href: "/aircraft-radar" },
  gps: { label: "GPS", href: "/gps" },
  "wifi-audit": { label: "Wifi Audit", href: "/#wifi-audit" },
  wardrive: { label: "Wardrive", href: "/wardrive" },
  "crack-station": { label: "Crack Station", href: "/crack-station" },
  settings: { label: "Ajustes", href: "/#settings" },
};

export const linkForSection = (sectionId: AdminSectionId): AdminSectionLink => ADMIN_SECTION_LINKS[sectionId];
