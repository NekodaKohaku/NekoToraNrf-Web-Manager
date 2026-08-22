/* MCUboot serial recovery over Web Serial (SMP / mcumgr console transport).
 *
 * Ported from SlimeNRF-Web-Builder docs/update.html, which is the version that
 * has been used to flash boards by hand; the framing and CBOR helpers below are
 * unchanged apart from making the SMP sequence number an argument instead of
 * module state, so two ports could in principle be driven at once.
 *
 * Wire format, for anyone reading the framing code:
 *
 *   datagram = u16BE(len(data) + 2) + data + u16BE(crc16-xmodem(data))
 *   base64 the datagram, then split into lines of at most 127 bytes;
 *   first line starts 0x06 0x09, continuations 0x04 0x14, every line ends 0x0A.
 *
 * Each line's base64 must decode on its own, hence the 4-character split
 * boundary. Lines that carry neither marker are ordinary console output from
 * the application and are passed through to the log - which is how "dfu" typed
 * at a running tracker is seen to take effect.
 */
import { mkErr, log, sleep } from './util.js';

/* SMP groups/ids used here. Group 0 is OS management (echo, reset), group 1 is
 * image management (upload). */
const OP_WRITE = 2;
const GRP_OS = 0, GRP_IMAGE = 1;
const ID_ECHO = 0, ID_RESET = 5, ID_UPLOAD = 1;

export function crc16(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++)
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/* ---------- 最小 CBOR エンコーダー ---------- */
export function cborUint(major, v, out) {
  const m = major << 5;
  if (v < 24) out.push(m | v);
  else if (v < 0x100) out.push(m | 24, v);
  else if (v < 0x10000) out.push(m | 25, v >> 8, v & 0xff);
  else out.push(m | 26, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
export function cborEncode(obj) {
  const out = [];
  const keys = Object.keys(obj);
  cborUint(5, keys.length, out); // map
  for (const k of keys) {
    cborUint(3, k.length, out); // tstr (ASCII キー前提)
    for (let i = 0; i < k.length; i++) out.push(k.charCodeAt(i));
    const v = obj[k];
    if (v instanceof Uint8Array) { cborUint(2, v.length, out); for (const b of v) out.push(b); }
    else if (typeof v === "number") {
      if (v >= 0) cborUint(0, v, out); else cborUint(1, -1 - v, out);
    }
    else if (typeof v === "boolean") out.push(v ? 0xf5 : 0xf4);
    else if (typeof v === "string") { cborUint(3, v.length, out); for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i)); }
  }
  return new Uint8Array(out);
}

/* ---------- 最小 CBOR デコーダー ({rc, off, r} 程度の応答が解析できれば十分) ---------- */
export function cborDecode(buf) {
  let p = 0;
  function item() {
    if (p >= buf.length) throw new Error("cbor eof");
    const ib = buf[p++], major = ib >> 5;
    let arg = ib & 0x1f;
    if (arg === 24) arg = buf[p++];
    else if (arg === 25) { arg = (buf[p] << 8) | buf[p + 1]; p += 2; }
    else if (arg === 26) { arg = (buf[p] * 0x1000000) + (buf[p+1] << 16) + (buf[p+2] << 8) + buf[p+3]; p += 4; }
    else if (arg === 27) { let hi = 0, lo = 0; for (let i = 0; i < 4; i++) hi = hi * 256 + buf[p++]; for (let i = 0; i < 4; i++) lo = lo * 256 + buf[p++]; arg = hi * 0x100000000 + lo; }
    else if (arg > 27) { /* 不定長 / special は未対応 */ }
    switch (major) {
      case 0: return arg;
      case 1: return -1 - arg;
      case 2: { const v = buf.slice(p, p + arg); p += arg; return v; }
      case 3: { let s = ""; for (let i = 0; i < arg; i++) s += String.fromCharCode(buf[p + i]); p += arg; return s; }
      case 4: { const a = []; for (let i = 0; i < arg; i++) a.push(item()); return a; }
      case 5: { const o = {}; for (let i = 0; i < arg; i++) { const k = item(); o[k] = item(); } return o; }
      case 7:
        if (arg === 20) return false;
        if (arg === 21) return true;
        if (arg === 22 || arg === 23) return null;
        return null;
      default: return null;
    }
  }
  return item();
}

