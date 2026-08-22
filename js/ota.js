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
    this.seen = new Map();        // trackerId -> {addr, online}
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
      /* Presence tracking. Type 255 is the address-registration padding the
       * dongle emits for every tracker it knows about, including ones that are
       * asleep or out of range; any other non-zero type below 0xF0 is real
       * telemetry, which only an awake tracker produces. The distinction
       * matters because an update sent to a registered-but-offline tracker just
       * times out. */
      if (tid >= 64) continue;
      if (type === 255){
        let addr = '';
        for (let i = 7; i >= 2; i--) addr += sub[i].toString(16).toUpperCase().padStart(2, '0');
        const e = this.seen.get(tid) || { addr: '', online: false };
        e.addr = addr;
        this.seen.set(tid, e);
      } else if (type !== 0){
        const e = this.seen.get(tid) || { addr: '', online: false };
        e.online = true;
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
    const consumed = () => Math.min(...active.map(id => nextSeq.get(id) || 0));

    let sent = 0, warmup = true, retransmits = 0, refills = 0, ringCount = 0;
    const started = Date.now();
    const overallEnd = started + 180000;

    const absorb = () => {
      for (const r of this.d.drain()){
        if (r[0] !== HID.STATUS || !active.includes(r[1])) continue;
        const st = parseStatus(r);
        if (!st) continue;
        if (TERMINAL.has(st.status)){
          log(`tracker ${st.trackerId}: ${st.statusName}`, 'err');
          failed.push({ id: st.trackerId, error: statusError(st.status) });
          active = active.filter(x => x !== st.trackerId);
          nextSeq.delete(st.trackerId);
          continue;
        }
        nextSeq.set(st.trackerId, st.nextSeq);
        ringCount = st.ringCount;
        warmup = false;
      }
    };

    const report = () => {
      const done = Math.min(consumed(), total);
      const bytes = Math.min(done * DATA_MAX_PAYLOAD, size);
      const secs = (Date.now() - started) / 1000;
      onEvent({ stage: 'data', done, total, bytes, size, speed: secs > 0 ? bytes / secs / 1024 : 0 });
    };

    /* One loop drives the whole transfer, because sending and gap-filling are
     * not separable phases. A packet lost on the HID path stops the slowest
     * tracker's cursor dead, so the in-flight window (sent - consumed) stays
     * pinned at its limit and `sent` never reaches `total` - meaning a
     * "stream, then gap-fill" structure never leaves the streaming half. The
     * Python tool this was ported from is shaped that way and would sit on a
     * full window until its overall timeout rather than replaying the gap.
     *
     * Instead: keep the window topped up whenever there is room, and treat a
     * lack of progress as the signal to act. Which action depends on where the
     * missing bytes are:
     *
     *   ringCount > 0  the dongle still holds packets and is retransmitting
     *                  over the air by itself. Waiting is correct; resending
     *                  would only push the ring towards overflow.
     *   ringCount == 0 the dongle has nothing left to deliver, yet the tracker
     *                  is short. Those bytes never arrived over USB and exist
     *                  nowhere but here, so rewind and replay from the gap.
     */
    /* Once the ring reads empty and the tracker is short, the gap is certain -
     * there is nothing left in flight to close it. The wait is only long
     * enough for a STATUS newer than the last burst to have arrived, so that
     * ringCount is not being read stale; beyond that, waiting just adds dead
     * time to every recovery. */
    const REFILL_AFTER_MS = 800;
    const GIVE_UP_AFTER_MS = 15000;  // no progress at all, ring or not -> stop
    /* Bounded by wasted work rather than a fixed count: a link losing the
     * occasional packet should keep going, while one losing most of them
     * should stop instead of grinding through the full timeout. */
    const MAX_RETRANSMIT = total * 4;

    let lastConsumed = -1, lastProgress = Date.now(), gaveUp = false;

    while (consumed() < total && active.length && Date.now() < overallEnd && !gaveUp){
      const now = consumed();
      if (now !== lastConsumed){ lastConsumed = now; lastProgress = Date.now(); }
      const idleMs = Date.now() - lastProgress;

      if (idleMs > GIVE_UP_AFTER_MS){
        log(`transfer stalled at ${now}/${total} (ring=${ringCount})`, 'err');
        gaveUp = true;
        break;
      }
      if (idleMs > REFILL_AFTER_MS && ringCount === 0 && sent > now){
        refills++;
        if (retransmits > MAX_RETRANSMIT){
          log(`giving up after ${retransmits} retransmitted packets`, 'err');
          gaveUp = true;
          break;
        }
        log(`replay #${refills}: resending from seq ${now} (${total - now} left)`, 'warn');
        retransmits += sent - now;
        sent = now;
        warmup = false;
        lastProgress = Date.now();
      }

      const inFlight = sent - now;
      if (sent < total && inFlight < MAX_IN_FLIGHT){
        const burst = Math.min(warmup ? WARMUP_BURST : BURST_SIZE, MAX_IN_FLIGHT - inFlight);
        for (let i = 0; i < burst && sent < total; i++){
          const off = sent * DATA_MAX_PAYLOAD;
          await this.d.data(active[0], sent, image.data.subarray(off, off + DATA_MAX_PAYLOAD));
          sent++;
        }
        await this.d._traffic(warmup ? 50 : 5);
      } else {
        /* Nothing to send: either everything is out or the window is full.
         * Wait on the tracker rather than spinning. */
        await this.d._traffic(100);
      }
      absorb();
      report();
    }

    if (!active.length){ await this.d.abort(0xFF); return { ok: [], failed }; }
    if (consumed() < total){
      for (const id of active) failed.push({ id, error: mkErr('errOtaStalled') });
      await this.d.abort(0xFF);
      return { ok: [], failed };
    }

    const secs = (Date.now() - started) / 1000;
    log(`transfer complete: ${(size / 1024).toFixed(1)} KB in ${secs.toFixed(1)}s ` +
        `(${(size / secs / 1024).toFixed(1)} KB/s)` +
        (retransmits ? `, ${retransmits} retransmitted` : ''));

    /* ---- 3. VERIFY ------------------------------------------------ */
    onEvent({ stage: 'verify' });
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
    if (!verified.length){ await this.d.abort(0xFF); return { ok: [], failed }; }

    /* ---- 4. ACTIVATE ---------------------------------------------- */
    onEvent({ stage: 'activate' });
    this.d.drain();
    for (const id of verified){ await this.d.activate(id); await sleep(50); }

    const ares = await this.waitStatus(
      verified, new Set([ST.COMPLETE, ST.ERROR, ST.FLASH_ERROR]),
      { timeoutMs: 20000, resend: id => this.d.activate(id), resendMs: 3000 },
    );
    const ok = [];
    for (const id of verified){
      const st = ares.get(id);
      if (st && st.status === ST.COMPLETE){ ok.push(id); log(`tracker ${id}: activated, rebooting`); }
      else { failed.push({ id, error: st ? statusError(st.status) : mkErr('errOtaActivate', { st: 'no response' }) }); }
    }
    return { ok, failed };
  }
}
