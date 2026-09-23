/* The dongle updating itself (receiver self-OTA, target 0xFE).
 *
 * The fake below follows src/receiver_ota.c rather than the tracker relay:
 * DATA must arrive strictly in order (a gap is a terminal SEQ_ERROR, not a
 * replay), STATUS is sent at most every 20 ms while receiving, VERIFY refuses
 * an incomplete image, and ACTIVATE answers ACTIVATING and then the device
 * resets instead of reporting COMPLETE. */
import { Dongle, OtaClient } from '../js/ota.js';
import { parseAppHex } from '../js/image.js';
import { crc32 } from '../js/util.js';
import { FakeSelfDongle, toHex, BOARD } from './fake_dongle.mjs';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !extra ? '' : '  -> ' + extra));
  if (!cond) fails++;
};

/* ---- image ---- */
const body = new Uint8Array(40000).map((_, i) => (i * 13 + (i >> 7)) & 0xFF);
const tail = new Uint8Array(100).fill(0xA5);
const img = parseAppHex(toHex([[0x1000, body], [0x1000 + body.length + 32, tail]]), 'd.hex');
check('app hex: base is the first address', img.baseAddress === 0x1000, img.baseAddress);
check('app hex: one contiguous block', img.size === body.length + 32 + tail.length, img.size);
check('app hex: gap filled with 0xFF', img.data[body.length] === 0xFF && img.data[body.length + 31] === 0xFF);
check('app hex: CRC over the block', img.crc32 === crc32(img.data));
let threw = null;
try { parseAppHex(toHex([[0x0, body]]), 'tracker.hex'); } catch (e){ threw = e; }
check('tracker hex (starts at 0x0) refused', threw && threw.i18nKey === 'errWrongFormat');
threw = null;
try { parseAppHex(toHex([[0xDA000 - 16, new Uint8Array(32)]]), 'big.hex'); } catch (e){ threw = e; }
check('image past the self-OTA limit refused', threw && threw.i18nKey === 'errWrongFormat');

/* ---- transfer ---- */
async function run(label, opts, board, expect){
  const dev = new FakeSelfDongle(opts);
  const d = new Dongle(dev); await d.open();
  const c = new OtaClient(d);
  const stages = new Set();
  let err = null;
  try { await c.updateDongle(img, board, e => stages.add(e.stage)); } catch (e){ err = e; }
  await new Promise(r => setTimeout(r, 120));   // the reset follows ACTIVATING
  const got = err ? err.i18nKey : 'ok';
  check(label, got === expect, `got ${got}, stages ${[...stages].join('>')}`);
  return dev;
}

let dev = await run('clean update ends in a reset', {}, BOARD, 'ok');
check('  base address reached the dongle', dev.s && dev.s.base === 0x1000, dev.s && dev.s.base);
check('  device actually reset', dev.reset);
dev = await run('one lost packet: restarts once, then succeeds', { dropOnce: 300 }, BOARD, 'ok');
check('  second attempt completed', dev.reset);
await run('wrong board refused before anything is written', { board: 'other/nrf52840' }, BOARD, 'errOtaMismatch');
await run('slow staging erase still answered', { eraseMs: 5000 }, BOARD, 'ok');

/* corrupt CRC in BEGIN: VERIFY must catch it and nothing activates */
{
  const dev2 = new FakeSelfDongle();
  const d = new Dongle(dev2); await d.open();
  let err = null;
  try { await new OtaClient(d).updateDongle({ ...img, crc32: (img.crc32 ^ 1) >>> 0 }, BOARD); } catch (e){ err = e; }
  check('corrupt image fails VERIFY', err && err.i18nKey === 'errOtaVerify', err && err.i18nKey);
  check('  and is never activated', !dev2.reset);
}

/* recovery command */
{
  const dev3 = new FakeSelfDongle();
  const d = new Dongle(dev3); await d.open();
  await d.enterUf2();
  const c = dev3.cmds[0] || [];
  check('recovery sends the UF2 DFU command (254 / 217, UF2)', c[0] === 254 && c[2] === 217 && c[4] === 0, c.join(','));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
