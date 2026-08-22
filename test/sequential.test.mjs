/* Updates run one tracker at a time.
 *
 * Drives the real connectDongle -> scanTrackers -> start path against a fake
 * WebHID dongle that records how many OTA sessions overlap. Parallel updates
 * were measured on hardware to fail outright at four targets, so "never more
 * than one at a time" is the property worth pinning down.
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
const manifest = { version: '1.0.1', versionCode: 65537, boardTarget: BOARD,
                   hex: 'x.hex', bin: 'x.update.bin', date: '2026-08-22' };
const devices = JSON.parse(readFileSync(join(root, 'devices.json'), 'utf8'));

// a small but valid MCUboot update image
const fwBytes = new Uint8Array(32 + 600);
new DataView(fwBytes.buffer).setUint32(0, 0x96F3B83D, true);
new DataView(fwBytes.buffer).setUint32(12, 600, true);

global.fetch = async u => {
  const s = String(u);
  if (s.endsWith('devices.json')) return { ok: true, json: async () => devices };
  if (s.endsWith('latest.json'))  return { ok: true, json: async () => manifest };
  return { ok: true, arrayBuffer: async () => fwBytes.buffer, text: async () => '' };
};

const { HID, ST } = await import(pathToFileURL(join(root, 'js/ota.js')).href);

const sessions = [];          // {id, begin, end}
let liveTargets = new Set();
let maxConcurrent = 0;

function makeDongle(ids){
  const listeners = [];
  const emit = b => { const dv = new DataView(b.buffer); for (const l of listeners) l({ data: dv }); };
  const st = new Map();
  // a 64-byte HID report carries four 16-byte sub-reports, so more than four
  // trackers need more than one frame
  const telemetry = setInterval(() => {
    for (let base = 0; base < ids.length; base += 4){
      const f = new Uint8Array(64);
      ids.slice(base, base + 4).forEach((id, i) => { f[i * 16] = 1; f[i * 16 + 1] = id; });
      emit(f);
    }
  }, 5);
  const progress = setInterval(() => {
    for (const [tid, s] of st) if (s.ready){
      const f = new Uint8Array(64); const dv = new DataView(f.buffer);
      f[0] = HID.STATUS; f[1] = tid; f[2] = ST.RECEIVING;
      dv.setUint16(3, s.next, false); dv.setUint32(5, s.next * 60, true); f[9] = 0;
      emit(f);
    }
  }, 15);
  const status = (tid, code, next = 0) => {
    const f = new Uint8Array(64); const dv = new DataView(f.buffer);
    f[0] = HID.STATUS; f[1] = tid; f[2] = code; dv.setUint16(3, next, false);
    emit(f);
  };
  return {
    opened: true, productName: 'NekoTora Dongle',
    addEventListener: (_, fn) => listeners.push(fn),
    removeEventListener: () => {},
    open: async () => {}, close: async () => { clearInterval(telemetry); clearInterval(progress); },
    sendReport: async (_, data) => {
      const p = new Uint8Array(data), dv = new DataView(p.buffer);
      const type = p[0], tid = p[1];
      if (type === HID.QUERY_INFO){
        const info = new Uint8Array(66);
        info[2] = 1;
        new TextEncoder().encodeInto(BOARD, info.subarray(15));
        info[13] = 3; info[14] = 1;
        setTimeout(() => { for (let i = 0; i < 6; i++){
          const f = new Uint8Array(64);
          f[0] = HID.FW_INFO; f[1] = tid; f[2] = i;
          f.set(info.subarray(2 + i * 13, 2 + i * 13 + 13), 3);
          emit(f);
        } }, 5);
      } else if (type === HID.BEGIN){
        st.set(tid, { ready: false, next: 0, total: dv.getUint16(10, false) });
        liveTargets.add(tid);
        maxConcurrent = Math.max(maxConcurrent, liveTargets.size);
        sessions.push({ id: tid, begin: Date.now() });
        setTimeout(() => { const s = st.get(tid); if (s){ s.ready = true; status(tid, ST.READY); } }, 30);
      } else if (type === HID.DATA){
        const seq = dv.getUint16(2, false);
        for (const [, s] of st) if (s.ready && seq === s.next) s.next++;
      } else if (type === HID.VERIFY){
        setTimeout(() => status(tid, ST.VERIFY_OK), 10);
      } else if (type === HID.ACTIVATE){
        setTimeout(() => {
          status(tid, ST.COMPLETE);
          liveTargets.delete(tid);
          const s = sessions.find(x => x.id === tid && !x.end);
          if (s) s.end = Date.now();
        }, 10);
      }
    },
  };
}

let dongleIds = [0, 1, 2, 3, 4, 5];
Object.defineProperty(global, 'navigator', {
  value: { language: 'zh-TW',
           hid: { requestDevice: async () => [makeDongle(dongleIds)], getDevices: async () => [], addEventListener: () => {} } },
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
await new Promise(r => setTimeout(r, 3000));

check('six trackers found', boxes().length === 6, String(boxes().length));
check('all six pre-selected (no cap any more)', boxes().filter(b => b.checked).length === 6,
      boxes().filter(b => b.checked).length + ' ticked');

click('btnStart');
await new Promise(r => setTimeout(r, 12000));

check('every tracker got a session', sessions.length === 6, String(sessions.length));
check('never more than one at a time', maxConcurrent === 1, 'max concurrent = ' + maxConcurrent);
check('sessions ran in order',
      sessions.map(s => s.id).join(',') === '0,1,2,3,4,5', sessions.map(s => s.id).join(','));
const overlap = sessions.some((s, i) => i > 0 && sessions[i - 1].end && s.begin < sessions[i - 1].end);
check('no session started before the previous finished', !overlap);

const rows = [...$('trkProgress').children];
check('a progress row per tracker', rows.length === 6, String(rows.length));
check('all rows complete', rows.every(el => el.className.includes('complete')),
      rows.map(el => el.className).join(' | '));
check('success screen shown', !$('resultOk').classList.contains('hidden'));
check('summary mentions all six', /6/.test($('okHint').textContent), $('okHint').textContent);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
