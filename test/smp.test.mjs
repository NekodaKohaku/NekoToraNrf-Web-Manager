/* SMP framing round-trip.
 *
 * The encoder and the line parser are the two halves of the same format, so
 * feeding one into the other exercises base64 line splitting, the 0x06 0x09 /
 * 0x04 0x14 markers, the length prefix, CRC-16 and CBOR in one go. A fake port
 * plays the tracker: it decodes the request the client just sent and answers
 * with a well-formed response.
 */
import { SmpPort, crc16, cborEncode, cborDecode, encodeFrames, b64encode, uploadImage } from '../js/smp.js';

let fails = 0;
const check = (n, c, x = '') => { if (c) console.log('PASS  ' + n); else { console.log('FAIL  ' + n + (x ? '  -> ' + x : '')); fails++; } };

/* --- CBOR round-trip --- */
for (const obj of [{ d: 'hi' }, { rc: 0, off: 4096 }, { image: 0, len: 316000, off: 0, data: new Uint8Array([1,2,3,255]) }]){
  const back = cborDecode(new Uint8Array(cborEncode(obj)));
  const same = Object.keys(obj).every(k => obj[k] instanceof Uint8Array
    ? [...obj[k]].join() === [...back[k]].join() : back[k] === obj[k]);
  check('CBOR round-trip ' + JSON.stringify(Object.keys(obj)), same, JSON.stringify(back));
}

/* --- CRC-16/XMODEM against a known vector --- */
check('crc16("123456789") == 0x31C3', crc16(new TextEncoder().encode('123456789')) === 0x31C3,
      '0x' + crc16(new TextEncoder().encode('123456789')).toString(16));

/* --- framing: long payload must split across continuation lines --- */
const big = cborEncode({ off: 0, data: new Uint8Array(512).fill(0xAB) });
const frames = encodeFrames(new Uint8Array(big));
check('long payload uses continuation frames', frames.length > 1, frames.length + ' frame(s)');
check('first frame carries 0x06 0x09', frames[0][0] === 0x06 && frames[0][1] === 0x09);
check('later frames carry 0x04 0x14', frames.slice(1).every(f => f[0] === 0x04 && f[1] === 0x14));
check('every frame <= 127 bytes', frames.every(f => f.length <= 127),
      Math.max(...frames.map(f => f.length)) + ' max');
check('every frame ends with newline', frames.every(f => f[f.length - 1] === 0x0A));

/* --- full request/response over a fake port --- */
class FakePort {
  constructor(reply){ this.reply = reply; this.buf = []; this.chunks = []; this.uploaded = 0;
    const self = this;
    this.readable = { getReader(){ return {
      read(){ return new Promise(res => { self._pump = v => res({ value: v, done: false }); }); },
      cancel(){ return Promise.resolve(); }, releaseLock(){} }; } };
    this.writable = { getWriter(){ return {
      write(b){ self._onWrite(b); return Promise.resolve(); }, releaseLock(){} }; } };
  }
  async open(){} async close(){}
  _onWrite(bytes){
    for (const b of bytes){
      this.buf.push(b);
      if (b === 0x0A){ this._line(new Uint8Array(this.buf)); this.buf = []; }
    }
  }
  _line(line){
    const first = line[0] === 0x06 && line[1] === 0x09;
    if (!first && !(line[0] === 0x04 && line[1] === 0x14)) return;
    let s = '';
    for (let i = 2; i < line.length; i++){ const c = line[i]; if (c !== 0x0A && c !== 0x0D) s += String.fromCharCode(c); }
    const bin = atob(s); const dec = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) dec[i] = bin.charCodeAt(i);
    if (first){ this.expect = (dec[0] << 8) | dec[1]; this.acc = [...dec.slice(2)]; }
    else this.acc.push(...dec);
    if (this.acc.length < this.expect) return;
    const all = new Uint8Array(this.acc.slice(0, this.expect));
    const data = all.slice(0, all.length - 2);
    const rx = (all[all.length - 2] << 8) | all[all.length - 1];
    if (crc16(data) !== rx) throw new Error('device saw a bad CRC');
    this._respond(data);
  }
  _respond(req){
    const group = (req[4] << 8) | req[5], seq = req[6], id = req[7];
    const payload = cborDecode(req.slice(8)) || {};
    let rsp = this.reply(group, id, payload, this);
    const body = new Uint8Array(cborEncode(rsp));
    const h = new Uint8Array(8 + body.length);
    h[0] = 3; h[2] = body.length >> 8; h[3] = body.length & 0xFF;
    h[4] = group >> 8; h[5] = group & 0xFF; h[6] = seq; h[7] = id;
    h.set(body, 8);
    const total = h.length + 2;
    const frame = new Uint8Array(2 + h.length + 2);
    frame[0] = total >> 8; frame[1] = total & 0xFF;
    frame.set(h, 2);
    const c = crc16(h);
    frame[frame.length - 2] = c >> 8; frame[frame.length - 1] = c & 0xFF;
    const b64 = b64encode(frame);
    const out = new TextEncoder().encode('\x06\x09' + b64 + '\n');
    setTimeout(() => this._pump && this._pump(out), 1);
  }
}

