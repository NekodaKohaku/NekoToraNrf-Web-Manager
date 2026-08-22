/* enterRecovery, against a fake tracker.
 *
 * The case that matters here is the one that cannot be tested by hand without
 * two differently-flashed boards: an application whose console runs at one baud
 * rate and a bootloader whose recovery console runs at another. That happens in
 * the field for a real reason - wired DFU rewrites the application but cannot
 * rewrite MCUboot, so any unit updated over DFU after the rate changed has a
 * new application and an old bootloader.
 *
 * The earlier implementation sent `dfu` at a rate and then waited for the reply
 * at that same rate, so on such a unit it timed out while the tracker sat in
 * recovery, reachable, one rate away. That is exactly the "已經進入 MCUboot 但
 * 網頁卡住" symptom. These tests pin the fix.
 */
import { enterRecovery, encodeFrames, cborEncode, crc16 } from '../js/smp.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c){ pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } };

globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');

/* ---- a fake Web Serial port backed by a two-personality device ---- */

function makePort({ appBaud, bootBaud }){
  const dev = { inRecovery: false, opens: [], dfuSeenAt: [] };
  let baud = 0, chunks = [], notify = null, closed = true;

  const push = bytes => { chunks.push(bytes); if (notify){ const n = notify; notify = null; n(); } };

  /* MCUboot recovery answers an echo; a running application does not. */
  const answer = frameBytes => {
    if (!dev.inRecovery || baud !== bootBaud) return;
    const b64 = Buffer.from(frameBytes.slice(2, frameBytes.length - 1)).toString('binary');
    const body = Buffer.from(globalThis.atob(b64), 'binary');
    const smp = body.slice(2, body.length - 2);
    const [op, , , , g0, g1, seq, id] = smp;
    const payload = cborEncode({ r: 'hi' });
    const hdr = new Uint8Array(8);
    hdr[0] = op + 1; hdr[1] = 0;
    hdr[2] = payload.length >> 8; hdr[3] = payload.length & 0xff;
    hdr[4] = g0; hdr[5] = g1; hdr[6] = seq; hdr[7] = id;
    const out = new Uint8Array(8 + payload.length);
    out.set(hdr, 0); out.set(payload, 8);
    for (const f of encodeFrames(out)) push(f);
  };

  return {
    _dev: dev,
    async open({ baudRate }){
      if (!closed) throw new Error('already open');
      closed = false; baud = baudRate; chunks = []; dev.opens.push(baudRate);
    },
    async close(){ closed = true; if (notify){ const n = notify; notify = null; n(); } },
    get readable(){
      if (closed) return null;
      return { getReader: () => ({
        async read(){
          for (;;){
            if (closed) return { done: true };
            if (chunks.length) return { value: chunks.shift(), done: false };
            await new Promise(r => { notify = r; setTimeout(() => { if (notify === r){ notify = null; r(); } }, 20); });
          }
        },
        async cancel(){ closed = true; },
        releaseLock(){},
      }) };
    },
    get writable(){
      return { getWriter: () => ({
        async write(bytes){
          const txt = Buffer.from(bytes).toString('binary');
          if (txt.includes('dfu')){
            dev.dfuSeenAt.push(baud);
            /* Only the real application console understands the command. */
            if (baud === appBaud) dev.inRecovery = true;
            return;
          }
          answer(bytes);
        },
        releaseLock(){},
      }) };
    },
  };
}

const BAUDS = [1000000, 921600, 460800, 230400, 115200];

/* ---- 1. matched rates: the ordinary, already-working case ---- */
{
  const port = makePort({ appBaud: 1000000, bootBaud: 1000000 });
  const got = await enterRecovery(port, BAUDS, { perBaudMs: 3000 });
  ok(got && got.baudRate === 1000000, 'matched rates: recovery found at 1000000');
  if (got) await got.smp.close();
}

/* ---- 2. the regression: application 115200, bootloader 1000000 ---- */
{
  const port = makePort({ appBaud: 115200, bootBaud: 1000000 });
  const got = await enterRecovery(port, BAUDS, { perBaudMs: 3000 });
  ok(!!got, 'split rates: recovery is found at all');
  ok(got && got.baudRate === 1000000, 'split rates: found at the bootloader rate, not the one dfu was sent on');
  ok(port._dev.dfuSeenAt.includes(115200), 'split rates: dfu was in fact sent on the application rate');
  if (got) await got.smp.close();
}

/* ---- 3. the reverse split: application 1000000, bootloader 115200 ---- */
{
  const port = makePort({ appBaud: 1000000, bootBaud: 115200 });
  const got = await enterRecovery(port, BAUDS, { perBaudMs: 3000 });
  ok(got && got.baudRate === 115200, 'reverse split: found at 115200');
  if (got) await got.smp.close();
}

/* ---- 4. already in recovery: no dfu should be needed ---- */
{
  const port = makePort({ appBaud: 460800, bootBaud: 460800 });
  port._dev.inRecovery = true;
  const got = await enterRecovery(port, BAUDS, { perBaudMs: 3000 });
  ok(got && got.baudRate === 460800, 'already in recovery: found without rebooting');
  ok(port._dev.dfuSeenAt.length === 0, 'already in recovery: no dfu command sent');
  if (got) await got.smp.close();
}

/* ---- 5. nothing there: fails cleanly instead of hanging ---- */
{
  const port = makePort({ appBaud: -1, bootBaud: -1 });
  const got = await enterRecovery(port, [115200, 1000000], { perBaudMs: 400 });
  ok(got === null, 'dead device: returns null');
}

/* ---- 6. a forced single rate is honoured ---- */
{
  const port = makePort({ appBaud: 230400, bootBaud: 230400 });
  const got = await enterRecovery(port, [230400], { perBaudMs: 3000 });
  ok(got && got.baudRate === 230400, 'forced rate: works when it is the right one');
  ok(port._dev.opens.every(b => b === 230400), 'forced rate: no other rate is opened');
  if (got) await got.smp.close();
}

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASS'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