/* ---------- パケットのエンコード ---------- */
export function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
export function encodeFrames(smpBytes) {
  const total = smpBytes.length + 2; // data + crc
  const body = new Uint8Array(2 + smpBytes.length + 2);
  body[0] = total >> 8; body[1] = total & 0xff;
  body.set(smpBytes, 2);
  const c = crc16(smpBytes);
  body[body.length - 2] = c >> 8; body[body.length - 1] = c & 0xff;
  const b64 = b64encode(body);
  const frames = [];
  let i = 0, first = true;
  while (i < b64.length) {
    const chunk = b64.slice(i, i + 124); // 2+124+1 = 最大 127 バイト
    i += 124;
    const marker = first ? "\x06\x09" : "\x04\x14";
    first = false;
    const f = new Uint8Array(marker.length + chunk.length + 1);
    f[0] = marker.charCodeAt(0); f[1] = marker.charCodeAt(1);
    for (let j = 0; j < chunk.length; j++) f[2 + j] = chunk.charCodeAt(j);
    f[f.length - 1] = 0x0a;
    frames.push(f);
  }
  return frames;
}
export function buildSmp(op, group, id, payloadObj, seqNo) {
  const payload = cborEncode(payloadObj);
  const h = new Uint8Array(8 + payload.length);
  h[0] = op & 0x07;          // op: 0 read, 1 read rsp, 2 write, 3 write rsp
  h[1] = 0;                  // flags
  h[2] = payload.length >> 8; h[3] = payload.length & 0xff;
  h[4] = group >> 8; h[5] = group & 0xff;
  h[6] = seqNo;
  h[7] = id;
  h.set(payload, 8);
  return { bytes: h, seq: h[6] };
}

/* ===================== serial transport ============================== */

/* One SMP conversation over one serial port.
 *
 * Only a single request is outstanding at a time. That is not a simplification
 * for its own sake: serial recovery answers in order and matching on the
 * sequence byte alone would still leave a stale reply from a timed-out request
 * able to satisfy the next one. */
export class SmpPort {
  constructor(port, { baudRate = 115200 } = {}){
    this.port = port;
    this.baudRate = baudRate;
    this.seq = 0;
    this.pending = null;
    this.lineBuf = [];
    this.pktBuf = null;
    this.pktExpect = 0;
    this.reading = false;
    this.dec = new TextDecoder('utf-8', { fatal: false });
    /* Wire-quality counters. A baud rate that is too fast for the link does
     * not fail cleanly - it corrupts the odd byte, which shows up here as a
     * CRC mismatch or an undecodable line. Counting them turns "is this rate
     * safe?" into a number instead of a hunch. */
    this.crcErrors = 0;
    this.badLines = 0;
  }

  async open(){
    await this.port.open({ baudRate: this.baudRate });
    this.reading = true;
    this._readLoop();
  }

  async close(){
    this.reading = false;
    try { if (this.reader) await this.reader.cancel(); } catch (_) {}
    try { await this.port.close(); } catch (_) {}
  }

  async _readLoop(){
    while (this.reading && this.port.readable){
      this.reader = this.port.readable.getReader();
      try {
        for (;;){
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this._feed(value);
        }
      } catch (_) {
        /* Port yanked mid-read. Any in-flight request will time out on its own
         * and report through the normal error path. */
      } finally {
        try { this.reader.releaseLock(); } catch (_) {}
      }
    }
  }

  _feed(bytes){
    for (const b of bytes){
      this.lineBuf.push(b);
      if (b === 0x0A){ this._handleLine(new Uint8Array(this.lineBuf)); this.lineBuf = []; }
      if (this.lineBuf.length > 4096) this.lineBuf = [];
    }
  }

  _handleLine(line){
    const isFirst = line[0] === 0x06 && line[1] === 0x09;
    const isCont  = line[0] === 0x04 && line[1] === 0x14;
    if (!isFirst && !isCont){
      const txt = this.dec.decode(line).replace(/\r?\n$/, '');
      if (txt.trim().length) log('· ' + txt);
      return;
    }
    let s = '';
    for (let i = 2; i < line.length; i++){
      const c = line[i];
      if (c !== 0x0A && c !== 0x0D) s += String.fromCharCode(c);
    }
    let dec;
    try {
      const bin = atob(s);
      dec = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) dec[i] = bin.charCodeAt(i);
    } catch (_) { this.badLines++; return; }

    if (isFirst){
      this.pktExpect = (dec[0] << 8) | dec[1];
      this.pktBuf = [];
      for (let i = 2; i < dec.length; i++) this.pktBuf.push(dec[i]);
    } else if (this.pktBuf){
      for (const b of dec) this.pktBuf.push(b);
    } else return;

    if (this.pktBuf.length < this.pktExpect) return;

