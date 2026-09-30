/* The manager shell end to end, through the real page: pages and routing,
 * the dongle chip, battery gating and waking on the update page, every
 * button on the manage page reaching the dongle as the right HID command,
 * the channel confirmation, help in three languages, the diagnostics report,
 * and manual files being sorted by what they contain.
 *
 * The dongle is faked at the WebHID boundary: it streams telemetry for three
 * trackers (one healthy, one with a flat battery, one registered but silent),
 * answers FW_INFO, and acknowledges commands the way src/rcv_cmd.c does -
 * STARTED at once for tracker commands, then OK with the same seq. */
import { JSDOM } from '/tmp/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { toHex } from './fake_dongle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'),
                      { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;
global.window = window; global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.location = window.location; global.localStorage = window.localStorage;
global.Blob = window.Blob; global.URL = window.URL; global.HTMLElement = window.HTMLElement;
if (!window.Blob.prototype.arrayBuffer){
  window.Blob.prototype.arrayBuffer = function(){
    return new Promise(res => { const r = new window.FileReader(); r.onload = () => res(r.result); r.readAsArrayBuffer(this); });
  };
}

const BOARD = 'promicro_uf2/nrf52840/spi';
const manifest = { version: '1.0.4', versionCode: 0x010004, boardTarget: BOARD,
                   hex: 'x.hex', bin: 'x.update.bin', date: '2026-09-20' };
const dongleManifest = { version: '1.0.0', versionCode: 0x010000, boardTarget: 'promicro_uf2/nrf52840',
                         hex: 'd.hex', uf2: 'd.uf2', date: '2026-09-20' };
const devices = JSON.parse(readFileSync(join(root, 'devices.json'), 'utf8'));
global.fetch = async u => {
  const s = String(u);
  if (s.endsWith('devices.json')) return { ok: true, json: async () => devices };
  if (s.includes('dongle') && s.endsWith('latest.json')) return { ok: true, json: async () => dongleManifest };
  if (s.endsWith('latest.json')) return { ok: true, json: async () => manifest };
  return { ok: false, status: 404 };
};

const { HID, DONGLE_ID } = await import(pathToFileURL(join(root, 'js/ota.js')).href);

/* ---------------------------- fake dongle ---------------------------- */
const cmds = [];
let respondAcks = true;
const dongle = {
  opened: false, productName: 'NekoTora Dongle', listeners: [],
  addEventListener(_, fn){ this.listeners.push(fn); },
  removeEventListener(_, fn){ this.listeners = this.listeners.filter(l => l !== fn); },
  async open(){ this.opened = true; },
  async close(){ this.opened = false; },
  emit(b){ const dv = new DataView(b.buffer); for (const l of this.listeners) l({ data: dv }); },
  ack(seq, op, st){ const f = new Uint8Array(64); f[0] = 251; f[1] = seq; f[2] = op; f[3] = st; this.emit(f); },
  fwInfo(tid, ver, bl, board){
    const info = new Uint8Array(66);
    info[0] = HID.FW_INFO; info[1] = tid; info.set(ver, 2); info[13] = bl; info[14] = 1;
    info.set(new TextEncoder().encode(board), 15);
    for (let c = 0; c < 6; c++){
      const f = new Uint8Array(64);
      f[0] = HID.FW_INFO; f[1] = tid; f[2] = c;
      const off = 2 + c * 13;
      f.set(info.subarray(off, Math.min(66, off + 13)), 3);
      setTimeout(() => this.emit(f), 2 + c);
    }
  },
  async sendReport(_, data){
    const p = new Uint8Array(data);
    if (p[0] === 254){
      cmds.push({ seq: p[1], op: p[2], args: [...p.subarray(4, 8)] });
      if (!respondAcks) return;
      const tracker = p[2] >= 1 && p[2] <= 200;
      const slow = tracker || p[2] === 218 || p[2] === 219;
      setTimeout(() => this.ack(p[1], p[2], slow ? 7 : 0), 5);
      if (slow) setTimeout(() => this.ack(p[1], p[2], 0), 60);
      return;
    }
    if (p[0] === HID.QUERY_INFO){
      if (p[1] === DONGLE_ID) this.fwInfo(DONGLE_ID, [1, 0, 0], 1, 'promicro_uf2/nrf52840');
      else if (p[1] === 1 || p[1] === 2) this.fwInfo(p[1], [1, 0, 0], 3, BOARD);
    }
  },
};
/* tracker 1: 85%, 3.90 V, -52 dBm; tracker 2: 10%, 3.70 V, not charging;
 * tracker 3: registered only (address padding, no telemetry) */
function info(id, pct, vByte, rssi){
  const s = new Uint8Array(16);
  s[0] = 0; s[1] = id; s[2] = 0x80 | pct; s[3] = vByte; s[12] = 1; s[13] = 0; s[14] = 0; s[15] = rssi;
  return s;
}
function reg(id){
  const s = new Uint8Array(16);
  s[0] = 255; s[1] = id; s.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x60 + id], 2);
  return s;
}
let battery2 = 10, charging2 = false;
setInterval(() => {
  if (!dongle.opened) return;
  const f = new Uint8Array(64);
  f.set(info(1, 85, 145, 52), 0);
  f.set(info(2, battery2, charging2 ? 190 : 125, 60), 16);
  f.set(reg(3), 32);
  f.set(reg(1), 48);
  dongle.emit(f);
}, 20).unref();

