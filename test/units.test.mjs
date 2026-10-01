/* Small pure pieces of the manager: file classification, telemetry decoding,
 * the battery rule, ACK outcomes, and translation completeness. */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { classifyFirmwareFile, MCUBOOT_IMAGE_MAGIC } from '../js/image.js';
import { batteryFrom, rssiFrom, batteryBlocks, applyTelemetry, isAwake, AWAKE_WINDOW_MS, trackerState, STATUS_FRESH_MS } from '../js/telemetry.js';
import { ackOutcome, RENDEZVOUS, DEFAULT_CHANNEL, busyLevel, busyText, calApplyEvent } from '../js/manage.js';
import { ACK, parseDongleStatus, parseScanResult, parseTrackerEvent, TEV } from '../js/ota.js';
import { EXTRA } from '../js/i18n_extra.js';
import { HELP_TEXT, HELP_LED_KEYS } from '../js/help.js';
import { toHex } from './fake_dongle.mjs';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !extra ? '' : '  -> ' + extra));
  if (!cond) fails++;
};
const enc = s => new TextEncoder().encode(s);

/* ---- classification ---- */
const uf2 = new Uint8Array(512); new DataView(uf2.buffer).setUint32(0, 0x0A324655, true);
check('uf2 by magic', classifyFirmwareFile(uf2) === 'uf2');
const bin = new Uint8Array(64); new DataView(bin.buffer).setUint32(0, MCUBOOT_IMAGE_MAGIC, true);
check('.update.bin by MCUboot magic', classifyFirmwareFile(bin) === 'trackerBin');
check('tracker hex from 0x0', classifyFirmwareFile(enc(toHex([[0x0, new Uint8Array(64).fill(1)]]))) === 'trackerHex');
check('dongle hex from 0x1000', classifyFirmwareFile(enc(toHex([[0x1000, new Uint8Array(64).fill(1)]]))) === 'dongleHex');
const signed = new Uint8Array(64); new DataView(signed.buffer).setUint32(0, MCUBOOT_IMAGE_MAGIC, true);
check('signed app hex above 0x1000 stays a tracker file', classifyFirmwareFile(enc(toHex([[0xC000, signed]]))) === 'trackerHex');
check('text that is not hex', classifyFirmwareFile(enc('hello world')) === 'unknown');
check('broken hex', classifyFirmwareFile(enc(':zz\n')) === 'unknown');
check('empty file', classifyFirmwareFile(new Uint8Array(0)) === 'unknown');
check('name is irrelevant: a .bin that is really a hex', classifyFirmwareFile(enc(toHex([[0x1000, new Uint8Array(16)]]))) === 'dongleHex');

/* ---- telemetry ---- */
const b = batteryFrom(0x80 | 85, 145);
check('battery percent from low 7 bits', b.present && b.pct === 85);
check('battery millivolts', b.mV === 3900, b.mV);
check('not charging below 4.31 V', !b.charging);
check('charging at 4.31 V and up', batteryFrom(0x80 | 30, 186).charging);
check('no battery byte = absent', !batteryFrom(0, 0).present);
check('255 = charged, 100%', batteryFrom(255, 170).charged && batteryFrom(255, 170).pct === 100);
check('rssi magnitude form', rssiFrom(52) === -52);
check('rssi signed form', rssiFrom(0xCC) === -52);
check('rssi 0 = none', rssiFrom(0) === null);
check('block below 20%', batteryBlocks(batteryFrom(0x80 | 19, 120), 20)?.pct === 19);
check('20% is enough', batteryBlocks(batteryFrom(0x80 | 20, 120), 20) === null);
check('charging lifts the block', batteryBlocks(batteryFrom(0x80 | 5, 190), 20) === null);
check('no battery never blocks', batteryBlocks(batteryFrom(0, 0), 20) === null);
check('unknown battery never blocks', batteryBlocks(undefined, 20) === null);
const e = {};
const sub = new Uint8Array(16); sub[0] = 0; sub[1] = 3; sub[2] = 0x80 | 40; sub[3] = 130; sub[12] = 1; sub[13] = 2; sub[14] = 3; sub[15] = 70;
applyTelemetry(e, sub, 1000);
check('info packet: fw, battery, rssi', e.fw === '1.2.3' && e.battery.pct === 40 && e.rssi === -70, JSON.stringify(e));
check('awake within the window', isAwake(e, 1000 + AWAKE_WINDOW_MS - 1));
check('dozing after the window', !isAwake(e, 1000 + AWAKE_WINDOW_MS + 1));

/* ---- ACK outcomes ---- */
check('OK', ackOutcome({ status: ACK.OK }) === 'ok');
check('no ACK', ackOutcome(null) === 'noAnswer');
check('busy', ackOutcome({ status: ACK.EBUSY }) === 'busy');
check('STARTED then OK', ackOutcome({ status: ACK.STARTED, final: { status: ACK.OK } }, { final: true }) === 'ok');
check('STARTED then ENOENT = partial', ackOutcome({ status: ACK.STARTED, final: { status: ACK.ENOENT } }, { final: true }) === 'partial');
check('STARTED, no completion = partial', ackOutcome({ status: ACK.STARTED }, { final: true }) === 'partial');
check('EINVAL = fail', ackOutcome({ status: ACK.EINVAL }) === 'fail');

/* ---- channels match the firmware ---- */
check('rendezvous channels 76, 2, 24, 50', RENDEZVOUS.join() === '76,2,24,50' && DEFAULT_CHANNEL === 76);