    const all = new Uint8Array(this.pktBuf.slice(0, this.pktExpect));
    this.pktBuf = null;
    const data = all.slice(0, all.length - 2);
    const rxc = (all[all.length - 2] << 8) | all[all.length - 1];
    if (crc16(data) !== rxc){ this.crcErrors++; log('SMP: CRC mismatch', 'warn'); return; }
    this._handleSmp(data);
  }

  _handleSmp(d){
    if (d.length < 8) return;
    const rsp = {
      op: d[0] & 7,
      len: (d[2] << 8) | d[3],
      group: (d[4] << 8) | d[5],
      seq: d[6],
      id: d[7],
      payload: {},
    };
    try { rsp.payload = cborDecode(d.slice(8)) || {}; } catch (_) {}
    if (this.pending && this.pending.seq === rsp.seq){
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(rsp);
    }
  }

  async writeRaw(bytes){
    const w = this.port.writable.getWriter();
    try { await w.write(bytes); } finally { w.releaseLock(); }
  }

  request(op, group, id, payload, timeoutMs = 3000){
    return new Promise((resolve, reject) => {
      this.seq = (this.seq + 1) & 0xFF;
      const { bytes, seq } = buildSmp(op, group, id, payload, this.seq);
      const timer = setTimeout(() => {
        if (this.pending && this.pending.seq === seq) this.pending = null;
        reject(mkErr('errTimeout'));
      }, timeoutMs);
      this.pending = { seq, resolve, timer };
      (async () => {
        try { for (const f of encodeFrames(bytes)) await this.writeRaw(f); }
        catch (e){ clearTimeout(timer); this.pending = null; reject(e); }
      })();
    });
  }

  echo(ms = 800){ return this.request(OP_WRITE, GRP_OS, ID_ECHO, { d: 'hi' }, ms); }
  reset(){ return this.request(OP_WRITE, GRP_OS, ID_RESET, {}, 3000); }
}

/* ===================== high-level DFU ================================ */

/* Get the tracker into serial recovery.
 *
 * "dfu" typed at the running application asks it to reboot into recovery, but
 * that only works if the application is alive and listening. The other two
 * routes - four quick button presses, or a tap on RESET - are driven by the
 * user, so rather than choosing one this just keeps probing for 30 seconds and
 * takes whichever arrives first. MCUboot now holds in recovery indefinitely
 * once it gets there (the watchdog feed and CPU-idle override in the firmware
 * build), so there is no window to miss on the far side.
 */
export async function enterRecovery(smp, { timeoutMs = 30000, onProbe = null } = {}){
  try { await smp.writeRaw(new TextEncoder().encode('dfu\n')); } catch (_) {}
  const end = Date.now() + timeoutMs;
  while (Date.now() < end){
    try { if (await smp.echo(300)) return true; } catch (_) {}
    if (onProbe) onProbe(Math.max(0, end - Date.now()));
    await sleep(60);
  }
  return false;
}

export async function isInRecovery(smp){
  try { return !!(await smp.echo(800)); } catch (_) { return false; }
}

/* Upload an MCUboot update image and reboot into it.
 * onProgress({off, size, speed}) is called per accepted chunk. */
/* Bytes of firmware per SMP request.
 *
 * Was 128, which is what the reference tool uses and which made a 309 KB image
 * take around eighty seconds - slower than the same update over the air. The
 * cost is not the bytes, it is the round trips: mcumgr's serial transport
 * carries one request at a time and waits for the reply, so 128-byte chunks
 * mean ~2500 stop-and-wait cycles and the link spends most of its life idle.
 *
 * 512 cuts that to ~620. The ceiling is the bootloader's receive buffer,
 * CONFIG_BOOT_SERIAL_MAX_RECEIVE_SIZE, which this firmware sets to 1024 (see
 * gen_mcuboot_nekotora.py); a request is the payload plus an 8-byte SMP header
 * and ~18 bytes of CBOR, so 512 leaves comfortable headroom while 960 would
 * sit right on the edge.
 *
 * Anything larger than the bootloader's buffer is silently dropped, which
 * looks like a dead link rather than a rejected request - hence the margin.
 */
export const DFU_CHUNK_SIZE = 512;

