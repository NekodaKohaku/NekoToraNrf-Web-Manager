/* linkTest, against fake bootloaders.
 *
 * The bug this pins: upstream MCUboot ships with CONFIG_BOOT_MGMT_ECHO off, so
 * serial recovery has no echo command. It still answers - a well-formed SMP
 * response carrying rc = ENOTSUP - which means the link is demonstrably fine.
 * The old test read the missing `d` field as "nothing came back" and told the
 * customer to go check their wiring on a link that was working perfectly.
 *
 * linkTest only touches request/crcErrors/badLines/baudRate on the port, so a
 * plain object is enough to stand in for one.
 */
import { linkTest } from '../js/smp.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c){ pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } };

const MGMT_ERR_ENOTSUP = 8;

/* echoMax: largest payload echoed back. 0 = no echo command at all.
 * imageList: whether the image-list command answers.
 * dead: nothing answers. */
function fakePort({ echoMax = 0, imageList = true, dead = false } = {}){
  const calls = { echo: 0, list: 0 };
  return {
    calls,
    baudRate: 1000000,
    crcErrors: 0,
    badLines: 0,
    async request(op, group, id, payload){
      if (dead) throw new Error('timeout');
      if (group === 0 && id === 0){
        calls.echo++;
        if (!echoMax) return { op: op + 1, group, id, seq: 0, payload: { rc: MGMT_ERR_ENOTSUP } };
        const d = payload.d;
        if (d.length > echoMax) throw new Error('timeout');   // dropped, no reply
        return { op: op + 1, group, id, seq: 0, payload: { d } };
      }
      if (group === 1 && id === 0){
        calls.list++;
        if (!imageList) throw new Error('timeout');
        return { op: op + 1, group, id, seq: 0,
                 payload: { images: [{ slot: 0, version: '1.0.2', hash: new Uint8Array(32) }] } };
      }
      throw new Error('timeout');
    },
  };
}

/* ---- 1. the regression: no echo command, but the link is fine ---- */
{
  const p = fakePort({ echoMax: 0 });
  const r = await linkTest(p, { rounds: 5 });
  ok(!r.unusable, 'no echo command: link is NOT reported dead');
  ok(r.clean, 'no echo command: link reported clean');
  ok(r.echo === false, 'no echo command: flagged as no-echo');
  ok(r.ok === 5 && r.failed === 0, 'no echo command: all rounds passed');
  ok(p.calls.list >= 5, 'no echo command: fell back to image-list');
  ok(p.calls.echo === 1, 'no echo command: gave up echoing after one clean ENOTSUP');
}

/* ---- 2. echo exists, but only for small payloads ---- */
{
  const p = fakePort({ echoMax: 32 });
  const r = await linkTest(p, { rounds: 5 });
  ok(r.echo === true, 'small echo: echo used');
  ok(r.payload === 32, 'small echo: settled on the largest size that fits');
  ok(r.clean && r.ok === 5, 'small echo: link reported clean');
  ok(r.kbps > 0, 'small echo: throughput reported');
}

/* ---- 3. echo exists at full size ---- */
{
  const p = fakePort({ echoMax: 512 });
  const r = await linkTest(p, { rounds: 3 });
  ok(r.payload === 128, 'large echo: uses the largest size tried');
  ok(p.calls.list === 0, 'large echo: image-list not needed');
}

/* ---- 4. genuinely dead link ---- */
{
  const p = fakePort({ dead: true });
  const r = await linkTest(p, { rounds: 5 });
  ok(r.unusable, 'dead link: reported unusable');
  ok(!r.clean, 'dead link: not clean');
}

/* ---- 5. no echo AND no image-list: also dead ---- */
{
  const p = fakePort({ echoMax: 0, imageList: false });
  p.request = async (op, group, id) => {
    if (group === 0 && id === 0) throw new Error('timeout');
    throw new Error('timeout');
  };
  const r = await linkTest(p, { rounds: 5 });
  ok(r.unusable, 'silent bootloader: reported unusable');
}

/* ---- 6. answering but corrupting: not clean ---- */
{
  const p = fakePort({ echoMax: 128 });
  let n = 0;
  const inner = p.request.bind(p);
  p.request = async (...a) => { if (++n % 3 === 0){ p.crcErrors++; throw new Error('timeout'); } return inner(...a); };
  const r = await linkTest(p, { rounds: 9 });
  ok(!r.unusable, 'lossy link: still usable');
  ok(!r.clean, 'lossy link: reported not clean');
  ok(r.failed > 0, 'lossy link: failures counted');
  ok(r.crcErrors > 0, 'lossy link: CRC errors counted');
}

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASS'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
