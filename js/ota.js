/* ESB OTA over WebHID.
 *
 *   Browser -> HID OUT -> Dongle -> ESB (ACK payload) -> Tracker
 *
 * A direct port of scripts/esb_ota.py from the receiver firmware repo; the
 * packet layouts, sequencing and flow-control constants below must stay in step
 * with src/esb_ota.h on both the dongle and the tracker.
 *
 * Two things about this transport are worth knowing before reading the code:
 *
 * 1. The dongle streams tracker telemetry continuously, packing four 16-byte
 *    sub-reports into every 64-byte HID IN report. OTA replies arrive
 *    interleaved with that traffic in any of the four slots, so every inbound
 *    report has to be split and scanned rather than read positionally.
 *
 * 2. DATA packets are addressed to a single tracker even when several are being
 *    updated. The dongle keeps a per-tracker cursor into one shared ring buffer
 *    and fans the same bytes out to all of them, so the image is only sent over
 *    the air once no matter how many targets there are.
 */
import { mkErr, log, sleep, crc32 } from './util.js';
import { TELEMETRY_TYPES, applyTelemetry } from './telemetry.js';

/* ---- HID report types (src/esb_ota.h) ---- */
export const HID = {
  QUERY_INFO: 0xF0,
  FW_INFO:    0xF1,
  BEGIN:      0xF2,
  DATA:       0xF3,
  STATUS:     0xF4,
  VERIFY:     0xF5,
  ACTIVATE:   0xF6,
  ABORT:      0xF7,
};

/* Target id meaning "the dongle itself" rather than a tracker behind it
 * (RECEIVER_OTA_ID in the receiver's src/receiver_ota.h). Same report types,
 * same packet layouts; the dongle just keeps these instead of relaying them. */
export const DONGLE_ID = 0xFE;

/* Dongle command envelope (receiver src/rcv_hid_cmd.h).
 *
 *   OUT  [0] 254  [1] seq  [2] opcode  [3] flags  [4..15] args
 *   IN   [0] 251  [1] seq  [2] opcode  [3] status [4..]   result
 *
 * Opcodes 1-200 are tracker remote commands (the ESB PONG flag values, args[0]
 * = tracker id or 0xFF for all); 201-253 act on the dongle itself. A tracker
 * command answers STARTED at once and a second ACK with the same seq when the
 * trackers have confirmed it (OK) or the dongle gave up waiting (ENOENT). */
const RCV_HID_TYPE_CMD = 254;
const RCV_HID_TYPE_ACK = 251;
const RCV_HID_OP_DFU   = 217;

export const OP = {
  // tracker remote (ESB_PONG_FLAG_*)
  DOZE: 0x70, WAKE: 0x71, PING: 0x11,
  // dongle
  PAIR: 201, EXIT_PAIR: 202, RSSI_SCAN: 209, DFU: RCV_HID_OP_DFU, TRACKER_CH_ALL: 218, TRACKER_CH_CLR: 219,
  // NekoTora additions (receiver rcv_hid_cmd.h): RSSI_RESULT is IN only
  RSSI_RESULT: 252, STATUS: 253,
  // tracker remote: power off (ESB_PONG_FLAG_SHUTDOWN), ZRO calibration
  SHUTDOWN: 0x01, CALIBRATE: 0x02,
  // tracker remote resets (ESB_PONG_FLAG_*)
  CLEAR_PAIR: 0x08, SENS_RESET: 0x0D, RESET_ZRO: 0x0E, RESET_ACC: 0x0F,
  RESET_BAT: 0x10, RESET_TCAL: 0x12,
  // dongle: forget one tracker by id, other ids unchanged (NekoTora receiver)
  REMOVE_ID: 250,
  // tracker events (receiver tracker_event_protocol.h): subscribe, then
  // TRACKER_EVENT records arrive unasked
  TRACKER_EVENTS: 224, TRACKER_EVENT: 225,
};

/* Tracker event constants (tracker_event_protocol.h, version 1). */
export const TEV = {
  VERSION: 1,
  SUBSCRIBE: 1, RENEW: 2,
  MASK_CAL: 1,                 // calibration kinds 1..7
  LEASE_MS: 15000,
  // event
  ACCEPTED: 1, BEGIN: 2, STEP: 3, END: 4, REJECTED: 5,
  // outcome
  SUCCESS: 1, FAILED: 2, CANCELLED: 3, SKIPPED: 4,
  // kind
  KIND_ZRO: 1, ORIGIN_AUTO: 0x80,
  // phase
  PH_WAIT_STILL: 2, PH_COLLECT: 4,
  // reason (END detail)
  R_BUSY: 1, R_SENSOR: 4, R_MOTION: 5, R_TIMEOUT: 6, R_SAMPLES: 7, R_TEMPERATURE: 23,
};

/* One TRACKER_EVENT record (16 bytes, tracker_event_encode_hid). */
export function parseTrackerEvent(sub){
  return {
    event: sub[3] & 15, outcome: sub[3] >> 4, tracker: sub[4],
    nonce: (sub[5] | (sub[6] << 8) | (sub[7] << 16) | (sub[8] << 24)) >>> 0,
    seq: sub[9] | (sub[10] << 8), op: sub[11] | (sub[12] << 8),
    kind: sub[13], phase: sub[14], detail: sub[15],
  };
}