Object.defineProperty(window.navigator, 'hid', { configurable: true, value: {
  async requestDevice(){ return [dongle]; },
  async getDevices(){ return [dongle]; },
  addEventListener(){},
}});

/* ------------------------------ helpers ------------------------------ */
let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond || !extra ? '' : '  -> ' + extra));
  if (!cond) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end){ if (fn()) return true; await sleep(30); } return false; };
const $ = id => window.document.getElementById(id);
const txt = id => ($(id) ? $(id).textContent : '');
const shown = id => !$(id).classList.contains('hidden');
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const gotoPage = async p => { window.location.hash = p; window.dispatchEvent(new window.HashChangeEvent('hashchange')); await sleep(60); };

localStorage.setItem('lang', 'zh');
await import(pathToFileURL(join(root, 'js/app.js')).href);
await sleep(300);

/* ------------------------------- shell ------------------------------- */
check('title renamed', /NekoTora Manager/.test(txt('title') || window.document.querySelector('h1').textContent));
check('home page shown first', shown('pageHome') && !shown('pageUpdate'));
check('four home cards (calibration not shown yet)', window.document.querySelectorAll('.homeCard').length === 4);
check('chip says not connected', /未連接/.test(txt('dongleChip')), txt('dongleChip'));
await gotoPage('help');
check('help page shown', shown('pageHelp') && !shown('pageHome'));
check('help: 13 light rows (no charging patterns)', window.document.querySelectorAll('#helpBody table.help')[0].querySelectorAll('tbody tr').length === 13);
check('nav marks the current page', window.document.querySelector('#nav button[aria-current="page"]').dataset.page === 'help');
for (const l of ['en', 'ja', 'zh']){
  $('langSel').value = l; $('langSel').dispatchEvent(new window.Event('change')); await sleep(30);
  check(`help re-rendered in ${l}`, l === 'en' ? /Tracker lights/.test(txt('helpBody'))
        : l === 'ja' ? /トラッカーのランプ/.test(txt('helpBody')) : /追蹤器燈號/.test(txt('helpBody')));
}
await gotoPage('manage');
check('manage asks for the dongle first', shown('manageNeed') && !shown('manageBody'));

/* ----------------------------- connect ------------------------------- */
click($('btnTopConnect'));
await until(() => shown('manageBody') && $('mgList').children.length === 3);
check('chip says connected', /已連接/.test(txt('dongleChip')), txt('dongleChip'));
check('connect button hidden once connected', !shown('btnTopConnect'));
check('manage lists three trackers', $('mgList').children.length === 3, $('mgList').children.length);
await until(() => /醒著 2/.test(txt('mgSummary')));
check('summary: 2 awake, 1 dozing or off', /醒著 2.*1/.test(txt('mgSummary')), txt('mgSummary'));
const row = id => $('mgList').querySelector(`[data-tid="${id}"]`);
check('tracker 1 shows battery and signal', /85%/.test(row(1).textContent) && /-52 dBm/.test(row(1).textContent), row(1).textContent);
check('silent tracker marked dozing or off', /doze 或關機/.test(row(3).textContent), row(3).textContent);
check('find disabled for the silent tracker', row(3).querySelector('button').disabled);
check('find enabled for an awake tracker', !row(1).querySelector('button').disabled);

/* ----------------------------- commands ------------------------------ */
const last = () => cmds[cmds.length - 1];
click($('btnDozeAll'));
await until(() => /完成/.test(txt('mgMsg')));
check('doze all -> 0x70 to all', last().op === 0x70 && last().args[0] === 0xFF, JSON.stringify(last()));
check('doze all reports done after the completion ACK', /完成/.test(txt('mgMsg')), txt('mgMsg'));
check('seq clear of 0x55 and the 0..127 range', last().seq >= 128 && last().seq <= 250, last().seq);
click($('btnWakeAll'));
await until(() => last().op === 0x71 && /完成/.test(txt('mgMsg')));
check('wake all -> 0x71 to all', last().op === 0x71 && last().args[0] === 0xFF);
click(row(1).querySelector('button'));
await until(() => /閃白燈/.test(txt('mgMsg')));
check('find -> PING 0x11 to tracker 1', last().op === 0x11 && last().args[0] === 1, JSON.stringify(last()));
click($('btnPairOn'));
await until(() => /已開始/.test(txt('mgPairMsg')));
check('start pairing -> op 201', last().op === 201);
click($('btnPairOff'));
await until(() => /已結束/.test(txt('mgPairMsg')));
check('stop pairing -> op 202', last().op === 202);

