import { AdsbMessageKind, RawAdsbMessage } from "./types";

// dump1090's SBS-1/BaseStation feed (--net-sbs-port, plain CSV over TCP) —
// one line per decoded Mode-S message. Field layout (all 22 fields always
// present, most blank depending on TransmissionType):
//
// MSG,TransmissionType,SessionID,AircraftID,HexIdent,FlightID,
//     DateGenerated,TimeGenerated,DateLogged,TimeLogged,
//     Callsign,Altitude,GroundSpeed,Track,Latitude,Longitude,
//     VerticalRate,Squawk,Alert,Emergency,SPI,IsOnGround
//
// Only MSG lines carry aircraft data (dump1090 also emits STA/CLK/etc.,
// ignored here) — see docs/aircraft-radar.md for why SBS text over TCP was
// picked over dump1090's Beast binary format (parseable without a second
// binary framing layer, same "shell a tool, parse its text" shape as
// wifiradar/capture.ts parsing tshark's `-T fields` output).
const TRANSMISSION_KIND: Record<string, AdsbMessageKind | undefined> = {
  "1": "identification",
  "2": "position", // surface position
  "3": "position", // airborne position
  "4": "velocity",
  "5": "surveillance", // surveillance alt
  "6": "surveillance", // surveillance ID (has squawk)
};

function num(value: string): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseSbsLine(line: string): RawAdsbMessage | null {
  const cols = line.split(",");
  if (cols.length < 22 || cols[0] !== "MSG") return null;

  const kind = TRANSMISSION_KIND[cols[1]];
  if (!kind) return null;

  const icao = cols[4]?.trim().toUpperCase();
  if (!icao || icao.length !== 6) return null;

  const msg: RawAdsbMessage = { kind, icao, timestamp: Date.now() };

  if (kind === "identification") {
    const callsign = cols[10]?.trim();
    if (!callsign) return null;
    msg.callsign = callsign;
    return msg;
  }

  if (kind === "position") {
    const altitude = num(cols[11]);
    const lat = num(cols[14]);
    const lon = num(cols[15]);
    if (altitude === undefined && lat === undefined && lon === undefined) return null;
    if (altitude !== undefined) msg.altitudeFt = altitude;
    if (lat !== undefined) msg.latitude = lat;
    if (lon !== undefined) msg.longitude = lon;
    msg.onGround = cols[21]?.trim() === "1" || cols[21]?.trim().toUpperCase() === "TRUE";
    return msg;
  }

  if (kind === "velocity") {
    const speed = num(cols[12]);
    const track = num(cols[13]);
    const vrate = num(cols[16]);
    if (speed === undefined && track === undefined && vrate === undefined) return null;
    if (speed !== undefined) msg.groundSpeedKt = speed;
    if (track !== undefined) msg.trackDeg = track;
    if (vrate !== undefined) msg.verticalRateFtMin = vrate;
    return msg;
  }

  // surveillance: altitude + squawk
  const altitude = num(cols[11]);
  const squawk = cols[17]?.trim();
  if (altitude === undefined && !squawk) return null;
  if (altitude !== undefined) msg.altitudeFt = altitude;
  if (squawk) msg.squawk = squawk;
  return msg;
}