/* Tracker link state as the dongle sees it (STATUS, 2 bits per id). */
export const LINK = { GONE: 0, DOZING: 1, AWAKE: 2 };

/* Parse a STATUS ACK's result bytes (ack[4..], layout in rcv_hid_cmd.h). */
export function parseDongleStatus(data, now = Date.now()){
  const links = [];
  for (let i = 0; i < 16; i++) links.push((data[3 + (i >> 2)] >> ((i & 3) * 2)) & 3);
  return {
    stored: data[0], channel: data[1],
    explicit: !!(data[2] & 1), pairing: !!(data[2] & 2), scanning: !!(data[2] & 4),
    links, at: now,
  };
}

/* Parse one RSSI_RESULT ACK's result bytes. */
export function parseScanResult(data){
  return {
    index: data[0], count: data[1], channel: data[2],
    busy: data[3] | (data[4] << 8),        // permille of samples above -85 dBm
    peak: -data[5],                          // dBm
    rendezvous: !!(data[6] & 1), current: !!(data[6] & 2), best: !!(data[6] & 4),
  };
}
export const ALL_TRACKERS = 0xFF;

export const ACK = {
  OK: 0, EINVAL: 1, ENOSPC: 2, EBUSY: 3, ENOENT: 4, ENOTSUP: 5, QUEUED: 6, STARTED: 7,
};

/* ---- OTA status codes ---- */
export const ST = {
  IDLE: 0x00, READY: 0x01, RECEIVING: 0x02,
  VERIFY_OK: 0x03, VERIFY_FAIL: 0x04,
  ACTIVATING: 0x05, COMPLETE: 0x06,
  ERROR: 0x10, BOARD_MISMATCH: 0x11, FLASH_ERROR: 0x12,
  SIZE_ERROR: 0x13, SEQ_ERROR: 0x14, TIMEOUT: 0x15,
};

export const ST_NAME = Object.fromEntries(Object.entries(ST).map(([k, v]) => [v, k]));

const TERMINAL = new Set([
  ST.COMPLETE, ST.ERROR, ST.VERIFY_FAIL, ST.TIMEOUT,
  ST.BOARD_MISMATCH, ST.SIZE_ERROR, ST.FLASH_ERROR, ST.SEQ_ERROR,
]);

/* ---- protocol constants (must match firmware) ---- */
const REPORT_SIZE       = 64;
const SUB_REPORT_SIZE   = 16;
const PROTOCOL_VERSION  = 1;
const DATA_MAX_PAYLOAD  = 60;   // firmware bytes per DATA packet
const BOARD_TARGET_MAX  = 48;
const RING_BUFFER_SIZE  = 128;  // OTA_TX_RING_SIZE on the dongle
const MAX_IN_FLIGHT     = RING_BUFFER_SIZE - 16;
const BURST_SIZE        = 48;
const WARMUP_BURST      = 8;

/* Map an OTA status code to the message a customer should see. Anything that
 * is not specifically explained falls back to errOtaActivate, which prints the
 * raw status name - unhelpful, but better than a silent failure. */
function statusError(code){
  switch (code){
    case ST.BOARD_MISMATCH: return mkErr('errOtaMismatch', { board: '?' });
    case ST.SIZE_ERROR:     return mkErr('errOtaSize');
    case ST.VERIFY_FAIL:    return mkErr('errOtaVerify');
    case ST.TIMEOUT:        return mkErr('errOtaStalled');
    default:                return mkErr('errOtaActivate', { st: ST_NAME[code] || code });
  }
}

/* ===================== dongle transport ============================== */

export class Dongle {
  constructor(device){
    this.device = device;
    this.queue = [];              // pending OTA sub-reports (16 bytes each)
    this.waiters = [];            // resolvers waiting on new traffic
    this.seen = new Map();        // trackerId -> {addr, online, lastSeen, battery, rssi, fw}
    this.acks = [];               // command ACKs not yet claimed
    this.eventListeners = new Set();
    this.eventKeys = new Set();   // de-duplicates the dongle's repeats
    this.seq = 0;
    this._onInput = this._onInput.bind(this);
  }

  get name(){ return this.device.productName || 'HID device'; }

