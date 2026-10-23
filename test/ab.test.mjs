/* A/B trackers get the build for the slot they are not running from.
 *
 * One dongle, three trackers: an overwrite-mode board, an A/B board running
 * from slot A and one running from slot B. The manifest describes the
 * overwrite build at the top level and the A/B build as a variant. Each
 * tracker must receive its own file under its own board target - a slot-B
 * build on an overwrite board is unrecoverable there - and a manual file
 * that cannot be right for a tracker must not be sent to it.
 */
import { JSDOM } from '/tmp/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'), { url: 'https://example.test/' });
global.window = dom.window; global.document = dom.window.document;
global.location = dom.window.location; global.localStorage = dom.window.localStorage;
global.Blob = dom.window.Blob; global.URL = dom.window.URL;

const BOARD = 'promicro_uf2/nrf52840/spi';
const AB = BOARD + '+ab';
const SLOT_A = 0xC000, SLOT_B = 0x7D000;
const manifest = {
  version: '1.0.6', versionCode: 0x010006, boardTarget: BOARD,
  hex: 'ow.hex', bin: 'ow.update.bin', date: '2026-10-18',
  variants: [{ boardTarget: AB, hex: 'ab.hex', bin: 'ab.update.bin',
               binSlot1: 'ab.slot1.update.bin', slotBase: [SLOT_A, SLOT_B] }],
};
const devices = JSON.parse(readFileSync(join(root, 'devices.json'), 'utf8'));

/* A minimal signed image: header, vector table pointing into `slot`. The
 * size differs per file so the BEGIN packet says which one was sent. */
function image(slot, size, ver = [1, 0, 6]){
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x96F3B83D, true);
  dv.setUint16(8, 0x200, true);
  dv.setUint32(12, size - 0x200, true);
  b[20] = ver[0]; b[21] = ver[1]; dv.setUint16(22, ver[2], true);
  dv.setUint32(0x200, 0x20010000, true);
  dv.setUint32(0x204, (slot + 0x200 + 0x1001) | 1, true);
  return b;
}
const files = {
  'ow.update.bin': image(SLOT_A, 1200),
  'ab.update.bin': image(SLOT_A, 1260),
  'ab.slot1.update.bin': image(SLOT_B, 1320),
};
const sizeToFile = new Map(Object.entries(files).map(([n, b]) => [b.length, n]));

global.fetch = async u => {
  const s = String(u);
  if (s.endsWith('devices.json')) return { ok: true, json: async () => devices };
  if (s.endsWith('latest.json'))  return { ok: true, json: async () => manifest };
  const name = Object.keys(files).find(n => s.endsWith('/' + n));
  const b = name ? files[name] : new Uint8Array(0);
  return { ok: true, arrayBuffer: async () => b.slice().buffer, text: async () => '' };
};

const { HID, ST } = await import(pathToFileURL(join(root, 'js/ota.js')).href);

/* id -> what the tracker reports */
const trackers = {
  0: { board: BOARD, bl: 3, base: 0, ver: [1, 0, 5], flags: 0 },
  1: { board: AB, bl: 4, base: SLOT_A, ver: [1, 0, 5], flags: 0x81 },
  2: { board: AB, bl: 5, base: SLOT_B, ver: [1, 0, 5], flags: 0x81, confirmMs: 5000 },
  3: { board: AB, bl: 4, base: SLOT_A, ver: [1, 0, 5], flags: 0x81, revert: true },
};
/* What the tracker reports after its reset: an A/B tracker boots the new
 * slot unconfirmed and confirms a little later; one marked `revert` comes
 * back on the old slot and version, as after MCUboot erased the new image. */
function rebooted(t){
  if (t.bl === 3){ t.ver = [1, 0, 6]; return; }
  if (t.revert) return;
  t.bl = t.bl === 4 ? 5 : 4;
  t.base = t.bl === 4 ? SLOT_A : SLOT_B;
  t.ver = [1, 0, 6];
  t.flags = 0x80;
  setTimeout(() => { t.flags = 0x81; }, t.confirmMs || 400);
}
const begins = [];   // {id, board, file}

