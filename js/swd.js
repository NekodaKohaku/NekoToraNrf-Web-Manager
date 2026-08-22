/* CMSIS-DAP transports and the SWD/NVMC stack.
 *
 * Moved verbatim from the single-file version apart from the import/export
 * lines. This is the path that has flashed every unit shipped so far and the
 * only one that can recover a tracker with no working bootloader, so it is
 * relocated rather than refactored - a regression here is unrecoverable for the
 * customer.
 *
 * Two transports exist because CMSIS-DAP probes come in two flavours: newer
 * ones expose a bulk WebUSB interface, older ones only a HID interface. Both
 * speak the same CMSIS-DAP command set, so DAP works against either. Note this
 * WebHID use is unrelated to the wireless path in ota.js, which also uses
 * WebHID but talks to the dongle, not a probe.
 */
import { mkErr, hex, le32, log } from './util.js';

/* ------------------------- transports ------------------------------- */
export class WebUSBTransport {
  constructor(device){ this.device = device; this.packetSize = 64; this.kind = 'usb'; }
  get name(){ return this.device.productName || 'CMSIS-DAP (USB)'; }
  async open(){
    const d = this.device;
    try { await d.open(); } catch (e){ throw mkErr('errUsbOpen'); }
    if (!d.configuration){ try { await d.selectConfiguration(1); } catch (e){ throw mkErr('errUsbOpen'); } }
    let found = null;
    for (const iface of d.configuration.interfaces){
      for (const alt of iface.alternates){
        if (alt.interfaceClass === 0xFF){
          const epOut = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
          const epIn  = alt.endpoints.find(e => e.direction === 'in'  && e.type === 'bulk');
          if (epOut && epIn){ found = {num: iface.interfaceNumber, epOut, epIn}; break; }
        }
      }
      if (found) break;
    }
    if (!found){ try { await d.close(); } catch (e){} throw mkErr('errNotDapUsb'); }
    try { await d.claimInterface(found.num); } catch (e){ throw mkErr('errUsbOpen'); }
    this.epOut = found.epOut.endpointNumber;
    this.epIn = found.epIn.endpointNumber;
    this.packetSize = Math.max(64, found.epOut.packetSize || 64);
    this.readLen = Math.max(512, this.packetSize);
  }
  setPacketSize(n){ this.packetSize = n; this.readLen = Math.max(512, n); }
  send(data){
    if (!this._sq) this._sq = Promise.resolve();
    const p = this._sq.then(async () => {
      const r = await this.device.transferOut(this.epOut, data);
      if (r.status !== 'ok') throw mkErr('errUsbXfer');
    });
    this._sq = p.catch(() => {});
    return p.catch(e => { throw (e && e.i18nKey) ? e : mkErr('errUsbXfer'); });
  }
  recv(){
    return this.device.transferIn(this.epIn, this.readLen).then(res => {
      if (res.status !== 'ok') throw mkErr('errUsbXfer');
      return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
    }, () => { throw mkErr('errUsbXfer'); });
  }
  async xfer(data){ await this.send(data); return this.recv(); }
  async close(){ try { await this.device.close(); } catch (e){} }
}

export class WebHIDTransport {
  constructor(device){ this.device = device; this.packetSize = 64; this.kind = 'hid'; this._q = []; this._w = []; }
  get name(){ return this.device.productName || 'CMSIS-DAP (HID)'; }
  async open(){
    await this.device.open();
    let size = 64;
    try {
      for (const col of (this.device.collections || [])){
        for (const rep of (col.outputReports || [])){
          for (const item of (rep.items || [])){
            if (item.reportCount && item.reportSize){
              size = Math.ceil(item.reportCount * item.reportSize / 8);
            }
          }
        }
      }
    } catch (e){}
    this.packetSize = Math.min(1024, Math.max(8, size));
    this._onReport = ev => {
      const data = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
      const w = this._w.shift();
      if (w) w(data); else this._q.push(data);
    };
    this.device.addEventListener('inputreport', this._onReport);
  }
  setPacketSize(n){ /* HID packet size is fixed by the report descriptor */ }
  _recv(ms){
    if (this._q.length) return Promise.resolve(this._q.shift());
    return new Promise((resolve, reject) => {
      const w = d => { clearTimeout(tm); resolve(d); };
      const tm = setTimeout(() => {
        const i = this._w.indexOf(w);
        if (i >= 0) this._w.splice(i, 1);
        reject(mkErr('errTimeout'));
      }, ms);
      this._w.push(w);
    });
  }
  send(data){
    const out = new Uint8Array(this.packetSize);
    out.set(data.subarray(0, Math.min(data.length, this.packetSize)));
    if (!this._sq) this._sq = Promise.resolve();
    const p = this._sq.then(() => this.device.sendReport(0, out));
    this._sq = p.catch(() => {});
    return p.catch(() => { throw mkErr('errUsbXfer'); });
  }
  recv(){ return this._recv(5000); }
  async xfer(data){ await this.send(data); return this.recv(); }
  async close(){
    try { this.device.removeEventListener('inputreport', this._onReport); } catch (e){}
    try { await this.device.close(); } catch (e){}
  }
}