  async open(){
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this._onInput);
  }

  async close(){
    this.device.removeEventListener('inputreport', this._onInput);
    try { await this.device.close(); } catch (_) {}
  }

  _onInput(ev){
    const d = ev.data;                       // DataView, report ID stripped
    const n = Math.min(d.byteLength, REPORT_SIZE);
    for (let off = 0; off + 8 <= n; off += SUB_REPORT_SIZE){
      const len = Math.min(SUB_REPORT_SIZE, n - off);
      const sub = new Uint8Array(len);
      for (let i = 0; i < len; i++) sub[i] = d.getUint8(off + i);

      const type = sub[0], tid = sub[1];
      if (type >= 0xF0 && type <= 0xF7){
        this.queue.push(sub);
        continue;
      }
      if (type === RCV_HID_TYPE_ACK && sub[2] === OP.TRACKER_EVENT && len >= 16){
        /* Sent unasked (seq 0) to a subscriber, each up to 3 times. */
        const e = parseTrackerEvent(sub);
        const key = `${e.tracker}:${e.nonce}:${e.seq}`;
        if (!this.eventKeys.has(key)){
          this.eventKeys.add(key);
          if (this.eventKeys.size > 256) this.eventKeys.delete(this.eventKeys.values().next().value);
          for (const fn of this.eventListeners) fn(e);
        }
        continue;
      }
      if (type === RCV_HID_TYPE_ACK){
        this.acks.push({ seq: sub[1], opcode: sub[2], status: sub[3], data: sub.slice(4) });
        /* Unclaimed ACKs (a command that timed out, results nobody waits
         * for) must not pile up for the life of the page. */
        if (this.acks.length > 128) this.acks.splice(0, this.acks.length - 128);
        continue;
      }
      /* Presence tracking. Type 255 is the address-registration padding the
       * dongle emits for every tracker it knows about, including ones that are
       * asleep or out of range; types 0-7 are real telemetry, which only an
       * awake tracker produces. The distinction matters because an update sent
       * to a registered-but-offline tracker just times out. Anything else on
       * the report (ACKs above, tracker events) says nothing about presence -
       * an ACK's second byte is a sequence number, not a tracker id. */
      if (tid >= 64) continue;
      if (type === 255){
        let addr = '';
        for (let i = 7; i >= 2; i--) addr += sub[i].toString(16).toUpperCase().padStart(2, '0');
        const e = this.seen.get(tid) || { addr: '', online: false };
        e.addr = addr;
        this.seen.set(tid, e);
      } else if (TELEMETRY_TYPES.has(type)){
        const e = this.seen.get(tid) || { addr: '', online: false };
        applyTelemetry(e, sub, Date.now());
        this.seen.set(tid, e);
      }
    }
    /* Wake anything waiting on traffic. Resolvers are one-shot; a waiter that
     * has not got what it wants re-arms itself. */
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  async send(bytes){
    const out = new Uint8Array(REPORT_SIZE);
    out.set(bytes.subarray(0, REPORT_SIZE));
    await this.device.sendReport(0, out);
  }

  /* Resolves on the next inbound report, or after ms with no traffic. */
  _traffic(ms){
    return new Promise(resolve => {
      let done = false;
      const fire = () => { if (!done){ done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(fire, ms);
      this.waiters.push(fire);
    });
  }

  /* Drain everything queued since the last call. */
  drain(){
    const q = this.queue;
    this.queue = [];
    return q;
  }

  /* ---- packet builders ---- */

  _pkt(type, tid){
    const p = new Uint8Array(REPORT_SIZE);
    p[0] = type; p[1] = tid;
    return p;
  }

  queryInfo(tid){ return this.send(this._pkt(HID.QUERY_INFO, tid)); }
  verify(tid){ return this.send(this._pkt(HID.VERIFY, tid)); }
  activate(tid){ return this.send(this._pkt(HID.ACTIVATE, tid)); }
  abort(tid = 0xFF){ return this.send(this._pkt(HID.ABORT, tid)); }

  begin(tid, size, imageCrc, totalPackets, boardTarget, flashBase = 0){
    const p = this._pkt(HID.BEGIN, tid);
    const dv = new DataView(p.buffer);
    dv.setUint32(2, size, true);
    dv.setUint32(6, imageCrc, true);
    dv.setUint16(10, totalPackets, false);   // big-endian, matches firmware
    p[12] = PROTOCOL_VERSION;
    const tb = new TextEncoder().encode(boardTarget).subarray(0, BOARD_TARGET_MAX - 1);
    p.set(tb, 13);
    /* Bytes 61-62: page-aligned flash base >> 12. Zero for MCUboot images,
     * which the tracker places itself. */
    if (flashBase > 0) dv.setUint16(61, flashBase >>> 12, false);
    return this.send(p);
  }

  /* Send a dongle command and wait for its ACK.
   *
   * Returns the first ACK. With `final`, a STARTED answer is followed up to
   * `finalMs` for the completion ACK (same seq), returned as .final; missing
   * it is not an error - the command went out, the dongle just stopped
   * waiting for every tracker to confirm. Resolves null if nothing answers. */
  async command(op, args = [], { timeoutMs = 1500, final = false, finalMs = 7000 } = {}){
    this.seq = this.seq >= 250 || this.seq < 128 ? 128 : this.seq + 1;   // clear of enterUf2's 0x55
    const seq = this.seq;
    const p = new Uint8Array(REPORT_SIZE);
    p[0] = RCV_HID_TYPE_CMD; p[1] = seq; p[2] = op; p[3] = 0;
    p.set(args.slice(0, 12), 4);
    this.acks = this.acks.filter(a => a.seq !== seq);
    await this.send(p);
    const take = () => {
      const i = this.acks.findIndex(a => a.seq === seq && a.opcode === op);
      return i < 0 ? null : this.acks.splice(i, 1)[0];
    };
    const wait = async ms => {
      const end = Date.now() + ms;
      for (;;){
        const a = take();
        if (a || Date.now() >= end) return a;
        await this._traffic(Math.min(100, end - Date.now()));
      }
    };
    const first = await wait(timeoutMs);
    if (first && final && first.status === ACK.STARTED) first.final = await wait(finalMs);
    return first;
  }

  /* Poll the dongle's STATUS (NekoTora receiver firmware). Keeps the result
   * on the dongle as .status. A dongle without it answers with an error
   * status, which sets .statusSupported = false; no answer at all leaves the
   * flag as it was, since that can also be a busy moment. */
  async queryStatus(){
    const a = await this.command(OP.STATUS, [], { timeoutMs: 800 });
    if (!a) return null;
    if (a.status !== ACK.OK){ this.statusSupported = false; return null; }
    this.statusSupported = true;
    this.status = parseDongleStatus(a.data);
    return this.status;
  }

  /* Subscribe to calibration events (renew with RENEW before LEASE_MS runs
   * out). Resolves true when the dongle forwards them. The dongle keeps one
   * subscription; nothing here cancels it - it lapses on its own. */
  async subscribeCalEvents(action = TEV.SUBSCRIBE){
    const a = await this.command(OP.TRACKER_EVENTS, [TEV.VERSION, action, 0xFF, TEV.MASK_CAL], { timeoutMs: 800 });
    return !!a && a.status === ACK.OK;
  }

  onTrackerEvent(fn){
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /* Channel scan (about 5 s on the dongle, deaf to trackers meanwhile).
   * Resolves { ok, results (best first), best, current }. ok false with no
   * results means the dongle firmware does not report scans over HID, or it
   * was busy (.busy). */
  async rssiScan({ all = false, finalMs = 12000 } = {}){
    const first = await this.command(OP.RSSI_SCAN, [all ? 1 : 0], { final: true, finalMs });
    if (!first) return { ok: false, results: [] };
    if (first.status === ACK.EBUSY) return { ok: false, busy: true, results: [] };
    const seq = first.seq;
    const results = [];
    this.acks = this.acks.filter(a => {
      if (a.seq === seq && a.opcode === OP.RSSI_RESULT){ results.push(parseScanResult(a.data)); return false; }
      return true;
    });
    results.sort((a, b) => a.index - b.index);
    const f = first.final;
    if (!f || f.status !== ACK.OK || !results.length) return { ok: false, results };
    return { ok: true, results, best: f.data[1] === 0xFF ? null : f.data[1], current: f.data[2] };
  }

  /* Reboot the dongle into its UF2 bootloader (args[0] = 0: UF2, not OTA DFU).
   * It comes back as a USB drive; the .uf2 dragged onto it is the recovery. */
  enterUf2(){
    const p = new Uint8Array(REPORT_SIZE);
    p[0] = RCV_HID_TYPE_CMD; p[1] = 0x55; p[2] = RCV_HID_OP_DFU; p[3] = 0; p[4] = 0;
    return this.send(p);
  }

  data(tid, seq, chunk){
    const p = this._pkt(HID.DATA, tid);
    new DataView(p.buffer).setUint16(2, seq, false);
    p.set(chunk.subarray(0, DATA_MAX_PAYLOAD), 4);
    return this.send(p);
  }
}

/* ---- report parsers ---- */

export function parseStatus(r){
  if (r.length < 10 || r[0] !== HID.STATUS) return null;
  const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
  return {
    trackerId: r[1],
    status: r[2],
    statusName: ST_NAME[r[2]] || ('0x' + r[2].toString(16)),
    nextSeq: dv.getUint16(3, false),
    bytesWritten: dv.getUint32(5, true),
    ringCount: r[9],
  };
}

/* FW_INFO arrives as six chunks that reassemble into a 66-byte record. */
export function parseFwInfo(chunks){
  const info = new Uint8Array(66);
  let got = 0;
  for (const c of chunks){
    if (c.length < 3 || c[0] !== HID.FW_INFO) continue;
    const idx = c[2];
    if (idx > 5) continue;
    const off = 2 + idx * 13;
    const n = Math.min(13, 66 - off);
    if (n > 0){ info.set(c.subarray(3, 3 + n), off); got++; }
  }
  if (!got) return null;

  const dv = new DataView(info.buffer);
  const raw = dv.getUint32(5, false);
  const year = ((raw >>> 25) & 0x7F) + 2020;
  const month = (raw >>> 21) & 0x0F;
  const day = (raw >>> 16) & 0x1F;
  const hour = (raw >>> 11) & 0x1F;
  const minute = (raw >>> 5) & 0x3F;
  const second = (raw & 0x1F) * 2;

  let boardEnd = 15;
  while (boardEnd < 63 && info[boardEnd] !== 0) boardEnd++;

  const BL = { 0: 'none', 1: 'adafruit_uf2', 2: 'nrf5_opendfu', 3: 'mcuboot' };
  const pad = n => String(n).padStart(2, '0');

  return {
    major: info[2], minor: info[3], patch: info[4],
    version: `${info[2]}.${info[3]}.${info[4]}`,
    versionCode: ((info[2] << 16) | (info[3] << 8) | info[4]) >>> 0,
    buildDate: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
    firmwareSize: dv.getUint32(9, true),
    bootloader: BL[info[13]] || `unknown(${info[13]})`,
    protocolVersion: info[14],
    boardTarget: new TextDecoder().decode(info.subarray(15, boardEnd)),
    flashBase: dv.getUint16(63, false) << 12,
    chunks: got,
  };
}

/* ===================== high-level client ============================= */

export class OtaClient {
  constructor(dongle){ this.d = dongle; }

  /* Listen for a while and report which tracker IDs the dongle knows about.
   * There is no "list trackers" command - presence is inferred from the
   * telemetry stream, so this genuinely has to wait. */
  async discoverTrackers(durationMs = 1800){
    this.d.seen.clear();
    const end = Date.now() + durationMs;
    while (Date.now() < end) await this.d._traffic(Math.min(200, end - Date.now()));
    return new Map([...this.d.seen.entries()].sort((a, b) => a[0] - b[0]));
  }

  async queryInfo(tid, timeoutMs = 4000){
    this.d.drain();
    await this.d.queryInfo(tid);
    const chunks = [];
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && chunks.length < 6){
      await this.d._traffic(Math.min(250, end - Date.now()));
      for (const r of this.d.drain()){
        if (r[0] === HID.FW_INFO && r[1] === tid) chunks.push(r);
      }
    }
    /* Five of six chunks still decodes everything the UI shows; the sixth only
     * carries the tail of board_target and the flash base. */
    return chunks.length ? parseFwInfo(chunks) : null;
  }

  /* Wait for one of `want` from each of `ids`, resending periodically.
   * Resend exists because a tracker that was mid-radio-frame when the command
   * arrived simply misses it; the dongle does not retry commands, only data. */
  async waitStatus(ids, want, { timeoutMs = 30000, resend = null, resendMs = 3000, onResend = null } = {}){
    const results = new Map();
    const pending = new Set(ids);
    const end = Date.now() + timeoutMs;
    let nextResend = resend ? Date.now() + resendMs : Infinity;
    let attempt = 0;

    while (pending.size && Date.now() < end){
      if (Date.now() >= nextResend){
        attempt++;
        if (onResend) onResend(attempt, [...pending]);
        for (const id of pending){ await resend(id); await sleep(50); }
        nextResend = Date.now() + resendMs;
      }
      await this.d._traffic(200);
      for (const r of this.d.drain()){
        if (r[0] !== HID.STATUS || !pending.has(r[1])) continue;
        const st = parseStatus(r);
        if (st && want.has(st.status)){ results.set(r[1], st); pending.delete(r[1]); }
      }
    }
    return results;
  }

  /* Run a full update against one or more trackers sharing the same image.
   *
   * onEvent({stage, ...}) is called for UI updates:
   *   stage 'begin'    – waiting for slot-1 erase, {attempt}
   *   stage 'data'     – {done, total, bytes, size, speed}
   *   stage 'verify'   – CRC check in progress
   *   stage 'activate' – writing boot settings
   *
   * Returns {ok:[ids], failed:[{id, error}]}.
   */
  async update(trackerIds, image, boardTarget, onEvent = () => {}){
    /* The dongle's relay session ends only when every target has reported a
     * terminal status or an abort arrives. A target that goes quiet - no
     * answer to BEGIN, VERIFY or ACTIVATE, or a page that was closed halfway -
     * stays registered, and for as long as it does the dongle keeps every
     * other tracker slowed down to make room for an update nobody is
     * running. So: clear whatever an earlier run left behind before
     * starting, and close the session here whenever this run did not end
     * with every tracker confirmed. */
    await this.d.abort(0xFF).catch(() => {});
    await sleep(100);
    let res = null;
    try {
      res = await this._update(trackerIds, image, boardTarget, onEvent);
      return res;
    } finally {
      if (!res || res.failed.length) await this.d.abort(0xFF).catch(() => {});
    }
  }

  async _update(trackerIds, image, boardTarget, onEvent){
    const size = image.data.length;
    const total = Math.ceil(size / DATA_MAX_PAYLOAD);
    const imageCrc = image.crc32 !== undefined ? image.crc32 : crc32(image.data);

    log(`OTA: ${size} B (${(size / 1024).toFixed(1)} KB), ${total} packets, ` +
        `CRC32 0x${imageCrc.toString(16).toUpperCase()}, target "${boardTarget}"`);

    const failed = [];
    const sendBegin = id => this.d.begin(id, size, imageCrc, total, boardTarget, image.baseAddress || 0);

    /* ---- 1. BEGIN ------------------------------------------------- */
    onEvent({ stage: 'begin', attempt: 0 });
    this.d.drain();
    for (const id of trackerIds){ await sendBegin(id); await sleep(50); }

    /* The retries here are not a sign of trouble: the tracker only answers
     * BEGIN once it has finished erasing slot 1, which takes seconds on a
     * 300 KB slot. Surfaced to the UI as "preparing", not "retrying". */
    const ready = await this.waitStatus(
      trackerIds,
      new Set([ST.READY, ST.RECEIVING, ST.BOARD_MISMATCH, ST.SIZE_ERROR, ST.ERROR]),
      { timeoutMs: 20000, resend: sendBegin, resendMs: 3000,
        onResend: attempt => onEvent({ stage: 'begin', attempt }) },
    );

    let active = [];
    for (const id of trackerIds){
      const st = ready.get(id);
      if (!st){ failed.push({ id, error: mkErr('errOtaNoReady') }); log(`tracker ${id}: no response`, 'warn'); }
      else if (st.status === ST.READY || st.status === ST.RECEIVING){ active.push(id); log(`tracker ${id}: ready`); }
      else { failed.push({ id, error: statusError(st.status) }); log(`tracker ${id}: rejected (${st.statusName})`, 'err'); }
    }
    if (!active.length){ await this.d.abort(0xFF); return { ok: [], failed }; }

    /* ---- 2. DATA -------------------------------------------------- */
    const nextSeq = new Map(active.map(id => [id, 0]));
    const consumed = () => (active.length ? Math.min(...active.map(id => nextSeq.get(id) || 0)) : total);

    let sent = 0, warmup = true, retransmits = 0, refills = 0, ringCount = 0;
    const started = Date.now();
    const overallEnd = started + 180000;

    /* Per-tracker liveness.
     *
     * Progress is the slowest tracker's cursor, because the image is streamed
     * once and fanned out - so one tracker that stops answering pins the whole
     * batch. It never leaves `active` either: only a tracker that reports a
     * terminal status is removed, and a unit that has simply gone out of range
     * reports nothing at all. The result was that one straggler failed every
     * other tracker in the batch, including ones that were nearly finished.
     *
     * Give up on a tracker individually instead. Twenty seconds is generous:
     * all targets consume the same over-the-air data, so in normal operation
     * their cursors sit within a few hundred milliseconds of each other. A gap
     * that large means the unit is gone, not slow. */
    const PER_TRACKER_STALL_MS = 20000;
    const lastAdvance = new Map(active.map(id => [id, started]));

    const dropTracker = (id, error) => {
      failed.push({ id, error });
      active = active.filter(x => x !== id);
      nextSeq.delete(id);
      lastAdvance.delete(id);
      this.d.abort(id).catch(() => {});   // let the dongle release its cursor
    };

    const absorb = () => {
      for (const r of this.d.drain()){
        if (r[0] !== HID.STATUS || !active.includes(r[1])) continue;
        const st = parseStatus(r);
        if (!st) continue;
        if (TERMINAL.has(st.status)){
          log(`tracker ${st.trackerId}: ${st.statusName}`, 'err');
          dropTracker(st.trackerId, statusError(st.status));
          continue;
        }
        if (st.nextSeq > (nextSeq.get(st.trackerId) || 0)) lastAdvance.set(st.trackerId, Date.now());
        nextSeq.set(st.trackerId, st.nextSeq);
        ringCount = st.ringCount;
        warmup = false;
      }
    };

    /* Snapshot for the UI: one entry per tracker in the batch, finished and
     * failed ones included, so rows do not disappear mid-update. */
    const snapshot = () => {
      const rows = [];
      for (const id of trackerIds){
        const f = failed.find(x => x.id === id);
        if (f){ rows.push({ id, done: 0, total, pct: 0, state: 'failed', error: f.error }); continue; }
        if (!active.includes(id)) continue;
        const seq = Math.min(nextSeq.get(id) || 0, total);
        rows.push({
          id, done: seq, total,
          pct: total ? seq / total : 0,
          bytes: Math.min(seq * DATA_MAX_PAYLOAD, size),
          state: seq >= total ? 'done' : 'sending',
        });
      }
      return rows.sort((a, b) => a.id - b.id);
    };

    const report = () => {
      const done = Math.min(consumed(), total);
      const bytes = Math.min(done * DATA_MAX_PAYLOAD, size);
      const secs = (Date.now() - started) / 1000;
      onEvent({ stage: 'data', done, total, bytes, size,
                speed: secs > 0 ? bytes / secs / 1024 : 0, per: snapshot() });
    };

    const REFILL_AFTER_MS = 800;
    const MAX_RETRANSMIT = total * 4;
    let lastConsumed = -1, lastProgress = Date.now(), gaveUp = false;

    while (consumed() < total && active.length && Date.now() < overallEnd && !gaveUp){
      /* Retire anyone who has stopped moving while the batch continues. A
       * tracker already at `total` cannot advance further, so it is exempt. */
      const now = Date.now();
      for (const id of [...active]){
        if ((nextSeq.get(id) || 0) >= total) continue;
        if (now - (lastAdvance.get(id) || now) > PER_TRACKER_STALL_MS){
          log(`tracker ${id}: no progress for ${PER_TRACKER_STALL_MS / 1000}s, dropping`, 'err');
          dropTracker(id, mkErr('errOtaStalled'));
        }
      }
      if (!active.length){ gaveUp = true; break; }

      const cur = consumed();
      if (cur !== lastConsumed){ lastConsumed = cur; lastProgress = Date.now(); }
      const idleMs = Date.now() - lastProgress;

      if (idleMs > REFILL_AFTER_MS && ringCount === 0 && sent > cur){
        refills++;
        if (retransmits > MAX_RETRANSMIT){
          log(`giving up after ${retransmits} retransmitted packets`, 'err');
          gaveUp = true;
          break;
        }
        log(`replay #${refills}: resending from seq ${cur} (${total - cur} left)`, 'warn');
        retransmits += sent - cur;
        sent = cur;
        warmup = false;
        lastProgress = Date.now();
      }

      const inFlight = sent - cur;
      if (sent < total && inFlight < MAX_IN_FLIGHT){
        const burst = Math.min(warmup ? WARMUP_BURST : BURST_SIZE, MAX_IN_FLIGHT - inFlight);
        for (let i = 0; i < burst && sent < total; i++){
          const off = sent * DATA_MAX_PAYLOAD;
          await this.d.data(active[0], sent, image.data.subarray(off, off + DATA_MAX_PAYLOAD));
          sent++;
        }
        await this.d._traffic(warmup ? 50 : 5);
      } else {
        await this.d._traffic(100);
      }
      absorb();
      report();
    }

    /* Order matters: consumed() reports `total` once active is empty, so the
     * emptiness check has to come first or a wiped-out batch would look like a
     * completed one. */
    if (!active.length){ await this.d.abort(0xFF); return { ok: [], failed }; }
    if (consumed() < total){
      for (const id of active) failed.push({ id, error: mkErr('errOtaStalled') });
      await this.d.abort(0xFF);
      return { ok: [], failed };
    }

    const secs = (Date.now() - started) / 1000;
    log(`transfer complete: ${(size / 1024).toFixed(1)} KB in ${secs.toFixed(1)}s ` +
        `(${(size / secs / 1024).toFixed(1)} KB/s) to ${active.length} tracker(s)` +
        (retransmits ? `, ${retransmits} retransmitted` : '') +
        (failed.length ? `, ${failed.length} dropped` : ''));

    /* ---- 3. VERIFY ------------------------------------------------ */
    /* Rows for the remaining phases. Trackers keep their place in the list
     * once they drop out, so the customer can see which one failed and why
     * instead of watching it silently vanish. */
    const phaseRows = (state) => {
      const rows = [];
      for (const id of trackerIds){
        const f = failed.find(x => x.id === id);
        if (f) rows.push({ id, pct: 0, state: 'failed', error: f.error });
        else if (ok.includes(id)) rows.push({ id, pct: 1, state: 'complete' });
        else if (active.includes(id)) rows.push({ id, pct: 1, state });
      }
      return rows.sort((a, b) => a.id - b.id);
    };
    const ok = [];

    onEvent({ stage: 'verify', per: phaseRows('verifying') });
    await sleep(500);
    this.d.drain();
    for (const id of active){ await this.d.verify(id); await sleep(50); }

    const verified = [];
    const vres = await this.waitStatus(
      active, new Set([ST.VERIFY_OK, ST.VERIFY_FAIL, ST.ERROR]),
      { timeoutMs: 30000, resend: id => this.d.verify(id), resendMs: 3000 },
    );
    for (const id of active){
      const st = vres.get(id);
      if (!st){ failed.push({ id, error: mkErr('errOtaStalled') }); }
      else if (st.status !== ST.VERIFY_OK){ failed.push({ id, error: statusError(st.status) }); log(`tracker ${id}: verify failed (${st.statusName})`, 'err'); }
      else { verified.push(id); log(`tracker ${id}: CRC32 verified`); }
    }
    active = verified.slice();
    if (!verified.length){ await this.d.abort(0xFF); return { ok: [], failed }; }

    /* ---- 4. ACTIVATE ---------------------------------------------- */
    onEvent({ stage: 'activate', per: phaseRows('activating') });
    this.d.drain();
    for (const id of verified){ await this.d.activate(id); await sleep(50); }

    const ares = await this.waitStatus(
      verified, new Set([ST.COMPLETE, ST.ERROR, ST.FLASH_ERROR]),
      { timeoutMs: 20000, resend: id => this.d.activate(id), resendMs: 3000 },
    );
    for (const id of verified){
      const st = ares.get(id);
      if (st && st.status === ST.COMPLETE){ ok.push(id); log(`tracker ${id}: activated, rebooting`); }
      else { failed.push({ id, error: st ? statusError(st.status) : mkErr('errOtaActivate', { st: 'no response' }) }); }
    }
    active = ok.slice();
    onEvent({ stage: 'done', per: phaseRows('complete') });
    return { ok, failed };
  }

  /* Update the dongle itself (receiver self-OTA, target DONGLE_ID).
   *
   * Different enough from a tracker update to get its own sequence rather than
   * flags on update():
   *
   *  - No radio and no ring buffer. DATA goes straight into the dongle's page
   *    buffer, so there is no window to manage: sendReport() resolving is the
   *    flow control, and packets are sent strictly in order because the dongle
   *    treats any gap as fatal (SEQ_ERROR) rather than waiting for a replay.
   *    A SEQ_ERROR therefore restarts the whole transfer once from BEGIN.
   *  - STATUS is throttled to one per 20 ms while receiving, so the final
   *    cursor may never be reported. VERIFY is the real completeness check -
   *    the dongle refuses it with SEQ_ERROR when bytes are missing.
   *  - ACTIVATE does not end in COMPLETE. The dongle answers ACTIVATING, copies
   *    the staged image over itself from RAM and resets; the USB device simply
   *    disappears. That disappearance is the success signal, and reconnecting
   *    is the caller's job.
   *
   * image: { data, baseAddress, crc32 } - an app-only image from a .hex
   * (parseAppHex), written at baseAddress (0x1000 on the MS88SF2 dongle).
   *
   * onEvent stages: begin, data {done,total,bytes,size,speed}, verify, activate.
   * Resolves on ACTIVATING; throws an mkErr on failure.
   */
  async updateDongle(image, boardTarget, onEvent = () => {}){
    const size = image.data.length;
    const total = Math.ceil(size / DATA_MAX_PAYLOAD);
    const imageCrc = image.crc32 !== undefined ? image.crc32 : crc32(image.data);
    const id = DONGLE_ID;
    log(`dongle OTA: ${size} B, ${total} packets, base 0x${(image.baseAddress || 0).toString(16)}, ` +
        `CRC32 0x${imageCrc.toString(16).toUpperCase()}, target "${boardTarget}"`);

    const terminal = r => {
      const st = parseStatus(r);
      return st && r[1] === id && TERMINAL.has(st.status) && st.status !== ST.COMPLETE ? st : null;
    };

    for (let attempt = 1; ; attempt++){
      /* ---- BEGIN ---- */
      onEvent({ stage: 'begin', attempt: attempt - 1 });
      this.d.drain();
      const sendBegin = () => this.d.begin(id, size, imageCrc, total, boardTarget, image.baseAddress || 0);
      await sendBegin();
      const ready = await this.waitStatus([id],
        new Set([ST.READY, ST.RECEIVING, ST.BOARD_MISMATCH, ST.SIZE_ERROR, ST.ERROR, ST.TIMEOUT]),
        { timeoutMs: 10000, resend: sendBegin, resendMs: 4000 });
      const st0 = ready.get(id);
      if (!st0) throw mkErr('errDongleNoReady');
      if (st0.status !== ST.READY && st0.status !== ST.RECEIVING) throw statusError(st0.status);

      /* ---- DATA ---- */
      const started = Date.now();
      let failed = null;
      for (let seq = 0; seq < total; seq++){
        const off = seq * DATA_MAX_PAYLOAD;
        await this.d.data(id, seq, image.data.subarray(off, off + DATA_MAX_PAYLOAD));
        if (seq % 32 === 31 || seq === total - 1){
          for (const r of this.d.drain()){ const bad = terminal(r); if (bad){ failed = bad; break; } }
          if (failed) break;
          const bytes = Math.min((seq + 1) * DATA_MAX_PAYLOAD, size);
          const secs = (Date.now() - started) / 1000;
          onEvent({ stage: 'data', done: seq + 1, total, bytes, size,
                    speed: secs > 0 ? bytes / secs / 1024 : 0 });
        }
      }
      if (failed){
        if (failed.status === ST.SEQ_ERROR && attempt < 2){
          log('dongle OTA: a packet went missing, restarting the transfer once', 'warn');
          await this.d.abort(id);
          await sleep(300);
          continue;
        }
        await this.d.abort(id);
        throw statusError(failed.status);
      }
      log(`dongle OTA: sent ${(size / 1024).toFixed(1)} KB in ${((Date.now() - started) / 1000).toFixed(1)}s`);

      /* ---- VERIFY ---- */
      onEvent({ stage: 'verify' });
      await sleep(300);
      this.d.drain();
      await this.d.verify(id);
      const v = (await this.waitStatus([id],
        new Set([ST.VERIFY_OK, ST.VERIFY_FAIL, ST.SEQ_ERROR, ST.ERROR, ST.FLASH_ERROR]),
        { timeoutMs: 20000 })).get(id);
      if (!v){ await this.d.abort(id); throw mkErr('errOtaStalled'); }
      if (v.status === ST.SEQ_ERROR && attempt < 2){
        log('dongle OTA: image incomplete at verify, restarting the transfer once', 'warn');
        await this.d.abort(id);
        await sleep(300);
        continue;
      }
      if (v.status !== ST.VERIFY_OK){ await this.d.abort(id); throw statusError(v.status); }
      log('dongle OTA: CRC32 verified');

      /* ---- ACTIVATE ---- */
      onEvent({ stage: 'activate' });
      this.d.drain();
      await this.d.activate(id);
      const a = (await this.waitStatus([id],
        new Set([ST.ACTIVATING, ST.COMPLETE, ST.ERROR, ST.FLASH_ERROR]),
        { timeoutMs: 5000 })).get(id);
      /* No answer is not a failure here: the dongle may have reset before the
       * ACTIVATING report left. The caller decides by whether it comes back. */
      if (a && a.status !== ST.ACTIVATING && a.status !== ST.COMPLETE) throw statusError(a.status);
      log('dongle OTA: activating, the dongle will reset');
      return;
    }
  }
}
