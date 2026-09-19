// Small curated OUI (MAC vendor prefix) table — intentionally not a full
// IEEE registry (that's tens of thousands of rows and would blow past the
// "extremely lightweight" budget for a purely cosmetic label). Covers the
// vendors actually common in a home/SOHO wifiradar: phones, laptops, APs,
// IoT. Anything unmatched just shows "Desconocido" — the UI treats that as
// a normal case, not an error.
const OUI_TABLE: Record<string, string> = {
  "00:1A:11": "Google",
  "3C:5A:B4": "Google",
  "F4:F5:D8": "Google",
  "A4:77:33": "Google",
  "00:17:88": "Philips",
  "B8:27:EB": "Raspberry Pi Foundation",
  "DC:A6:32": "Raspberry Pi Foundation",
  "D8:3A:DD": "Raspberry Pi Foundation",
  "E4:5F:01": "Raspberry Pi Foundation",
  "28:CD:C1": "Raspberry Pi Foundation",
  "00:0C:CA": "Qualcomm Atheros",
  "00:03:7F": "Qualcomm Atheros",
  "00:1D:D9": "Cisco",
  "00:1B:D4": "Cisco",
  "00:26:99": "Cisco",
  "F4:CF:E2": "Ubiquiti",
  "24:5A:4C": "Ubiquiti",
  "78:8A:20": "Ubiquiti",
  "DC:9F:DB": "Ubiquiti",
  "B0:19:21": "Cambium/other AP",
  "90:16:BA": "AVM (FRITZ!Box)",
  "54:13:10": "AVM (FRITZ!Box)",
  "0C:67:14": "Starlink (SpaceX)",
  "38:EB:47": "TP-Link",
  "50:C7:BF": "TP-Link",
  "AC:84:C6": "TP-Link",
  "D0:21:F9": "Ruckus/CommScope",
  "DA:21:F9": "Ruckus/CommScope",
  "00:04:EA": "Direct Networks",
  "3C:52:82": "Amazon",
  "68:37:E9": "Amazon",
  "F0:27:2D": "Amazon",
  "AC:63:BE": "Apple",
  "A4:83:E7": "Apple",
  "3C:15:C2": "Apple",
  "F0:18:98": "Apple",
  "88:A2:9E": "Apple",
  "00:C0:CA": "Alfa Network (Atheros AR9271)",
  "34:C6:DD": "EZVIZ",
  "00:1D:0F": "TCT Mobile",
  "F8:8F:CA": "Samsung",
  "5C:0A:5B": "Samsung",
  "8C:79:F5": "Samsung",
  "00:16:6C": "Samsung",
  "B4:0E:DC": "Huawei",
  "00:E0:FC": "Huawei",
  "18:65:C7": "Quantenna/ON Semi",
};

export function lookupVendor(mac: string): string {
  const prefix = mac.toUpperCase().slice(0, 8);
  return OUI_TABLE[prefix] || "Desconocido";
}
