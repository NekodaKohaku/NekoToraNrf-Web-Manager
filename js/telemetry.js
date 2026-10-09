/* Tracker telemetry as the dongle forwards it to SlimeVR Server.
 *
 * The dongle packs four 16-byte sub-reports into every 64-byte HID IN report.
 * Types 0-7 are the tracker stream the server reads (receiver src/hid.c,
 * tracker src/connection/connection.c); everything else on the same report is
 * control traffic - OTA (0xF0-0xF7), command ACKs (251), address
 * registration (255) - and must never be mistaken for a tracker being awake.
 *
 *   type 0  info     [2] batt  [3] batt_v  [4] temp  ... [12..14] fw x.y.z  [15] rssi
 *   type 2  compact  [2] batt  [3] batt_v  [4] temp  ...                    [15] rssi
 *   type 3  status   [2] svr_stat [3] status                                [15] rssi
 *   type 5  runtime                                                          [15] rssi
 *
 * temp:   IMU temperature, (byte - 128) / 2 + 25 degrees C; 0 = none.
 * batt:   0 = no battery; 255 = charged; otherwise bit 7 set + percent.
 * batt_v: millivolts / 10 - 245. A tracker on USB power reports at least
 *         4310 mV whatever the cell is at, which is how "charging" is read.
 */

export const TELEMETRY_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const RSSI_TYPES = new Set([0, 2, 3, 5]);
const BATTERY_TYPES = new Set([0, 2]);

/* A tracker counts as awake while its stream keeps arriving. Awake trackers
 * send hundreds of packets a second; a dozing one sends none (only PINGs,
 * which never reach the host). */
export const AWAKE_WINDOW_MS = 2000;

export const CHARGING_MV = 4310;

export function batteryFrom(battByte, voltByte){
  if (!battByte) return { present: false };
  const charged = battByte === 255;
  const pct = charged ? 100 : Math.min(100, battByte & 0x7F);
  const mV = voltByte ? (voltByte + 245) * 10 : null;
  return { present: true, pct, mV, charged, charging: mV !== null && mV >= CHARGING_MV };
}

/* Tracker connection.c: (temp - 25) * 2 + 128.5, clamped to 1..255. */
export function tempFrom(b){
  return b ? (b - 128) / 2 + 25 : null;
}

/* The dongle smooths RSSI and writes it as a signed byte; firmware of either
 * sign convention exists, so both are accepted. 0 means "no reading". */
export function rssiFrom(b){
  if (!b) return null;
  return b > 127 ? b - 256 : -b;
}

/* Fold one telemetry sub-report into the per-tracker record. */
export function applyTelemetry(entry, sub, now){
  const type = sub[0];
  entry.online = true;
  entry.lastSeen = now;
  if (sub.length < 16) return entry;
  if (BATTERY_TYPES.has(type)){
    entry.battery = batteryFrom(sub[2], sub[3]);
    const temp = tempFrom(sub[4]);
    if (temp !== null){ entry.temp = temp; entry.tempAt = now; }
  }
  if (RSSI_TYPES.has(type)){
    const r = rssiFrom(sub[15]);
    if (r !== null) entry.rssi = r;
  }
  if (type === 0) entry.fw = `${sub[12]}.${sub[13]}.${sub[14]}`;
  return entry;
}

export function isAwake(entry, now = Date.now()){
  return !!(entry && entry.lastSeen && now - entry.lastSeen < AWAKE_WINDOW_MS);
}

/* How long a STATUS answer counts as current. The page polls every 1.5 s. */
export const STATUS_FRESH_MS = 6000;

/* One tracker as the page shows it:
 *   'awake'   - streaming (telemetry within the last 2 s, or the dongle says so)
 *   'standby' - dozing: still PINGs, wakes on command
 *   'off'     - the dongle hears nothing from it (switched off or out of range)
 *   'asleep'  - standby or off; a dongle without STATUS cannot tell which
 * `dongle` is the Dongle (seen + status). */
export function trackerState(dongle, id, now = Date.now()){
  const e = dongle && dongle.seen ? dongle.seen.get(id) : null;
  if (isAwake(e, now)) return 'awake';
  const s = dongle && dongle.status;
  if (s && now - s.at < STATUS_FRESH_MS && id >= 0 && id < s.links.length){
    const l = s.links[id];
    return l === 2 ? 'awake' : l === 1 ? 'standby' : 'off';
  }
  return 'asleep';
}

/* Why a tracker may not be updated over the air, or null if it may.
 * Unknown battery (no reading yet) is not a reason: the tracker enforces
 * nothing here, the page is being careful, and a unit without telemetry is
 * already not selectable for other reasons. */
export function batteryBlocks(battery, minPct){
  if (!battery || !battery.present) return null;
  if (battery.charging || battery.charged) return null;
  return battery.pct < minPct ? { pct: battery.pct, min: minPct } : null;
}