function makeDongle(ids){
  const listeners = [];
  const emit = b => { const dv = new DataView(b.buffer); for (const l of listeners) l({ data: dv }); };
  const st = new Map();
  const telemetry = setInterval(() => {
    const f = new Uint8Array(64);
    ids.forEach((id, i) => { f[i * 16] = 1; f[i * 16 + 1] = id; });
    emit(f);
  }, 5);
  const progress = setInterval(() => {
    for (const [tid, s] of st) if (s.ready){
      const f = new Uint8Array(64); const dv = new DataView(f.buffer);
      f[0] = HID.STATUS; f[1] = tid; f[2] = ST.RECEIVING;
      dv.setUint16(3, s.next, false); dv.setUint32(5, s.next * 60, true);
      emit(f);
    }
  }, 15);
  const status = (tid, code) => { const f = new Uint8Array(64); f[0] = HID.STATUS; f[1] = tid; f[2] = code; emit(f); };
  return {
    opened: true, productName: 'NekoTora Dongle',
    addEventListener: (_, fn) => listeners.push(fn), removeEventListener: () => {},
    open: async () => {}, close: async () => { clearInterval(telemetry); clearInterval(progress); },
    sendReport: async (_, data) => {
      const p = new Uint8Array(data), dv = new DataView(p.buffer);
      const type = p[0], tid = p[1];
      if (type === HID.QUERY_INFO){
        const t = trackers[tid] || { board: 'dongle', bl: 1, base: 0 };   // the dongle itself
        const info = new Uint8Array(66); const idv = new DataView(info.buffer);
        [info[2], info[3], info[4]] = t.ver || [1, 0, 5];
        info[13] = t.bl; info[14] = 1;
        new TextEncoder().encodeInto(t.board, info.subarray(15));
        info[62] = t.flags || 0;
        idv.setUint16(63, t.base >>> 12, false);
        setTimeout(() => { for (let i = 0; i < 6; i++){
          const f = new Uint8Array(64);
          f[0] = HID.FW_INFO; f[1] = tid; f[2] = i;
          f.set(info.subarray(2 + i * 13, 2 + i * 13 + 13), 3);
          emit(f);
        } }, 5);
      } else if (type === HID.BEGIN){
        let end = 13; while (end < 61 && p[end]) end++;
        begins.push({ id: tid, board: new TextDecoder().decode(p.subarray(13, end)),
                      file: sizeToFile.get(dv.getUint32(2, true)) });
        st.set(tid, { ready: false, next: 0 });
        setTimeout(() => { const s = st.get(tid); if (s){ s.ready = true; status(tid, ST.READY); } }, 20);
      } else if (type === HID.DATA){
        const seq = dv.getUint16(2, false);
        for (const [, s] of st) if (s.ready && seq === s.next) s.next++;
      } else if (type === HID.VERIFY){
        setTimeout(() => status(tid, ST.VERIFY_OK), 10);
      } else if (type === HID.ACTIVATE){
        setTimeout(() => { status(tid, ST.COMPLETE); st.delete(tid); if (trackers[tid]) rebooted(trackers[tid]); }, 10);
      }
    },
  };
}

Object.defineProperty(global, 'navigator', {
  value: { language: 'en',
           hid: { requestDevice: async () => [makeDongle([0, 1, 2, 3])], getDevices: async () => [], addEventListener: () => {} } },
  configurable: true,
});

await import(pathToFileURL(join(root, 'js/app.js')).href);
await new Promise(r => setTimeout(r, 300));

