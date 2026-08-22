import { Dongle, OtaClient, HID, ST, parseFwInfo } from '../js/ota.js';
import { crc32 } from '../js/util.js';

/* Emulates the dongle + one or more trackers well enough to exercise the
 * client's sequencing: BEGIN answered only after an erase delay, DATA consumed
 * in order with an optional drop rate, VERIFY gated on the CRC actually
 * matching, ACTIVATE completing. */
class FakeDevice {
  constructor(opts = {}){
    this.opened = true;
    this.productName = opts.name || 'NekoTora Dongle';
    this.listeners = [];
    this.o = Object.assign({ trackers: [4], eraseMs: 300, dropRate: 0, board: 'promicro_uf2/nrf52840/spi' }, opts);
    this.st = new Map(this.o.trackers.map(id => [id, { next: 0, buf: [], ready: false, size: 0, crc: 0 }]));
    // Trackers report progress periodically, which is what unblocks the
    // client when its in-flight window is full.
    this.progress = setInterval(() => {
      for (const [tid, s] of this.st) if (s.ready) this._status(tid, ST.RECEIVING);
    }, 20);
    this.telemetry = setInterval(() => {
      const f = new Uint8Array(64);
      this.o.trackers.forEach((id, i) => { f[i*16] = 1; f[i*16+1] = id; });
      this._in(f);
    }, 4);
  }
  addEventListener(_, fn){ this.listeners.push(fn); }
  removeEventListener(_, fn){ this.listeners = this.listeners.filter(l => l !== fn); }
  async open(){ this.opened = true; }
  async close(){ clearInterval(this.telemetry); clearInterval(this.progress); this.opened = false; }
  _in(bytes){ const dv = new DataView(bytes.buffer); for (const l of this.listeners) l({ data: dv }); }
  _status(id, status){
    const s = this.st.get(id); const f = new Uint8Array(64); const dv = new DataView(f.buffer);
    f[0] = HID.STATUS; f[1] = id; f[2] = status;
    dv.setUint16(3, s.next, false); dv.setUint32(5, s.buf.length, true); f[9] = 0;
    this._in(f);
  }
  async sendReport(_, data){
    const p = new Uint8Array(data); const dv = new DataView(p.buffer);
    const type = p[0], id = p[1];
    if (type === HID.BEGIN){
      const s = this.st.get(id); if (!s) return;
      s.size = dv.getUint32(2, true); s.crc = dv.getUint32(6, true);
      const board = new TextDecoder().decode(p.subarray(13, 13 + p.subarray(13).indexOf(0)));
      if (board !== this.o.board){ setTimeout(() => this._status(id, ST.BOARD_MISMATCH), 20); return; }
      s.buf = []; s.next = 0;
      // answer only after the erase delay - this is what forces client retries
      setTimeout(() => { s.ready = true; this._status(id, ST.READY); }, this.o.eraseMs);
    } else if (type === HID.DATA){
      const seq = dv.getUint16(2, false);
      if (this.o.dieAfter && seq > this.o.dieAfter) return;   // tracker gone
      if (Math.random() < this.o.dropRate) return;
      for (const [tid, s] of this.st){
        if (!s.ready) continue;
        if (seq === s.next){ s.buf.push(...p.subarray(4, 64)); s.next++; }
      }
      // real firmware reports progress on its own cadence, not per packet
    } else if (type === HID.VERIFY){
      const s = this.st.get(id); if (!s) return;
      const got = new Uint8Array(s.buf).subarray(0, s.size);
      setTimeout(() => this._status(id, crc32(got) === s.crc ? ST.VERIFY_OK : ST.VERIFY_FAIL), 30);
    } else if (type === HID.ACTIVATE){
      setTimeout(() => this._status(id, ST.COMPLETE), 30);
    }
  }
}

async function run(label, opts, image, board, expectOk){
  const dev = new FakeDevice(opts);
  const d = new Dongle(dev); await d.open();
  const c = new OtaClient(d);
  const seen = new Set();
  const t0 = Date.now();
  const res = await c.update(opts.trackers, image, board, e => seen.add(e.stage));
  await d.close();
  const pass = JSON.stringify(res.ok) === JSON.stringify(expectOk);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`      ok=[${res.ok}] failed=[${res.failed.map(f => f.id + ':' + f.error.i18nKey)}] ` +
              `stages=${[...seen].join('>')} ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return pass;
}

const size = 60 * 900 + 17;                       // ~53 KB, deliberately not packet-aligned
const data = new Uint8Array(size);
for (let i = 0; i < size; i++) data[i] = (i * 7 + (i >> 8)) & 0xFF;
data[0]=0x3D; data[1]=0xB8; data[2]=0xF3; data[3]=0x96;   // MCUboot magic
const image = { data, baseAddress: 0, crc32: crc32(data) };
const BOARD = 'promicro_uf2/nrf52840/spi';

let all = true;
all &= await run('single tracker, clean link', { trackers: [4] }, image, BOARD, [4]);
all &= await run('three trackers in parallel', { trackers: [0, 4, 9] }, image, BOARD, [0, 4, 9]);
all &= await run('0.2% HID loss (realistic)', { trackers: [4], dropRate: 0.002 }, image, BOARD, [4]);
all &= await run('2% HID loss (stress)', { trackers: [4], dropRate: 0.02 }, image, BOARD, [4]);
all &= await run('link dies mid-transfer', { trackers: [4], dieAfter: 200 }, image, BOARD, []);
all &= await run('slow slot-1 erase (8s)', { trackers: [4], eraseMs: 8000 }, image, BOARD, [4]);
all &= await run('wrong board target rejected', { trackers: [4] }, image, 'test54l/nrf54l15/cpuapp', []);
all &= await run('corrupt image fails VERIFY', { trackers: [4] },
                 { data, baseAddress: 0, crc32: (image.crc32 ^ 0xFFFF) >>> 0 }, BOARD, []);
console.log(all ? '\nALL PASS' : '\nFAILURES');
process.exit(all ? 0 : 1);