const port = new FakePort((group, id, payload, self) => {
  if (group === 0 && id === 0) return { d: payload.d };           // echo
  if (group === 0 && id === 5) return { rc: 0 };                  // reset
  if (group === 1 && id === 1){                                   // image upload
    self.uploaded = (payload.off || 0) + (payload.data ? payload.data.length : 0);
    return { rc: 0, off: self.uploaded };
  }
  return { rc: 8 };
});

const smp = new SmpPort(port);
await smp.open();

const echo = await smp.echo(2000);
check('echo replies with same payload', echo && echo.payload.d === 'hi', JSON.stringify(echo && echo.payload));
check('echo reply matches sequence number', echo && echo.seq === smp.seq);

/* --- upload drives to completion and reports progress --- */
const fw = new Uint8Array(5000);
fw.set([0x3D, 0xB8, 0xF3, 0x96]);
for (let i = 4; i < fw.length; i++) fw[i] = i & 0xFF;
let lastPct = 0, calls = 0;
await uploadImage(smp, fw, { chunkSize: 128, onProgress: p => { calls++; lastPct = p.off / p.size; } });
check('upload transferred every byte', port.uploaded === fw.length, port.uploaded + '/' + fw.length);
check('progress reached 100%', Math.abs(lastPct - 1) < 1e-9, (lastPct * 100).toFixed(1) + '%');
check('progress reported per chunk', calls === Math.ceil(fw.length / 128), calls + ' calls');

/* --- chunk size ------------------------------------------------------
 * The default drives how many stop-and-wait round trips a whole image costs,
 * which is what dominates wired update time. It must also stay under the
 * bootloader's CONFIG_BOOT_SERIAL_MAX_RECEIVE_SIZE (1024) once the SMP header
 * and CBOR wrapper are added, or requests are dropped with no error at all. */
const { DFU_CHUNK_SIZE } = await import('../js/smp.js');
check('chunk size raised from the 128 default', DFU_CHUNK_SIZE >= 512, String(DFU_CHUNK_SIZE));

const probe = new FakePort((g, i2, payload, self) => {
  if (g === 1 && i2 === 1){ self.biggest = Math.max(self.biggest || 0, payload.data.length);
    self.uploaded = (payload.off || 0) + payload.data.length; return { rc: 0, off: self.uploaded }; }
  return { rc: 0 };
});
const smp2 = new SmpPort(probe);
await smp2.open();
const img2 = new Uint8Array(4000);
img2.set([0x3D, 0xB8, 0xF3, 0x96]);
await uploadImage(smp2, img2);
check('uploads use the full chunk', probe.biggest === DFU_CHUNK_SIZE, String(probe.biggest));
check('whole image still transferred', probe.uploaded === img2.length, probe.uploaded + '/' + img2.length);