/* ------------------------- CMSIS-DAP -------------------------------- */
export const CMD = {INFO:0x00, CONNECT:0x02, DISCONNECT:0x03, TRANSFER_CONFIGURE:0x04,
             TRANSFER:0x05, TRANSFER_BLOCK:0x06, WRITE_ABORT:0x08,
             SWJ_CLOCK:0x11, SWJ_SEQUENCE:0x12};

export class DAP {
  constructor(tr){ this.tr = tr; this.packetSize = 64; this.pipeWindow = 1; }
  async cmd(bytes){
    const req = (bytes instanceof Uint8Array) ? bytes : Uint8Array.from(bytes);
    const resp = await this.tr.xfer(req);
    if (resp[0] !== req[0]) throw mkErr('errDapProto');
    return resp;
  }
  get maxBlockWords(){ return Math.max(1, (this.packetSize - 8) >> 2); }
  async init(clockHz){
    // negotiate packet size
    try {
      const r = await this.cmd([CMD.INFO, 0xFF]);
      if (r[1] === 2){
        const ps = r[2] | (r[3] << 8);
        if (ps >= 64 && ps <= 4096){
          this.packetSize = (this.tr.kind === 'hid') ? Math.min(ps, this.tr.packetSize) : ps;
          this.tr.setPacketSize(this.packetSize);
        }
      }
    } catch (e){ log('DAP_Info(packet size) failed: ' + errText(e), 'warn'); }
    // packet count → how many requests the probe can buffer → pipeline depth
    try {
      const r = await this.cmd([CMD.INFO, 0xFE]);
      if (r[1] === 1){
        const cnt = r[2];
        this.pipeWindow = Math.max(1, Math.min(cnt - 1, 6));
      }
    } catch (e){ this.pipeWindow = 1; }
    log('DAP packet size: ' + this.packetSize + ' bytes, pipeline window: ' + this.pipeWindow +
        ' (' + this.tr.kind.toUpperCase() + ')');
    const c = await this.cmd([CMD.CONNECT, 1]);           // 1 = SWD
    if (c[1] !== 1) throw mkErr('errSwdConnect');
    await this.cmd([CMD.SWJ_CLOCK, ...le32(clockHz)]);
    // idle cycles 0, WAIT retries 0xFFFF (flash writes stall the bus), match retries 0
    await this.cmd([CMD.TRANSFER_CONFIGURE, 0x00, 0xFF, 0xFF, 0x00, 0x00]);
    log('SWD clock: ' + (clockHz / 1000000) + ' MHz');
  }
  async swjSeq(bits, bytes){ await this.cmd([CMD.SWJ_SEQUENCE, bits & 0xFF, ...bytes]); }
  async transfer(items){
    const buf = [CMD.TRANSFER, 0x00, items.length];
    let reads = 0;
    for (const it of items){
      buf.push(it.req);
      if (it.req & 0x02) reads++;
      else buf.push(...le32(it.val >>> 0));
    }
    const r = await this.cmd(buf);
    const count = r[1], ack = r[2] & 0x07;
    if (count !== items.length || ack !== 1) throw mkErr('errSwdFail', {ack: ack, count: count});
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const vals = [];
    for (let i = 0; i < reads; i++) vals.push(dv.getUint32(3 + i * 4, true));
    return vals;
  }
  async transferBlockWrite(req, words, off, n){
    const buf = new Uint8Array(5 + n * 4);
    buf[0] = CMD.TRANSFER_BLOCK; buf[1] = 0; buf[2] = n & 0xFF; buf[3] = (n >> 8) & 0xFF; buf[4] = req;
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < n; i++) dv.setUint32(5 + i * 4, words[off + i], true);
    const r = await this.cmd(buf);
    const cnt = r[1] | (r[2] << 8), ack = r[3] & 0x07;
    if (cnt !== n || ack !== 1) throw mkErr('errSwdFail', {ack: ack, count: cnt});
  }
  async transferBlockRead(req, n){
    const r = await this.cmd([CMD.TRANSFER_BLOCK, 0x00, n & 0xFF, (n >> 8) & 0xFF, req]);
    const cnt = r[1] | (r[2] << 8), ack = r[3] & 0x07;
    if (cnt !== n || ack !== 1) throw mkErr('errSwdFail', {ack: ack, count: cnt});
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getUint32(4 + i * 4, true);
    return out;
  }
  /* Pipelined execution: keep up to pipeWindow requests in flight instead of
   * one request/response round trip at a time — this is what makes bulk
   * programming comparable to pyOCD in speed. Responses arrive in order. */
  async pipeline(cmds, onResp){
    const W = Math.max(1, this.pipeWindow);
    let sent = 0, done = 0, sendErr = null;
    const recvs = [];
    try {
      while (done < cmds.length){
        while (sent < cmds.length && sent - done < W){
          this.tr.send(cmds[sent]).catch(e => { if (!sendErr) sendErr = e; });
          recvs.push(this.tr.recv());
          sent++;
        }
        let resp;
        try { resp = await recvs[done]; }
        catch (e){ throw sendErr || e; }
        if (sendErr) throw sendErr;
        onResp(resp, done);
        done++;
      }
    } catch (err){
      // drain outstanding responses so a failed run doesn't poison the next one
      const rest = recvs.slice(done + 1 <= recvs.length ? done : recvs.length);
      await Promise.race([
        Promise.allSettled(rest),
        new Promise(res => setTimeout(res, 1000)),
      ]);
      throw err;
    }
  }
  xferPacket(items){
    const buf = [CMD.TRANSFER, 0x00, items.length];
    for (const it of items){
      buf.push(it.req);
      if (!(it.req & 0x02)) buf.push(...le32(it.val >>> 0));
    }
    return Uint8Array.from(buf);
  }
  blockWritePacket(req, words, off, n){
    const buf = new Uint8Array(5 + n * 4);
    buf[0] = CMD.TRANSFER_BLOCK; buf[1] = 0; buf[2] = n & 0xFF; buf[3] = (n >> 8) & 0xFF; buf[4] = req;
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < n; i++) dv.setUint32(5 + i * 4, words[off + i], true);
    return buf;
  }
  blockReadPacket(req, n){
    return Uint8Array.from([CMD.TRANSFER_BLOCK, 0x00, n & 0xFF, (n >> 8) & 0xFF, req]);
  }
  async disconnect(){ try { await this.cmd([CMD.DISCONNECT]); } catch (e){} }
}

