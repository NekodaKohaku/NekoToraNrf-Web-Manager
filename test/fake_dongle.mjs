/* Shared by dongle.test.mjs and dongle-ui.test.mjs: a stand-in for the
 * receiver's self-OTA (src/receiver_ota.c) and a minimal Intel HEX writer. */
import { HID, ST, DONGLE_ID } from '../js/ota.js';
import { crc32 } from '../js/util.js';

export const BOARD = 'promicro_uf2/nrf52840';

export class FakeSelfDongle {
  constructor(o = {}){
    this.o = Object.assign({ board: BOARD, eraseMs: 150, dropOnce: -1, version: [0, 6, 9], bootloader: 1 }, o);
    this.opened = true; this.productName = 'NekoTora Dongle'; this.listeners = [];
    this.s = null; this.lastStatus = 0; this.dropped = false; this.reset = false; this.cmds = [];
  }
  addEventListener(_, fn){ this.listeners.push(fn); }
  removeEventListener(_, fn){ this.listeners = this.listeners.filter(l => l !== fn); }
  async open(){ this.opened = true; }
  async close(){ this.opened = false; }
  _in(b){ const dv = new DataView(b.buffer); for (const l of this.listeners) l({ data: dv }); }
  /* 66-byte FW_INFO record in six 13-byte chunks, as rcv_ota_send_fw_info(). */
  _fwInfo(){
    const info = new Uint8Array(66);
    info[0] = HID.FW_INFO; info[1] = DONGLE_ID;
    info.set(this.o.version, 2);
    info[13] = this.o.bootloader; info[14] = 1;
    info.set(new TextEncoder().encode(this.o.board), 15);
    info[64] = 0x01;                                  // flash base 0x1000 >> 12, BE at 63
    for (let chunk = 0; chunk < 6; chunk++){
      const f = new Uint8Array(64);
      f[0] = HID.FW_INFO; f[1] = DONGLE_ID; f[2] = chunk;
      const off = 2 + chunk * 13;
      f.set(info.subarray(off, Math.min(66, off + 13)), 3);
      setTimeout(() => this._in(f), 2 + chunk);
    }
  }
  _status(code){
    const f = new Uint8Array(64); const dv = new DataView(f.buffer);
    f[0] = HID.STATUS; f[1] = DONGLE_ID; f[2] = code;
    dv.setUint16(3, this.s ? this.s.next : 0, false);
    dv.setUint32(5, this.s ? this.s.bytes : 0, true);
    this.lastStatus = Date.now();
    setTimeout(() => this._in(f), 1);
  }
  async sendReport(_, data){
    const p = new Uint8Array(data); const dv = new DataView(p.buffer);
    if (p[0] === 254){ this.cmds.push([...p.subarray(0, 5)]); return; }
    if (p[1] !== DONGLE_ID || this.reset) return;
    const type = p[0];
    if (type === HID.QUERY_INFO) return this._fwInfo();
    if (type === HID.BEGIN){
      const board = new TextDecoder().decode(p.subarray(13, 13 + p.subarray(13).indexOf(0)));
      if (board !== this.o.board){ this.s = null; return this._status(ST.BOARD_MISMATCH); }
      this.s = { size: dv.getUint32(2, true), crc: dv.getUint32(6, true), base: dv.getUint16(61, false) << 12,
                 next: 0, bytes: 0, buf: [], state: 'wait', verified: false };
      setTimeout(() => { this.s.state = 'ready'; this._status(ST.READY); }, this.o.eraseMs);
    } else if (type === HID.DATA){
      const s = this.s; if (!s || (s.state !== 'ready' && s.state !== 'rx')) return;
      const seq = dv.getUint16(2, false);
      if (seq === this.o.dropOnce && !this.dropped){ this.dropped = true; return; }  // lost in transit
      if (seq < s.next) return;                                                        // duplicate
      if (seq > s.next){ s.state = 'error'; return this._status(ST.SEQ_ERROR); }        // gap is fatal
      const n = Math.min(60, s.size - seq * 60);
      s.buf.push(...p.subarray(4, 4 + n)); s.bytes += n; s.next++; s.state = 'rx';
      if (Date.now() - this.lastStatus >= 20) this._status(ST.RECEIVING);
    } else if (type === HID.VERIFY){
      const s = this.s; if (!s) return;
      if (s.bytes !== s.size){ s.state = 'error'; return this._status(ST.SEQ_ERROR); }
      const ok = crc32(new Uint8Array(s.buf)) === s.crc;
      s.verified = ok;
      setTimeout(() => this._status(ok ? ST.VERIFY_OK : ST.VERIFY_FAIL), 40);
    } else if (type === HID.ACTIVATE){
      if (!this.s || !this.s.verified) return this._status(ST.ERROR);
      this._status(ST.ACTIVATING);
      setTimeout(() => { this.reset = true; this.opened = false; if (this.o.onReset) this.o.onReset(this); }, 50);
    } else if (type === HID.ABORT){
      this.s = null;
    }
  }
}

/* ---- a small Intel HEX writer, so the image path is tested end to end ---- */
export function toHex(segments){
  const out = []; let upper = -1;
  const rec = (type, addr, bytes) => {
    const b = [bytes.length, (addr >> 8) & 0xFF, addr & 0xFF, type, ...bytes];
    const sum = (-b.reduce((a, v) => a + v, 0)) & 0xFF;
    out.push(':' + [...b, sum].map(v => v.toString(16).toUpperCase().padStart(2, '0')).join(''));
  };
  for (const [start, data] of segments){
    for (let i = 0; i < data.length; i += 16){
      const a = start + i;
      if ((a >>> 16) !== upper){ upper = a >>> 16; rec(4, 0, [(upper >> 8) & 0xFF, upper & 0xFF]); }
      rec(0, a & 0xFFFF, [...data.subarray(i, i + 16)]);
    }
  }
  rec(1, 0, []);
  return out.join('\n') + '\n';
}