/* ---- every new string in all three languages ---- */
const langs = ['zh', 'en', 'ja'];
const all = new Set(langs.flatMap(l => Object.keys(EXTRA[l])));
for (const l of langs){
  const miss = [...all].filter(k => !(k in EXTRA[l]));
  check(`manager strings complete in ${l}`, !miss.length, miss.join(', '));
}
/* ...and every data-i18n key in the page resolves in all three */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const keys = [...html.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map(m => m[1]);
const i18nSrc = readFileSync(join(root, 'js/i18n.js'), 'utf8');
const blocks = Object.fromEntries(langs.map(l => {
  const start = i18nSrc.indexOf(`\n${l}: {`);
  const end = i18nSrc.indexOf('\n},', start);
  return [l, i18nSrc.slice(start, end)];
}));
for (const l of langs){
  const miss = keys.filter(k => !(k in EXTRA[l]) && !new RegExp(`\\b${k}\\s*:`).test(blocks[l]));
  check(`page keys all translated in ${l}`, !miss.length, [...new Set(miss)].join(', '));
}
for (const l of langs){
  const h = HELP_TEXT[l];
  check(`help complete in ${l}`, HELP_LED_KEYS.every(k => h.led[k]) && h.trkBtn.length === HELP_TEXT.en.trkBtn.length
        && h.dglBtn.length === HELP_TEXT.en.dglBtn.length && h.faq.length === HELP_TEXT.en.faq.length);
}

/* ---- dongle STATUS and scan results (receiver rcv_hid_cmd.h) ---- */
{
  // ids 0..3 in data[3]: 0 gone, 1 dozing, 2 awake, 1 dozing
  const st = parseDongleStatus([5, 24, 0x03, 0b01100100, 0, 0, 0x80], 1000);
  check('status: count, channel, flags', st.stored === 5 && st.channel === 24 && st.explicit && st.pairing && !st.scanning);
  check('status: 2-bit link states per id', JSON.stringify(st.links.slice(0, 4)) === '[0,1,2,1]' && st.links[15] === 2, JSON.stringify(st.links));
  const r = parseScanResult([1, 4, 50, 0x2C, 0x01, 72, 0x05]);
  check('scan result: channel, busy LE, peak, flags', r.channel === 50 && r.busy === 300 && r.peak === -72 && r.rendezvous && !r.current && r.best, JSON.stringify(r));
  check('busy levels 5% / 20%', busyLevel(49) === 'good' && busyLevel(50) === 'fair' && busyLevel(200) === 'fair' && busyLevel(201) === 'bad');
  check('busy text', busyText(3) === '0.3%' && busyText(123) === '12%' && busyText(1000) === '100%', busyText(3) + ' ' + busyText(123));
  const now = 50000;
  const d = { seen: new Map([[0, { lastSeen: now - 100 }], [1, {}], [2, {}]]), status: null };
  check('state without STATUS: awake by telemetry, otherwise cannot tell', trackerState(d, 0, now) === 'awake' && trackerState(d, 1, now) === 'asleep');
  d.status = { links: [0, 1, 0, 2], at: now - 1000 };
  check('state with STATUS: standby / off', trackerState(d, 1, now) === 'standby' && trackerState(d, 2, now) === 'off');
  check('telemetry beats a stale link state', trackerState(d, 0, now) === 'awake');
  d.status.at = now - STATUS_FRESH_MS - 1;
  check('stale STATUS is not trusted', trackerState(d, 1, now) === 'asleep');
}

/* ---- calibration events ---- */
{
  const e = parseTrackerEvent([251, 0, 225, 4 | (2 << 4), 3, 1, 2, 0, 0, 9, 0, 0x34, 0x12, 1, 4, 5]);
  check('event record decoded', e.event === 4 && e.outcome === 2 && e.tracker === 3 && e.nonce === 0x201 && e.seq === 9 && e.op === 0x1234 && e.kind === 1 && e.detail === 5, JSON.stringify(e));
  const run = { since: 1000, targets: new Set([1, 2]), results: new Map() };
  const ev = (tracker, event, outcome, op, extra = {}) => ({ tracker, event, outcome, op, kind: TEV.KIND_ZRO, phase: 4, detail: 0, ...extra });
  check('event before the command is ignored', !calApplyEvent(run, ev(1, TEV.END, TEV.SUCCESS, 5), 900));
  check('auto-origin calibration ignored', !calApplyEvent(run, ev(1, TEV.BEGIN, 0, 6, { kind: TEV.KIND_ZRO | TEV.ORIGIN_AUTO }), 1100));
  check('untargeted tracker ignored', !calApplyEvent(run, ev(3, TEV.BEGIN, 0, 6), 1100));
  calApplyEvent(run, ev(1, TEV.BEGIN, 0, 6), 1100);
  check('begin -> running', run.results.get(1).st === 'run');
  check('END of another operation ignored', !calApplyEvent(run, ev(1, TEV.END, TEV.SUCCESS, 5), 1200) && run.results.get(1).st === 'run');
  calApplyEvent(run, ev(1, TEV.END, TEV.FAILED, 6, { detail: TEV.R_MOTION }), 1300);
  check('failed END keeps the reason', run.results.get(1).st === 'fail' && run.results.get(1).why === 'calR_motion');
  calApplyEvent(run, ev(2, TEV.END, TEV.SUCCESS, 8), 1300);
  check('END without a seen begin still counts', run.results.get(2).st === 'ok');
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