let fails = 0;
const check = (n, c, x = '') => { if (c) console.log('PASS  ' + n); else { console.log('FAIL  ' + n + (x ? '  -> ' + x : '')); fails++; } };
const $ = id => document.getElementById(id);
const click = id => $(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const boxes = () => [...$('trackerList').querySelectorAll('input[type=checkbox]')];

click('btnConnectDongle');
await new Promise(r => setTimeout(r, 6000));

check('four trackers listed', boxes().length === 4, String(boxes().length) + ' log: ' + (document.getElementById('log') ? document.getElementById('log').textContent.slice(-600) : ''));
check('A/B trackers are not "different model"', boxes().every(b => !b.disabled),
      boxes().map(b => b.disabled).join(','));
check('all four pre-selected as outdated', boxes().filter(b => b.checked).length === 4);

click('btnStart');
const rowState = id => { const el = $('trkProgress').querySelector(`[data-tid="${id}"]`); return el ? el.querySelector('.tpState').textContent : ''; };
let sawConfirming = false;
const sampler = setInterval(() => { if ([1, 2].some(id => rowState(id) === 'Confirming')) sawConfirming = true; }, 20);
let resultAt = 0;
const resultWatch = setInterval(() => { if (!resultAt && !$('resultOk').classList.contains('hidden')) resultAt = Date.now(); }, 20);
const startedAt = Date.now();
await new Promise(r => setTimeout(r, 6000));
const hintAtResult = $('okHint').textContent;
const row3AtResult = rowState(3);
await new Promise(r => setTimeout(r, 14000));
clearInterval(sampler); clearInterval(resultWatch);
const listBadge = id => {
  const row = [...$('trackerList').querySelectorAll('.trk')].find(r => (r.querySelector('.tName') || {}).textContent === 'Tracker ' + id);
  return row ? row.querySelector('.tState').textContent : '';
};

const by = id => begins.find(b => b.id === id) || {};
check('overwrite board: top-level build', by(0).file === 'ow.update.bin', by(0).file);
check('overwrite board: its own board target', by(0).board === BOARD, by(0).board);
check('A/B on slot A: slot-B build', by(1).file === 'ab.slot1.update.bin', by(1).file);
check('A/B on slot B: slot-A build', by(2).file === 'ab.update.bin', by(2).file);
check('A/B trackers: "+ab" board target', by(1).board === AB && by(2).board === AB, by(1).board + ' / ' + by(2).board);
check('A/B row shows "Confirming" before the tracker confirms', sawConfirming,
      [1, 2].map(rowState).join(' / '));
check('result shown without waiting for the slow confirmation', resultAt && resultAt - startedAt < 5000,
      resultAt ? (resultAt - startedAt) + ' ms' : 'not shown');
check('result says confirmation continues in the background', /background/.test(hintAtResult), hintAtResult);
check('overwrite tracker is simply Done', rowState(0) === 'Done', rowState(0));
check('no rollback verdict before the tracker could have rebooted', row3AtResult === 'Confirming', row3AtResult);
check('list: quick A/B tracker Confirmed', listBadge(1) === 'Confirmed', listBadge(1));
check('list: slow A/B tracker Confirmed later, in the background', listBadge(2) === 'Confirmed', listBadge(2));
check('list: rolled-back tracker flagged', listBadge(3) === 'Rolled back', listBadge(3));
check('list: overwrite tracker up to date', /up to date/i.test(listBadge(0)), listBadge(0));

/* ---- pure helpers ---- */
const reg = await import(pathToFileURL(join(root, 'js/registry.js')).href);
const { updateBinInfo } = await import(pathToFileURL(join(root, 'js/image.js')).href);
const infoA = { bootloader: 'mcuboot-a', versionCode: 0x010005, version: '1.0.5' };
const infoB = { bootloader: 'mcuboot-b', versionCode: 0x010005, version: '1.0.5' };
const infoOw = { bootloader: 'mcuboot', versionCode: 0x010005, version: '1.0.5' };
const slots = [SLOT_A, SLOT_B];
const imgA = updateBinInfo(files['ab.update.bin']), imgB = updateBinInfo(files['ab.slot1.update.bin']);
check('header: reset vector decoded', imgB.reset === ((SLOT_B + 0x1201) & ~1), imgB.reset.toString(16));
check('guard: slot-B build refused for an overwrite board', reg.imageProblem(imgB, infoOw, slots)?.key === 'errFwWrongSlot');
check('guard: slot-A build refused for A/B on slot A', reg.imageProblem(imgA, infoA, slots)?.key === 'errFwWrongSlot');
check('guard: slot-B build refused for A/B on slot B', reg.imageProblem(imgB, infoB, slots)?.key === 'errFwWrongSlot');
check('guard: right builds pass', !reg.imageProblem(imgB, infoA, slots) && !reg.imageProblem(imgA, infoB, slots)
      && !reg.imageProblem(imgA, infoOw, slots));
const older = updateBinInfo(image(SLOT_B, 1000, [1, 0, 4]));
check('guard: older image refused for A/B', reg.imageProblem(older, infoA, slots)?.key === 'errFwNotNewer');
check('guard: older image allowed on overwrite boards', !reg.imageProblem(updateBinInfo(image(SLOT_A, 1000, [1, 0, 4])), infoOw, slots));
check('guard: no slot layout leaves the link check to the tracker', !reg.imageProblem(imgA, infoA, null));
check('manifestFor: variant inherits version', reg.manifestFor(manifest, AB).version === '1.0.6'
      && reg.manifestFor(manifest, AB).binSlot1 === 'ab.slot1.update.bin' && !reg.manifestFor(manifest, AB).variants);
check('manifestFor: unknown board is null', reg.manifestFor(manifest, 'other') === null);
const topAb = { version: '1.0.6', versionCode: 0x010006, boardTarget: AB, bin: 'ab.update.bin',
                binSlot1: 'ab.slot1.update.bin', slotBase: [SLOT_A, SLOT_B] };
check('manifestFor: A/B build as the top-level entry', reg.manifestFor(topAb, AB) === topAb
      && reg.manifestFor(topAb, BOARD) === null);
check('verdict: same slot again = reverted', reg.confirmVerdict({ bootloader: 'mcuboot-a' }, { bootloader: 'mcuboot-a', confirmed: true }, 12000, 60000, 10000) === 'reverted');
check('verdict: old firmware answering right after COMPLETE is not a revert', reg.confirmVerdict({ bootloader: 'mcuboot-a' }, { bootloader: 'mcuboot-a', confirmed: true }, 200, 60000, 10000) === null);
check('verdict: new slot unconfirmed = keep waiting', reg.confirmVerdict({ bootloader: 'mcuboot-a' }, { bootloader: 'mcuboot-b', confirmed: false }, 1000, 60000) === null);
check('verdict: new slot confirmed', reg.confirmVerdict({ bootloader: 'mcuboot-a' }, { bootloader: 'mcuboot-b', confirmed: true }, 1000, 60000) === 'confirmed');
check('verdict: silence past the wait = unconfirmed', reg.confirmVerdict({ bootloader: 'mcuboot-a' }, null, 61000, 60000) === 'unconfirmed');
check('binKeyFor', reg.binKeyFor(infoA) === 'binSlot1' && reg.binKeyFor(infoB) === 'bin' && reg.binKeyFor(infoOw) === 'bin');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
