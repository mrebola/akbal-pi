// Shared shapes for the GNSS metadata service (docs/gnss.md). Reads live
// PRN/constellation/SNR/azimuth/elevation from the same NMEA adapter the
// GPS page already uses (utils/gps.ts) and enriches it with satellite
// metadata cached in SQLite, refreshed from CelesTrak when internet is
// available and the cache is stale/missing — never blocking the caller.

import { GnssConstellationCode } from "../../utils/gps";

export type { GnssConstellationCode };

// Permanent, rarely-changing identity of a satellite — kept separate from
// its orbital data (see GnssOrbitalRecord) so re-fetching a fresh OMM never
// has to re-derive who the satellite is.
export type GnssSatelliteMetadata = {
  constellation: GnssConstellationCode;
  prn: string;
  noradId: number | null; // NORAD catalog number, once matched via CelesTrak
  name: string | null; // e.g. "GPS BIIR-2  (PRN 13)"
  firstSeen: number; // epoch ms, first time this PRN was observed locally
  lastSeen: number; // epoch ms, most recent observation
};

// Orbital elements, as published by CelesTrak (OMM/JSON — see celestrak.ts).
// Stored as opaque JSON since we only ever display it, never propagate the
// orbit ourselves (az/el/SNR for "now" already come from the local adapter).
export type GnssOrbitalRecord = {
  noradId: number;
  ommJson: string; // raw OMM object, JSON-encoded
  epoch: string | null; // OMM EPOCH field (orbit reference time)
  fetchedAt: number; // epoch ms, when we pulled this from CelesTrak
  source: "celestrak";
};

// One historical sky-plot reading, written on every GPS status poll so the
// GNSS page can show "seen over time" without depending on CelesTrak.
export type GnssObservation = {
  timestamp: number; // epoch ms
  constellation: GnssConstellationCode;
  prn: string;
  snr: number;
  azimuth: number;
  elevation: number;
  used: boolean;
};

// What the GNSS API actually serves: the adapter's live reading for this
// PRN plus whatever cached metadata/orbital summary we have for it (both
// optional — a brand new PRN with no internet yet still renders fine).
export type GnssSatelliteView = {
  constellation: GnssConstellationCode;
  prn: string;
  elevation: number;
  azimuth: number;
  snr: number;
  used: boolean;
  metadata: {
    noradId: number | null;
    name: string | null;
  } | null;
  orbital: {
    epoch: string | null;
    fetchedAt: number;
    ageMs: number;
  } | null;
};

export type GnssSnapshot = {
  present: boolean; // a GPS dongle is plugged in (mirrors GpsStatus.present)
  satellites: GnssSatelliteView[];
  cacheOnly: boolean; // true when serving purely from SQLite (no live adapter data)
  lastRefreshAttempt: number | null; // epoch ms of the last CelesTrak attempt
  lastRefreshOk: boolean | null; // null = never attempted
  lastRefreshError: string | null;
};