export async function uploadImage(smp, bytes, { chunkSize = DFU_CHUNK_SIZE, onProgress = null } = {}){
  const t0 = Date.now();
  const crc0 = smp.crcErrors, bad0 = smp.badLines;
  let off = 0, retries = 0, totalRetries = 0;

  while (off < bytes.length){
    const chunk = bytes.slice(off, off + chunkSize);
    /* The first request carries the total length and image index; later ones
     * only the offset. Recovery uses that first packet to size and erase the
     * slot, which is why it is slower to answer than the rest. */
    const req = off === 0
      ? { image: 0, len: bytes.length, off: 0, data: chunk }
      : { off, data: chunk };

    let rsp;
    try {
      rsp = await smp.request(OP_WRITE, GRP_IMAGE, ID_UPLOAD, req, 5000);
    } catch (e){
      totalRetries++;
      if (++retries > 5) throw mkErr('errDfuUpload', { err: 'timeout at ' + off });
      log(`DFU: retry ${retries}/5 at offset ${off}`, 'warn');
      continue;
    }
    retries = 0;

    const rc = rsp.payload.rc ?? 0;
    if (rc !== 0) throw mkErr('errDfuUpload', { err: `rc=${rc} at ${off}` });

    /* Trust the offset recovery reports rather than assuming the chunk landed
     * whole - it is authoritative and lets it ask for a replay. */
    off = (typeof rsp.payload.off === 'number') ? rsp.payload.off : off + chunk.length;

    if (onProgress){
      const secs = (Date.now() - t0) / 1000;
      onProgress({ off, size: bytes.length, speed: secs > 0 ? off / 1024 / secs : 0 });
    }
  }

  const secs = (Date.now() - t0) / 1000;
  const stats = {
    bytes: bytes.length,
    chunks: Math.ceil(bytes.length / chunkSize),
    seconds: secs,
    kbps: bytes.length / 1024 / secs,
    retries: totalRetries,
    crcErrors: smp.crcErrors - crc0,
    badLines: smp.badLines - bad0,
    baudRate: smp.baudRate,
  };
  log(`DFU: ${(stats.bytes / 1024).toFixed(1)} KB in ${secs.toFixed(1)}s ` +
      `(${stats.kbps.toFixed(1)} KB/s) at ${stats.baudRate} baud, ` +
      `${stats.chunks} chunks, ${stats.retries} retries, ${stats.crcErrors} CRC errors`,
      (stats.retries || stats.crcErrors) ? 'warn' : undefined);
  if (stats.retries || stats.crcErrors){
    log('DFU: a clean link retries zero times. Errors here mean this baud rate ' +
        'is at or past what the wiring and adapter can carry - drop one step.', 'warn');
  }

  /* The reset request usually gets no reply, because the device reboots before
   * it can send one. That is success, not failure. */
  try { await smp.reset(); } catch (_) {}
  return stats;
}

/* Probe link quality before committing to a long upload.
 *
 * This tests reachability and integrity, not throughput. The distinction
 * matters because the obvious design - echo a chunk-sized payload and see if
 * it comes back - does not work here: MCUboot's serial recovery is a cut-down
 * SMP implementation whose echo response buffer is far smaller than the 1024
 * byte receive buffer used for image upload. A 256 byte echo is dropped by a
 * perfectly healthy link, and reporting that as a fault sends the customer off
 * to fix wiring that was never broken. It did exactly that at 115200, the one
 * rate known to work.
 *
 * So the size is discovered rather than assumed: try progressively smaller
 * payloads until one round-trips, then run the real test at that size. A link
 * that cannot echo even a few bytes is genuinely broken; one that echoes small
 * but not large has a bootloader buffer limit, which says nothing about the
 * baud rate.
 *
 * The authoritative throughput and error figures come from uploadImage's own
 * counters afterwards, because only the real transfer exercises the real path.
 */
export async function linkTest(smp, { rounds = 20, sizes = [128, 64, 32, 8] } = {}){
  const crc0 = smp.crcErrors, bad0 = smp.badLines;

  /* Largest payload this bootloader will echo. */
  let payload = 0;
  for (const n of sizes){
    const probe = 'A'.repeat(n);
    try {
      const r = await smp.request(OP_WRITE, GRP_OS, ID_ECHO, { d: probe }, 1500);
      if (r && r.payload && r.payload.d === probe){ payload = n; break; }
    } catch (_) { /* try smaller */ }
  }

  if (!payload){
    return { rounds: 0, ok: 0, failed: 0, payload: 0, unusable: true, clean: false,
             crcErrors: smp.crcErrors - crc0, badLines: smp.badLines - bad0,
             seconds: 0, kbps: 0, baudRate: smp.baudRate };
  }

  const filler = 'A'.repeat(payload);
  let ok = 0, failed = 0;
  const t0 = Date.now();
  for (let i = 0; i < rounds; i++){
    try {
      const r = await smp.request(OP_WRITE, GRP_OS, ID_ECHO, { d: filler }, 1500);
      if (r && r.payload && r.payload.d === filler) ok++; else failed++;
    } catch (_) { failed++; }
  }

  const secs = (Date.now() - t0) / 1000;
  return {
    rounds, ok, failed, payload,
    unusable: false,
    crcErrors: smp.crcErrors - crc0,
    badLines: smp.badLines - bad0,
    seconds: secs,
    kbps: (ok * payload * 2) / 1024 / secs,
    baudRate: smp.baudRate,
    clean: failed === 0 && (smp.crcErrors - crc0) === 0 && (smp.badLines - bad0) === 0,
  };
}