respondAcks = false;
const before = cmds.length;
click($('btnDozeAll'));
await until(() => /沒有回應/.test(txt('mgMsg')), 3000);
check('no ACK -> says the dongle did not answer', /沒有回應/.test(txt('mgMsg')), txt('mgMsg'));
check('...and the command was sent once', cmds.length === before + 1);
respondAcks = true;

/* ------------------------------ channel ------------------------------ */
const chBtn = n => $('chCards').querySelector(`button[data-ch="${n}"]`);
check('four rendezvous channel cards', $('chCards').children.length === 4);
const n0 = cmds.length;
click(chBtn(50));
await sleep(50);
check('channel asks for confirmation', shown('confirmOverlay') && /50/.test(txt('confirmTitle')));
click($('btnConfirmNo'));
await sleep(50);
check('cancel sends nothing', cmds.length === n0 && !shown('confirmOverlay'));
click(chBtn(50));
await sleep(50);
click($('btnConfirmYes'));
await until(() => /已切換到頻道 50/.test(txt('mgChMsg')));
check('channel 50 -> op 218 arg 50', last().op === 218 && last().args[0] === 50, JSON.stringify(last()));
check('reports the switch', /已切換到頻道 50/.test(txt('mgChMsg')), txt('mgChMsg'));
click(chBtn(76));
await sleep(50);
click($('btnConfirmYes'));
await until(() => /已切換到頻道 76/.test(txt('mgChMsg')));
check('default channel -> clear (op 219), not a stored 76', last().op === 219, JSON.stringify(last()));

/* ---------------------------- update page ---------------------------- */
await gotoPage('update');
await until(() => $('trackerList').children.length === 3 && !/…/.test(txt('trackerList')), 6000);
const trow = id => [...$('trackerList').children].find(r => r.querySelector('.tName').textContent.includes(String(id)));
check('firmware card hidden for wireless', !shown('card3'));
check('firmware line names both images', /1\.0\.4/.test(txt('otaFwLine')) && /1\.0\.0/.test(txt('otaFwLine')), txt('otaFwLine'));
check('healthy outdated tracker pre-selected', trow(1).querySelector('input').checked);
check('low battery tracker not selectable', trow(2).querySelector('input').disabled, trow(2).textContent);
check('low battery says why', /電量 10%/.test(trow(2).textContent), trow(2).textContent);
check('silent tracker offered a wake', shown('wakeBox') && /1 顆/.test(txt('wakeText')), txt('wakeText'));
charging2 = true;
await until(() => !trow(2).querySelector('input').disabled, 4000);
check('plugging in lifts the battery block', !trow(2).querySelector('input').disabled, trow(2).textContent);
charging2 = false;
const nw = cmds.length;
click($('btnWakeScan'));
await until(() => cmds.length > nw && cmds[nw].op === 0x71, 3000);
check('wake-and-check sends WAKE to all', cmds[nw] && cmds[nw].op === 0x71 && cmds[nw].args[0] === 0xFF);

/* ---------------------------- manual files --------------------------- */
async function pick(bytes, name){
  const file = new window.File([bytes], name);
  Object.defineProperty($('fileInput'), 'files', { configurable: true, value: [file] });
  $('fileInput').dispatchEvent(new window.Event('change'));
  await sleep(150);
}
await until(() => !shown('otaNote') || !/重新檢查/.test(txt('otaNote')), 8000);
const enc = s => new TextEncoder().encode(s);
await pick(enc(toHex([[0x1000, new Uint8Array(256).fill(7)]])), 'dongle.hex');
check('dongle hex recognised and offered on the dongle row', /dongle\.hex/.test(txt('dongleList')) && $('dongleList').querySelector('input').checked, txt('dongleList'));
check('firmware line shows the manual dongle file', /dongle\.hex/.test(txt('otaFwLine')), txt('otaFwLine'));
await pick(enc(toHex([[0x0, new Uint8Array(256).fill(7)]])), 'tracker.hex');
check('tracker SWD hex refused on the wireless path, with the reason', shown('fwErr') && /SWD/.test(txt('fwErr')), txt('fwErr'));
const uf2 = new Uint8Array(512); new DataView(uf2.buffer).setUint32(0, 0x0A324655, true);
await pick(uf2, 'dongle.uf2');
check('uf2 shows the recovery route instead of an error', shown('uf2Box') && !shown('fwErr'));
check('uf2: "enter UF2 mode now" offered with a dongle connected', shown('btnUf2'));
await pick(enc('hello'), 'notes.txt');
check('unknown file refused', shown('fwErr') && /無法辨識/.test(txt('fwErr')), txt('fwErr'));

/* ---------------------------- diagnostics ---------------------------- */
await gotoPage('diag');
click($('btnDiagMake'));
await sleep(50);
check('report lists the trackers with battery', /#1 .*battery 85%/.test(txt('diagOut')) && /#3 .*dozing-or-off/.test(txt('diagOut')), txt('diagOut').slice(0, 400));
check('report names the dongle firmware', /dongle: .*1\.0\.0/.test(txt('diagOut')));
check('download enabled after making it', !$('btnDiagDl').disabled);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