/* --------------------- SWD / MEM-AP target -------------------------- */
// transfer request byte: bit0 APnDP, bit1 RnW, bits[3:2] = A[3:2]
export const RQ = {
  DP_R: a => 0x02 | (a & 0x0C),
  DP_W: a => 0x00 | (a & 0x0C),
  AP_R: a => 0x03 | (a & 0x0C),
  AP_W: a => 0x01 | (a & 0x0C),
};

export class Target {
  constructor(dap){ this.dap = dap; this.sel = -1; }
  async dpRead(a){ return (await this.dap.transfer([{req: RQ.DP_R(a)}]))[0]; }
  async dpWrite(a, v){ await this.dap.transfer([{req: RQ.DP_W(a), val: v}]); }
  async select(ap, bank){
    const s = ((ap & 0xFF) << 24) | ((bank & 0xF) << 4);
    if (s !== this.sel){ await this.dpWrite(0x8, s); this.sel = s; }
  }
  async apRead(ap, reg){
    await this.select(ap, reg >> 4);
    return (await this.dap.transfer([{req: RQ.AP_R(reg & 0x0C)}]))[0];
  }
  async apWrite(ap, reg, v){
    await this.select(ap, reg >> 4);
    await this.dap.transfer([{req: RQ.AP_W(reg & 0x0C), val: v}]);
  }
  async dpInit(){
    // line reset (56 x 1), JTAG->SWD (0x9E 0xE7), line reset, >=2 idle cycles
    await this.dap.swjSeq(136, [0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF, 0x9E,0xE7,
                                0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF, 0x00]);
    const idr = await this.dpRead(0x0);
    log('DPIDR = ' + hex(idr));
    await this.dpWrite(0x0, 0x0000001E);   // ABORT: clear all sticky errors
    this.sel = -1;
    await this.select(0, 0);
    await this.dpWrite(0x4, 0x50000000);   // CSYSPWRUPREQ | CDBGPWRUPREQ
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++){
      try {
        const s = await this.dpRead(0x4);
        if (((s & 0xA0000000) >>> 0) === 0xA0000000) ok = true;
      } catch (e){ try { await this.dpWrite(0x0, 0x1E); } catch (e2){} }
    }
    if (!ok) throw mkErr('errPowerUp');
    log('Debug power-up OK');
  }
  async memInit(){
    // AHB-AP (AP 0): CSW = word size, auto-increment single
    await this.apWrite(0, 0x00, 0x23000052);
  }
  async read32(addr){
    await this.select(0, 0);
    const v = await this.dap.transfer([{req: RQ.AP_W(0x04), val: addr}, {req: RQ.AP_R(0x0C)}]);
    return v[0];
  }
  async write32(addr, val){
    await this.select(0, 0);
    await this.dap.transfer([{req: RQ.AP_W(0x04), val: addr}, {req: RQ.AP_W(0x0C), val: val}]);
  }
  // Build the (TAR, TransferBlock) command stream for a memory range, chunked on
  // TAR auto-increment (1 KB) boundaries and DAP packet size.
  _blockPlan(addr, count){
    const plan = [];
    let i = 0, a = addr >>> 0;
    while (i < count){
      const room = (0x400 - (a & 0x3FF)) >> 2;
      const n = Math.min(room, this.dap.maxBlockWords, count - i);
      plan.push({addr: a, off: i, n: n});
      a = (a + n * 4) >>> 0; i += n;
    }
    return plan;
  }
  // block ops are pipelined: up to dap.pipeWindow packets in flight
  async writeBlock(addr, words, onChunk){
    await this.select(0, 0);
    const cmds = [], metas = [];
    for (const c of this._blockPlan(addr, words.length)){
      cmds.push(this.dap.xferPacket([{req: RQ.AP_W(0x04), val: c.addr}]));
      metas.push(null);
      cmds.push(this.dap.blockWritePacket(RQ.AP_W(0x0C), words, c.off, c.n));
      metas.push(c);
    }
    await this.dap.pipeline(cmds, (r, idx) => {
      const m = metas[idx];
      if (!m){                                      // TAR write response
        if (r[0] !== 0x05 || (r[2] & 0x07) !== 1) throw mkErr('errSwdFail', {ack: r[2] & 0x07});
      } else {                                      // block write response
        const cnt = r[1] | (r[2] << 8);
        if (r[0] !== 0x06 || (r[3] & 0x07) !== 1 || cnt !== m.n) throw mkErr('errSwdFail', {ack: r[3] & 0x07});
        if (onChunk) onChunk(m.off + m.n, words.length);
      }
    });
  }
  async readBlock(addr, count, onChunk){
    await this.select(0, 0);
    const out = new Uint32Array(count);
    const cmds = [], metas = [];
    for (const c of this._blockPlan(addr, count)){
      cmds.push(this.dap.xferPacket([{req: RQ.AP_W(0x04), val: c.addr}]));
      metas.push(null);
      cmds.push(this.dap.blockReadPacket(RQ.AP_R(0x0C), c.n));
      metas.push(c);
    }
    await this.dap.pipeline(cmds, (r, idx) => {
      const m = metas[idx];
      if (!m){
        if (r[0] !== 0x05 || (r[2] & 0x07) !== 1) throw mkErr('errSwdFail', {ack: r[2] & 0x07});
      } else {
        const cnt = r[1] | (r[2] << 8);
        if (r[0] !== 0x06 || (r[3] & 0x07) !== 1 || cnt !== m.n) throw mkErr('errSwdFail', {ack: r[3] & 0x07});
        const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
        for (let i = 0; i < m.n; i++) out[m.off + i] = dv.getUint32(4 + i * 4, true);
        if (onChunk) onChunk(m.off + m.n, count);
      }
    });
    return out;
  }
}

/* --------------------- nRF52840 flash logic ------------------------- */
export const NRF = {
  NVMC_READY:     0x4001E400,
  NVMC_CONFIG:    0x4001E504,
  NVMC_ERASEPAGE: 0x4001E508,
  NVMC_ERASEALL:  0x4001E50C,
  NVMC_ERASEUICR: 0x4001E514,
  FICR_DEVICEID0: 0x10000060,
  FICR_DEVICEID1: 0x10000064,
  FICR_PART:      0x10000100,
  FICR_VARIANT:   0x10000104,
  DHCSR: 0xE000EDF0,
  AIRCR: 0xE000ED0C,
};

export async function pollNvmcReady(tgt, timeoutMs){
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl){
    if ((await tgt.read32(NRF.NVMC_READY)) & 1) return;
  }
  throw mkErr('errNvmcTimeout');
}