/* Worst-case datagram must fit the bootloader buffer. */
const worst = cborEncode({ image: 0, len: 400000, off: 400000, data: new Uint8Array(DFU_CHUNK_SIZE) });
const datagram = 8 + worst.length + 2;
check('request fits BOOT_SERIAL_MAX_RECEIVE_SIZE (1024)', datagram <= 1024, datagram + ' bytes');

/* --- link quality detection -------------------------------------------
 * The first version of this test echoed a 256-byte payload and declared the
 * link broken when it came back empty. On real hardware that fired at 115200 -
 * the one rate known to work - because MCUboot's serial recovery echoes from a
 * much smaller buffer than the one it uses for image upload. So the size has
 * to be discovered, and a bootloader buffer limit must not be reported as a
 * baud rate fault.
 */
const { linkTest } = await import('../js/smp.js');

/* A port that echoes, but only up to `echoMax` bytes - like the real
 * bootloader. Larger requests get no reply at all. */
function echoPort({ echoMax = Infinity, corrupt = false } = {}){
  const p = new FakePort(() => ({ rc: 0 }));
  p._respond = function(req){
    const payload = cborDecode(req.slice(8)) || {};
    const seq = req[6], group = (req[4] << 8) | req[5], id = req[7];
    if (group === 0 && id === 0 && (payload.d || '').length > echoMax) return;  // silently dropped
    const body = new Uint8Array(cborEncode({ d: payload.d }));
    const h = new Uint8Array(8 + body.length);
    h[0] = 3; h[2] = body.length >> 8; h[3] = body.length & 0xFF;
    h[4] = group >> 8; h[5] = group & 0xFF; h[6] = seq; h[7] = id;
    h.set(body, 8);
    const frame = new Uint8Array(2 + h.length + 2);
    const total = h.length + 2;
    frame[0] = total >> 8; frame[1] = total & 0xFF;
    frame.set(h, 2);
    let c = crc16(h);
    if (corrupt) c ^= 0xFFFF;
    frame[frame.length - 2] = c >> 8; frame[frame.length - 1] = c & 0xFF;
    const out = new TextEncoder().encode('\x06\x09' + b64encode(frame) + '\n');
    setTimeout(() => this._pump && this._pump(out), 1);
  };
  return p;
}

// the regression: small echo buffer, healthy link
const small = echoPort({ echoMax: 32 });
const smpSmall = new SmpPort(small); await smpSmall.open();
const rSmall = await linkTest(smpSmall, { rounds: 5 });
check('small echo buffer is NOT called a link fault', rSmall.clean,
      JSON.stringify({ ok: rSmall.ok, payload: rSmall.payload, clean: rSmall.clean }));
check('payload size was discovered, not assumed', rSmall.payload === 32, String(rSmall.payload));

// generous buffer: uses the largest size
const roomy = echoPort({ echoMax: 1024 });
const smpBig = new SmpPort(roomy); await smpBig.open();
const rBig = await linkTest(smpBig, { rounds: 5 });
check('a generous buffer uses the largest payload', rBig.payload === 128, String(rBig.payload));
check('generous buffer reports clean', rBig.clean);

// genuinely corrupt link
const rot = echoPort({ echoMax: 1024, corrupt: true });
const smpRot = new SmpPort(rot); await smpRot.open();
const rRot = await linkTest(smpRot, { rounds: 3 });
check('corruption at every size is reported unusable', rRot.unusable && !rRot.clean, JSON.stringify(rRot));
check('CRC errors counted while probing', rRot.crcErrors > 0, String(rRot.crcErrors));

// completely silent link
const dead = new FakePort(() => ({ rc: 0 }));
dead._respond = function(){ /* nothing ever comes back */ };
const smpDead = new SmpPort(dead); await smpDead.open();
const rDead = await linkTest(smpDead, { rounds: 2 });
check('a silent link is unusable', rDead.unusable && rDead.payload === 0, JSON.stringify(rDead));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
