/* The dongle row and a full dongle self-update through the real page:
 * connect -> the dongle reports an old version -> it is pre-selected ->
 * update -> it resets -> the page finds it again and confirms the new
 * version. The HID layer is faked; everything above it is app.js as shipped. */
import { JSDOM } from '/tmp/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { FakeSelfDongle, toHex, BOARD } from './fake_dongle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'),
                      { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;
global.window = window; global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.location = window.location; global.localStorage = window.localStorage;
global.Blob = window.Blob; global.URL = window.URL; global.HTMLElement = window.HTMLElement;

/* ---- fake WebHID with one dongle that comes back as a new device ---- */
const listeners = {};
const hid = {
  present: [],
  async requestDevice(){ return [hid.present[0]]; },
  async getDevices(){ return hid.present.slice(); },
  addEventListener(ev, fn){ (listeners[ev] = listeners[ev] || []).push(fn); },
};
const fire = (ev, device) => (listeners[ev] || []).forEach(fn => fn({ device }));
let resets = 0;
const onReset = old => {
  resets++;
  hid.present = hid.present.filter(d => d !== old);
  fire('disconnect', old);
  setTimeout(() => {
    const fresh = new FakeSelfDongle({ version: [1, 0, 0], onReset });
    hid.present.push(fresh);
    fire('connect', fresh);
  }, 400);
};
hid.present.push(new FakeSelfDongle({ version: [0, 6, 9], onReset }));
Object.defineProperty(window.navigator, 'hid', { value: hid, configurable: true });

/* ---- served files ---- */
const body = new Uint8Array(30000).map((_, i) => (i * 29) & 0xFF);
const files = {
  'devices.json': JSON.parse(readFileSync(join(root, 'devices.json'), 'utf8')),
  'firmware/nekotora/latest.json': { version: '1.0.4', versionCode: 0x010004,
    boardTarget: 'promicro_uf2/nrf52840/spi', hex: 'n.hex', bin: 'n.update.bin', date: '2026-08-23' },
  'firmware/dongle/latest.json': { version: '1.0.0', versionCode: 0x010000, boardTarget: BOARD,
    hex: 'nekotora-dongle-1.0.0.hex', uf2: 'nekotora-dongle-1.0.0.uf2', date: '2026-09-23' },
  'firmware/dongle/nekotora-dongle-1.0.0.hex': toHex([[0x1000, body]]),
};
global.fetch = async u => {
  const path = new URL(String(u)).pathname.replace(/^\//, '');
  const f = files[path];
  if (f === undefined) return { ok: false, status: 404 };
  return { ok: true, json: async () => f, text: async () => f };
};

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !extra ? '' : '  -> ' + extra));
  if (!cond) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => window.document.getElementById(id);
const txt = id => ($(id) ? $(id).textContent.trim() : '');
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end){ if (cond()) return true; await sleep(50); } return false; };

await import(pathToFileURL(join(root, 'js/app.js')).href);
await sleep(300);

check('rescue section offered before anything is connected', !$('dongleRescue').classList.contains('hidden'));
check('rescue links the published .uf2', /nekotora-dongle-1\.0\.0\.uf2$/.test($('rescueLink').href), $('rescueLink').href);
check('rescue "enter now" hidden without a dongle', $('btnRescue').classList.contains('hidden'));
check('firmware card names the dongle version', /1\.0\.0/.test(txt('fwLine')), txt('fwLine'));

$('btnConnectDongle').click();
await until(() => /0\.6\.9/.test(txt('dongleList')) && !$('btnStart').disabled, 6000);
const row = $('dongleList').querySelector('.trk');
check('dongle row shown', !!row);
check('dongle row shows its current version', /0\.6\.9/.test(txt('dongleList')), txt('dongleList'));
check('dongle offered for update', /1\.0\.0/.test(row ? row.querySelector('.tState').textContent : ''), txt('dongleList'));
check('outdated dongle pre-selected', row && row.querySelector('input').checked);
check('start enabled with only the dongle selected', !$('btnStart').disabled);
check('rescue "enter now" shown once connected', !$('btnRescue').classList.contains('hidden'));

$('btnStart').click();
const done = await until(() => !$('resultOk').classList.contains('hidden') || !$('resultBad').classList.contains('hidden'), 30000);
check('update finished', done);
check('ended in success', !$('resultOk').classList.contains('hidden'), txt('errDetail'));
check('dongle reset exactly once', resets === 1, resets);
check('success names the new version', /1\.0\.0/.test(txt('okHint')), txt('okHint'));
const prow = $('trkProgress').querySelector('[data-tid="255"]');
check('progress row labelled as the dongle', prow && !/255/.test(prow.querySelector('.tpName').textContent),
      prow && prow.querySelector('.tpName').textContent);

await until(() => /1\.0\.0/.test(txt('dongleList')) && !/0\.6\.9/.test(txt('dongleList')), 8000);
check('rescan shows the dongle up to date', /1\.0\.0/.test(txt('dongleList')) && !$('dongleList').querySelector('input').checked,
      txt('dongleList'));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
