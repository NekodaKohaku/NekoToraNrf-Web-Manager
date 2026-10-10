/* The manager shell end to end, through the real page: pages and routing,
 * the dongle chip, battery gating and waking on the update page, every
 * button on the manage page reaching the dongle as the right HID command,
 * the channel confirmation, help in three languages, the diagnostics report,
 * and manual files being sorted by what they contain.
 *
 * The dongle is faked at the WebHID boundary: it streams telemetry for three
 * trackers (one healthy, one with a flat battery, one registered but silent),
 * answers FW_INFO, and acknowledges commands the way src/rcv_cmd.c does -
 * STARTED at once for tracker commands, then OK with the same seq. It also
 * answers STATUS (253) and runs channel scans (209 -> RSSI_RESULT 252 reports
 * -> completion), as the NekoTora receiver firmware does. */
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
let supportStatus = true;
/* Dongle-side view: link state per tracker id (2 awake, 1 dozing, 0 gone),
 * channel in use, and what the next scan measures (busy permille). */
const links = { 1: 2, 2: 2, 3: 1 };
let channel = 76;
let scanBusy = { 2: 3, 50: 30, 76: 120, 24: 400 };
let streaming = true;
let supportEvents = true;
let calFail2 = true;          // tracker 2 reports movement
let temp1 = 30.0;             // tracker 1 IMU temperature, warming during T-Cal
const subs = [];
const dongle = {
  opened: false, productName: 'NekoTora Dongle', listeners: [], runs: 0,
  addEventListener(_, fn){ this.listeners.push(fn); },
  removeEventListener(_, fn){ this.listeners = this.listeners.filter(l => l !== fn); },
  async open(){ this.opened = true; },
  async close(){ this.opened = false; },
  emit(b){ const dv = new DataView(b.buffer); for (const l of this.listeners) l({ data: dv }); },
  /* The rest of the report is registration padding, as src/hid.c fills it. */
  ack(seq, op, st, data = []){
    const f = new Uint8Array(64); f[0] = 251; f[1] = seq; f[2] = op; f[3] = st; f.set(data, 4);
    f.set(pad(1), 16); f.set(pad(2), 32); f.set(pad(3), 48);
    this.emit(f);
  },
  status(seq){
    const d = [3, channel, channel !== 76 ? 1 : 0, 0, 0, 0, 0];
    for (const [id, l] of Object.entries(links)) d[3 + (id >> 2)] |= l << ((id & 3) * 2);
    this.ack(seq, 253, 0, d);
  },
  /* A TRACKER_EVENT record (tracker_event_encode_hid), padded like a report. */
  event(tid, ev, outcome, op, phase, detail, nonce, kind = 1){
    nonce += 10000 * (++this.runs);     // every event its own nonce, as on a tracker
    const f = new Uint8Array(64);
    f.set([251, 0, 225, ev | (outcome << 4), tid, nonce & 255, (nonce >> 8) & 255, 0, 0, ev, 0, op & 255, op >> 8, kind, phase, detail]);
    f.set(pad(1), 16); f.set(pad(2), 32); f.set(pad(3), 48);
    this.emit(f);
    this.emit(f);                       // the dongle repeats events
  },
  scan(seq){
    const chs = Object.keys(scanBusy).map(Number).sort((a, b) => scanBusy[a] - scanBusy[b]);
    chs.forEach((ch, i) => setTimeout(() => this.ack(seq, 252, 0,
      [i, chs.length, ch, scanBusy[ch] & 0xFF, scanBusy[ch] >> 8, 70, 1 | (ch === channel ? 2 : 0) | (i === 0 ? 4 : 0)]), 80 + i * 3));
    setTimeout(() => this.ack(seq, 209, 0, [chs.length, chs[0], channel]), 80 + chs.length * 3 + 5);
  },
  fwInfo(tid, ver, bl, board){
    const info = new Uint8Array(66);
    info[0] = HID.FW_INFO; info[1] = tid; info.set(ver, 2); info[13] = bl; info[14] = 1;
    info.set(new TextEncoder().encode(board), 15);
    for (let c = 0; c < 6; c++){
      const f = new Uint8Array(64);
      f[0] = HID.FW_INFO; f[1] = tid; f[2] = c;
      const off = 2 + c * 13;
      f.set(info.subarray(off, Math.min(66, off + 13)), 3);
      f.set(pad(1), 16); f.set(pad(2), 32); f.set(pad(3), 48);   // the dongle pads reports
      setTimeout(() => this.emit(f), 2 + c);
    }
  },
  async sendReport(_, data){
    const p = new Uint8Array(data);
    if (p[0] === 254){
      cmds.push({ seq: p[1], op: p[2], args: [...p.subarray(4, 8)] });
      if (!respondAcks) return;
      if (p[2] === 253){
        if (supportStatus) setTimeout(() => this.status(p[1]), 3);
        else setTimeout(() => this.ack(p[1], 253, 1), 3);    // older firmware: EINVAL
        return;
      }
      if (p[2] === 224){
        subs.push([...p.subarray(4, 8)]);
        setTimeout(() => this.ack(p[1], 224, supportEvents ? 0 : 5), 3);
        /* A new subscription replays the last cached event: an old END. */
        if (supportEvents && p[5] === 1) setTimeout(() => this.event(2, 4, 1, 7, 4, 0, 900), 20);
        return;
      }
      if (p[2] === 0x02 && supportEvents){
        setTimeout(() => this.ack(p[1], 2, 7), 5);
        setTimeout(() => this.ack(p[1], 2, 0), 60);
        for (const id of [1, 2]) if (links[id] === 2){
          const op = 40 + id;
          setTimeout(() => this.event(id, 2, 0, op, 2, 0, 1000 + id), 100);
          setTimeout(() => this.event(id, 3, 0, op, 4, 0, 1100 + id), 200);
          const bad = id === 2 && calFail2;
          setTimeout(() => this.event(id, 4, bad ? 2 : 1, op, bad ? 4 : 16, bad ? 5 : 0, 1200 + id), 400);
        }
        return;
      }
      if ((p[2] === 0x13 || p[2] === 0x14) && supportEvents){
        setTimeout(() => this.ack(p[1], p[2], 7), 5);
        setTimeout(() => this.ack(p[1], p[2], 0), 60);
        const T = 7;                      // CAL_KIND_TCAL_RUNTIME, requested
        if (p[2] === 0x13){
          /* tracker 1: 3 slots from before, then two new ones; tracker 2: one.
           * An auto-origin runtime check of the same kind must be ignored. */
          setTimeout(() => this.event(1, 1, 0, 70, 0, 0, 2001, T), 80);
          setTimeout(() => this.event(1, 2, 0, 70, 4, 3, 2002, T), 90);
          setTimeout(() => this.event(2, 1, 0, 71, 0, 0, 2003, T), 80);
          setTimeout(() => this.event(2, 2, 0, 71, 4, 0, 2004, T), 90);
          setTimeout(() => this.event(1, 3, 0, 70, 19, 40, 2005, T), 150);
          setTimeout(() => this.event(1, 3, 0, 70, 19, 41, 2006, T), 200);
          setTimeout(() => this.event(2, 3, 0, 71, 19, 40, 2007, T), 200);
          setTimeout(() => this.event(2, 3, 0, 99, 19, 60, 2008, T | 0x80), 220);
        } else {
          setTimeout(() => this.event(1, 4, 1, 70, 16, 0, 2101, T), 80);
          setTimeout(() => this.event(2, 4, 1, 71, 16, 0, 2102, T), 80);
        }
        return;
      }
      if (p[2] === 209){ setTimeout(() => this.ack(p[1], 209, 7), 5); this.scan(p[1]); return; }
      if (p[2] === 0x70 || p[2] === 0x71){
        const on = p[2] === 0x71, all = p[4] === 0xFF;
        for (const id of [1, 2]) if (all || p[4] === id) links[id] = on ? 2 : 1;
        streaming = links[1] === 2;
      }
      if (p[2] === 250){
        const id = p[4];
        const st = !supportRemove ? 1 : registered.has(id) ? 0 : 4;
        if (st === 0){ registered.delete(id); links[id] = 0; }
        setTimeout(() => this.ack(p[1], 250, st), 3);
        return;
      }
      if (p[2] === 0x08){                 // tracker drops its pairing: never confirms
        setTimeout(() => this.ack(p[1], 8, 7), 5);
        setTimeout(() => this.ack(p[1], 8, 4), 80);
        return;
      }
      if (p[2] === 218) channel = p[4];
      if (p[2] === 219) channel = 76;
      const tracker = p[2] >= 1 && p[2] <= 200;
      const slow = tracker || p[2] === 218 || p[2] === 219;
      setTimeout(() => this.ack(p[1], p[2], slow ? 7 : 0), 5);
      if (slow) setTimeout(() => this.ack(p[1], p[2], 0), 60);
      return;
    }
    if (p[0] === HID.QUERY_INFO){
      if (p[1] === DONGLE_ID) this.fwInfo(DONGLE_ID, [1, 0, 0], 1, 'promicro_uf2/nrf52840');
      else if (p[1] === 1 || p[1] === 2 || (p[1] === 3 && awake3)) this.fwInfo(p[1], [1, 0, 0], 3, BOARD);
    }
  },
};
/* tracker 1: 85%, 3.90 V, -52 dBm; tracker 2: 10%, 3.70 V, not charging;
 * tracker 3: registered only (address padding, no telemetry) */
function info(id, pct, vByte, rssi, temp = 25){
  const s = new Uint8Array(16);
  s[0] = 0; s[1] = id; s[2] = 0x80 | pct; s[3] = vByte; s[12] = 1; s[13] = 0; s[14] = 0; s[15] = rssi;
  s[4] = Math.floor((temp - 25) * 2 + 128.5);   // (uint8_t) cast in connection.c
  return s;
}
function reg(id){
  const s = new Uint8Array(16);
  s[0] = 255; s[1] = id; s.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x60 + id], 2);
  return s;
}
/* What the dongle still has paired: registrations stop for a removed id. */
const registered = new Set([1, 2, 3]);
let supportRemove = true;
function pad(id){
  if (registered.has(id)) return reg(id);
  const s = new Uint8Array(16); s[0] = 0xF8; return s;
}
let battery2 = 10, charging2 = false;
let awake3 = false;           // tracker 3 switched on after the scan
setInterval(() => {
  if (!dongle.opened || !streaming) return;
  const f = new Uint8Array(64);
  f.set(info(1, 85, 145, 52, temp1), 0);
  f.set(registered.has(2) ? info(2, battery2, charging2 ? 190 : 125, 60) : pad(2), 16);
  f.set(awake3 ? info(3, 70, 140, 55) : pad(3), 32);
  f.set(pad(1), 48);
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
check('help: 23 tracker light rows (no charging patterns)', window.document.querySelectorAll('#helpBody table.help')[0].querySelectorAll('tbody tr').length === 23);
check('help: waiting-for-update light listed', /等待其他追蹤器更新/.test(txt('helpBody')));
check('help: wireless update light listed', /無線更新中/.test(txt('helpBody')));
check('help: dongle light table with 10 rows', window.document.querySelectorAll('#helpBody table.help')[1].querySelectorAll('tbody tr').length === 10);
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
await until(() => /運作中 2・待機 1・關機 0/.test(txt('mgSummary')));
check('summary from STATUS: 2 active, 1 standby, 0 off', /運作中 2・待機 1・關機 0/.test(txt('mgSummary')), txt('mgSummary'));
const row = id => $('mgList').querySelector(`[data-tid="${id}"]`);
await until(() => /85%/.test(row(1).textContent));
check('tracker 1 shows battery and signal', /85%/.test(row(1).textContent) && /-52 dBm/.test(row(1).textContent), row(1).textContent);
check('silent tracker marked standby (from STATUS)', /待機/.test(row(3).querySelector('.tState').textContent), row(3).textContent);
links[3] = 0;
await until(() => /關機/.test(row(3).querySelector('.tState').textContent), 4000);
check('gone tracker marked off', /關機或不在範圍/.test(row(3).querySelector('.tState').textContent), row(3).textContent);
links[3] = 1;
await until(() => /^待機$/.test(row(3).querySelector('.tState').textContent), 4000);
check('no "doze" left on the page', !/doze/i.test(txt('pageManage')), txt('pageManage').match(/.{20}doze.{20}/i));
check('doze button says standby', txt('btnDozeAll') === '全部待機', txt('btnDozeAll'));
check('find disabled for the silent tracker', row(3).querySelector('button').disabled);
check('find enabled for an awake tracker', !row(1).querySelector('button').disabled);

/* ----------------------------- commands ------------------------------ */
/* Last command other than the background STATUS poll. */
const user = () => cmds.filter(c => c.op !== 253);
const last = () => { const u = user(); return u[u.length - 1]; };
click($('btnDozeAll'));
await until(() => /完成/.test(txt('mgMsg')));
check('doze all -> 0x70 to all', last().op === 0x70 && last().args[0] === 0xFF, JSON.stringify(last()));
check('doze all reports done after the completion ACK', /完成/.test(txt('mgMsg')), txt('mgMsg'));
check('seq clear of 0x55 and the 0..127 range', last().seq >= 128 && last().seq <= 250, last().seq);
click($('btnWakeAll'));
await until(() => last().op === 0x71 && /完成/.test(txt('mgMsg')));
check('wake all -> 0x71 to all', last().op === 0x71 && last().args[0] === 0xFF);
const nOff = user().length;
click($('btnOffAll'));
await sleep(50);
check('power off all asks first, in red', shown('confirmOverlay') && $('btnConfirmYes').classList.contains('danger') && /全部待機/.test(txt('confirmText')));
click($('btnConfirmNo')); await sleep(30);
check('...cancel sends nothing', user().length === nOff);
click($('btnOffAll')); await sleep(50); click($('btnConfirmYes'));
await until(() => /已送出關機/.test(txt('mgMsg')));
check('power off all -> SHUTDOWN (0x01) to all', last().op === 0x01 && last().args[0] === 0xFF, JSON.stringify(last()));
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
const before = user().length;
click($('btnDozeAll'));
await until(() => /沒有回應/.test(txt('mgMsg')), 3000);
check('no ACK -> says the dongle did not answer', /沒有回應/.test(txt('mgMsg')), txt('mgMsg'));
check('...and the command was sent once', user().length === before + 1);
respondAcks = true;

/* ------------------------------ channel ------------------------------ */
const chBtn = n => $('chCards').querySelector(`button[data-ch="${n}"]`);
check('four rendezvous channel cards', $('chCards').children.length === 4);
check('cards in frequency order 2, 24, 50, 76', [...$('chCards').children].map(c => c.dataset.ch).join(',') === '2,24,50,76',
      [...$('chCards').children].map(c => c.dataset.ch).join(','));
const n0 = user().length;
click(chBtn(50));
await sleep(50);
check('channel asks for confirmation', shown('confirmOverlay') && /50/.test(txt('confirmTitle')));
click($('btnConfirmNo'));
await sleep(50);
check('cancel sends nothing', user().length === n0 && !shown('confirmOverlay'));
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
await until(() => chBtn(76).disabled);
check('current channel card marked and its button disabled', /目前/.test(chBtn(76).closest('.chCard').textContent) && chBtn(76).disabled, chBtn(76).closest('.chCard').textContent);

/* ------------------------------- scan -------------------------------- */
const card = n => chBtn(n).closest('.chCard');
check('scan button offered', shown('btnScan') && !$('btnScan').disabled);
await until(() => links[1] === 2 && /運作中 2/.test(txt('mgSummary')));
const ns = cmds.length;
click($('btnScan'));
await sleep(50);
check('scan asks first', shown('confirmOverlay') && /掃描/.test(txt('confirmTitle')));
click($('btnConfirmYes'));
await until(() => /建議切換到頻道 2/.test(txt('mgChMsg')) && card(2).classList.contains('good'), 8000);
const seqOps = cmds.slice(ns).map(c => c.op).filter(op => op !== 253);
check('scan: standby first, then scan, then wake the two that were active',
      JSON.stringify(seqOps) === JSON.stringify([0x70, 209, 0x71, 0x71]), JSON.stringify(cmds.slice(ns).map(c => [c.op, c.args[0]])));
const wakes = cmds.slice(ns).filter(c => c.op === 0x71).map(c => c.args[0]);
check('...woken one by one (tracker 3 was already in standby)', JSON.stringify(wakes) === '[1,2]', JSON.stringify(wakes));
check('scan suggests the cleanest channel', /建議切換到頻道 2/.test(txt('mgChMsg')), txt('mgChMsg'));
check('channel 2 green and recommended', card(2).classList.contains('good') && /推薦/.test(card(2).textContent) && /0\.3%/.test(card(2).textContent), card(2).className + ' ' + card(2).textContent);
check('channel 76 yellow and current', card(76).classList.contains('fair') && card(76).classList.contains('cur') && /12\.0%|12%/.test(card(76).textContent), card(76).className + ' ' + card(76).textContent);
check('channel 24 red', card(24).classList.contains('bad'), card(24).className);
check('legend shown after a scan', shown('mgChLegend'));
check('no USB 3.0 warning for a normal room', !shown('mgUsb3'));
scanBusy = { 2: 770, 50: 800, 76: 980, 24: 900 };
click($('btnScan')); await sleep(50); click($('btnConfirmYes'));
await until(() => shown('mgUsb3'), 8000);
check('every channel crowded -> USB 3.0 advice', shown('mgUsb3') && /USB 3\.0/.test(txt('mgUsb3')));
scanBusy = { 2: 3, 50: 30, 76: 120, 24: 400 };

/* ---------------------------- calibration ---------------------------- */
check('calibration card with steps and illustration', shown('calCard') && $('calCard').querySelectorAll('.calSteps li').length === 3
      && $('calCard').querySelector('svg.calArt') && /平放/.test(txt('calCard')));
const nc = cmds.length;
click($('btnCal'));
await until(() => /失敗/.test(txt('calMsg')) || /完成/.test(txt('calMsg')), 12000);
const calOps = cmds.slice(nc).map(c => [c.op, c.args[0]]).filter(([op]) => op !== 253);
check('calibrate: standby tracker woken first, then subscribe, then CALIBRATE to all',
      JSON.stringify(calOps) === JSON.stringify([[0x71, 255], [224, 1], [2, 255]]), JSON.stringify(calOps));
check('subscription asks for calibration events from every tracker', JSON.stringify(subs[subs.length - 1]) === '[1,1,255,1]', JSON.stringify(subs));
const chip = id => $('calList').querySelector(`[data-tid="${id}"]`);
check('tracker 1 reported done', chip(1) && chip(1).classList.contains('ok') && /完成/.test(chip(1).textContent), chip(1) && chip(1).textContent);
check('tracker 2 failed with the reason (old cached END ignored)', chip(2) && chip(2).classList.contains('fail') && /晃動/.test(chip(2).textContent), chip(2) && chip(2).textContent);
check('tracker 3 (still in standby) listed as not calibrated', chip(3) && /未校正/.test(chip(3).textContent), chip(3) && chip(3).textContent);
check('summary says 1 ok, 1 failed', /1 顆成功、1 顆失敗/.test(txt('calMsg')), txt('calMsg'));
check('progress bar hidden afterwards', !shown('calProgress'));
calFail2 = false;
click($('btnCal'));
await until(() => /全部成功/.test(txt('calMsg')), 12000);
check('second run: all succeed', /2 顆全部成功/.test(txt('calMsg')), txt('calMsg'));
$('calTarget').value = '1'; $('calTarget').dispatchEvent(new window.Event('change'));
const nc1 = cmds.length;
click($('btnCal'));
await until(() => cmds.slice(nc1).some(c => c.op === 2) && /1 顆全部成功/.test(txt('calMsg')), 12000);
const oneOps = cmds.slice(nc1).map(c => [c.op, c.args[0]]).filter(([op]) => op !== 253 && op !== 224);
check('single tracker: CALIBRATE to tracker 1 only', JSON.stringify(oneOps) === '[[2,1]]', JSON.stringify(oneOps));
check('single tracker: only its result listed', $('calList').querySelectorAll('[data-tid]').length === 1 && /1 顆全部成功/.test(txt('calMsg')), txt('calMsg'));
$('calTarget').value = 'all'; $('calTarget').dispatchEvent(new window.Event('change'));
supportEvents = false;
click($('btnCal'));
await until(() => /已送出校正指令/.test(txt('calMsg')), 16000);
check('dongle without events: falls back to the light', /青色燈熄滅/.test(txt('calMsg')), txt('calMsg'));
supportEvents = true;

/* ---------------------- temperature calibration ---------------------- */
check('T-Cal box collapsed under advanced, with the how-to', !$('tcalBox').open && $('tcalBox').querySelectorAll('.tcHow li').length === 4);
check('T-Cal: finish disabled before starting', $('btnTcalStop').disabled && !$('btnTcalStart').disabled);
$('tcalBox').open = true;
const ntc = cmds.length;
click($('btnTcalStart'));
await until(() => /收集中/.test(txt('tcMsg')), 8000);
const tcOps = cmds.slice(ntc).map(c => [c.op, c.args[0]]).filter(([op]) => op !== 253 && op !== 224);
check('T-Cal start: wakes standby first, then auto-on to all trackers', JSON.stringify(tcOps.slice(-1)) === '[[19,255]]' && tcOps.every(([op]) => op === 0x71 || op === 0x13), JSON.stringify(tcOps));
const tcRow = id => $('tcList').querySelector(`[data-tid="${id}"]`);
await until(() => tcRow(1) && /本次 2 格/.test(tcRow(1).textContent), 3000);
check('tracker 1: two new slots, three from before', /本次 2 格/.test(tcRow(1).textContent) && /原有 3 格/.test(tcRow(1).textContent), tcRow(1) && tcRow(1).textContent);
check('tracker 1: coverage cells 40 and 41 lit', tcRow(1).querySelectorAll('.tcBar i.on').length === 2
      && tcRow(1).querySelectorAll('.tcBar i')[40].classList.contains('on'));
check('tracker 2: one slot; the auto-origin event is ignored', /本次 1 格/.test(tcRow(2).textContent) && tcRow(2).querySelectorAll('.tcBar i.on').length === 1, tcRow(2) && tcRow(2).textContent);
check('tracker 1 shows its IMU temperature', /30\.0°C/.test(tcRow(1).textContent), tcRow(1).textContent);
check('T-Cal: start disabled and finish enabled while collecting', $('btnTcalStart').disabled && !$('btnTcalStop').disabled);
/* warming 6 C/min: the page warns before the tracker throws the data away */
const warm = setInterval(() => { temp1 += 0.1; }, 1000).unref();
await until(() => /升溫太快/.test(tcRow(1).textContent), 30000);
clearInterval(warm);
check('fast warming flagged', /升溫太快/.test(tcRow(1).textContent), tcRow(1).textContent);
const ntc2 = cmds.length;
click($('btnTcalStop'));
await until(() => /已結束/.test(txt('tcMsg')), 8000);
check('T-Cal finish: auto-off to all', cmds.slice(ntc2).some(c => c.op === 0x14 && c.args[0] === 255));
check('tracker 2 under 4 slots: finish warns', /1 顆不到 4 格/.test(txt('tcMsg')), txt('tcMsg'));
check('tracker 1 (5 slots) finished ok', tcRow(1).querySelector('.calChip').classList.contains('ok'), tcRow(1).innerHTML);
check('T-Cal: can start again after finishing', !$('btnTcalStart').disabled && $('btnTcalStop').disabled);
$('tcTarget').value = '2'; $('tcTarget').dispatchEvent(new window.Event('change'));
const ntc3 = cmds.length;
click($('btnTcalStart'));
await until(() => /收集中/.test(txt('tcMsg')) && !$('btnTcalStop').disabled, 8000);
check('T-Cal single: auto-on to tracker 2 only, one row', cmds.slice(ntc3).some(c => c.op === 0x13 && c.args[0] === 2)
      && !cmds.slice(ntc3).some(c => c.op === 0x13 && c.args[0] === 255)
      && $('tcList').querySelectorAll('.tcRow').length === 1 && tcRow(2), $('tcList').innerHTML.slice(0, 120));
check('T-Cal single: target locked while collecting', $('tcTarget').disabled);
const ntc4 = cmds.length;
click($('btnTcalStop'));
await until(() => /已結束/.test(txt('tcMsg')), 8000);
check('T-Cal single: auto-off to tracker 2 only', cmds.slice(ntc4).some(c => c.op === 0x14 && c.args[0] === 2) && !cmds.slice(ntc4).some(c => c.op === 0x14 && c.args[0] === 255));
$('tcTarget').value = 'all'; $('tcTarget').dispatchEvent(new window.Event('change'));
$('tcalBox').open = false;

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

/* ------------------------ live update list -------------------------- */
const box3 = () => trow(3) && trow(3).querySelector('input');
check('tracker 3 starts not selectable (standby)', box3() && box3().disabled, trow(3) && trow(3).textContent);
awake3 = true; links[3] = 2;
await until(() => box3() && !box3().disabled, 12000);
check('tracker switched on after the scan becomes selectable on its own', box3() && !box3().disabled, trow(3) && trow(3).textContent);
check('...its version was read and, being outdated, it is ticked', /1\.0\.0/.test(trow(3).textContent) && box3().checked, trow(3).textContent);
awake3 = false; links[3] = 1;
await until(() => box3() && box3().disabled, 12000);
check('tracker going to standby is unticked and greyed out', box3() && box3().disabled && !box3().checked && /待機/.test(trow(3).textContent), trow(3) && trow(3).textContent);
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
check('report lists the trackers with battery', /#1 .*battery 85%/.test(txt('diagOut')) && /#3 .*standby/.test(txt('diagOut')), txt('diagOut').slice(0, 400));
check('report has the dongle status line', /dongle status: channel 76/.test(txt('diagOut')), txt('diagOut').slice(0, 400));

/* ------------------------- reset and remove -------------------------- */
await gotoPage('manage');
const rsOpts = () => [...$('rsTarget').options].map(o => o.value);
await until(() => rsOpts().length === 4);
check('reset target list: all + three trackers', JSON.stringify(rsOpts()) === '["all","1","2","3"]', JSON.stringify(rsOpts()));
check('remove disabled while "all" is selected', $('btnRsRemove').disabled && !$('btnRsCal').disabled);
// clear calibration on all
let n0r = cmds.length;
click($('btnRsCal'));
await sleep(50);
check('clear calibration asks first (no tick box)', shown('confirmOverlay') && !shown('confirmAckRow'));
check('confirm lists what is cleared; temperature calibration not by default',
      /零偏、加速度計、靈敏度/.test(txt('confirmText')) && !/溫度/.test(txt('confirmText')), txt('confirmText'));
click($('btnConfirmYes'));
await until(() => /已清除 3 顆/.test(txt('rsMsg')), 15000);
let calR = cmds.slice(n0r).filter(c => c.op !== 253).map(c => [c.op, c.args[0]]);
const perT = id => calR.filter(([, a]) => a === id).map(([op]) => op);
check('clear calibration: three resets per tracker (T-Cal kept), pairing untouched',
      JSON.stringify(perT(1)) === '[14,15,13]' && JSON.stringify(perT(3)) === '[14,15,13]' && !calR.some(([op]) => op === 8 || op === 250), JSON.stringify(calR));
const which = v => $('rsWhich').querySelector(`input[value="${v}"]`);
const tick = (v, on) => { which(v).checked = on; which(v).dispatchEvent(new window.Event('change')); };
tick('zro', false); tick('acc', false); tick('sens', false);
check('nothing ticked: clear calibration disabled', $('btnRsCal').disabled);
tick('zro', true); tick('tcal', true);
n0r = cmds.length;
click($('btnRsCal')); await sleep(50);
check('confirm names temperature calibration when ticked', /溫度校正/.test(txt('confirmText')), txt('confirmText'));
click($('btnConfirmYes'));
await until(() => cmds.slice(n0r).filter(c => c.op === 0x12).length === 3, 15000);
await until(() => /已清除 3 顆/.test(txt('rsMsg')), 15000);
calR = cmds.slice(n0r).filter(c => c.op !== 253).map(c => [c.op, c.args[0]]);
check('only the ticked ones: zero offset and temperature', JSON.stringify(perT(1)) === '[14,18]', JSON.stringify(calR));
tick('acc', true); tick('sens', true); tick('tcal', false);
// factory reset tracker 2
$('rsTarget').value = '2'; $('rsTarget').dispatchEvent(new window.Event('change'));
check('single tracker: remove enabled', !$('btnRsRemove').disabled);
n0r = cmds.length;
click($('btnRsFactory'));
await sleep(50);
check('factory reset needs the tick box', shown('confirmAckRow') && $('btnConfirmYes').disabled && $('btnConfirmYes').classList.contains('danger'));
$('confirmAck').checked = true; $('confirmAck').dispatchEvent(new window.Event('change'));
check('...ticking enables confirm', !$('btnConfirmYes').disabled);
click($('btnConfirmYes'));
await until(() => /已回復出廠/.test(txt('rsMsg')), 15000);
const facR = cmds.slice(n0r).filter(c => c.op !== 253).map(c => [c.op, c.args[0]]);
check('factory reset: resets + battery, then pairing, then remove from dongle',
      JSON.stringify(facR) === JSON.stringify([[14, 2], [15, 2], [13, 2], [18, 2], [16, 2], [8, 2], [250, 2]]), JSON.stringify(facR));
check('re-pair guide shown', shown('rsRepair'));
await until(() => !rsOpts().includes('2'));
check('tracker 2 gone from lists', !rsOpts().includes('2') && !$('mgList').querySelector('[data-tid="2"]'));
// remove tracker 3 (in standby, would work even when off)
links[3] = 0;
await until(() => /關機/.test(([...$('rsTarget').options].find(o => o.value === '3') || {}).textContent || ''), 4000);
$('rsTarget').value = '3'; $('rsTarget').dispatchEvent(new window.Event('change'));
check('off tracker: only remove is possible, with a note', $('btnRsCal').disabled && $('btnRsFactory').disabled && !$('btnRsRemove').disabled && shown('rsNote'));
n0r = cmds.length;
click($('btnRsRemove')); await sleep(50);
$('confirmAck').checked = true; $('confirmAck').dispatchEvent(new window.Event('change'));
click($('btnConfirmYes'));
await until(() => /已從 Dongle 移除追蹤器 3/.test(txt('rsMsg')), 4000);
const remR = cmds.slice(n0r).filter(c => c.op !== 253).map(c => [c.op, c.args[0]]);
check('remove: one REMOVE_ID, nothing sent to the tracker', JSON.stringify(remR) === '[[250,3]]', JSON.stringify(remR));
check('tracker 3 gone', !rsOpts().includes('3') && !$('mgList').querySelector('[data-tid="3"]'));
// old dongle
supportRemove = false; registered.add(3); links[3] = 1;
await until(() => rsOpts().includes('3'), 4000);
$('rsTarget').value = '3'; $('rsTarget').dispatchEvent(new window.Event('change'));
click($('btnRsRemove')); await sleep(50);
$('confirmAck').checked = true; $('confirmAck').dispatchEvent(new window.Event('change'));
click($('btnConfirmYes'));
await until(() => /新版 Dongle 韌體/.test(txt('rsMsg')), 4000);
check('old dongle: explains remove needs newer firmware', /新版 Dongle 韌體/.test(txt('rsMsg')) && rsOpts().includes('3'));

/* --------------------------- older dongle ---------------------------- */
supportStatus = false;
await gotoPage('manage');
await until(() => shown('mgOldDongle'), 4000);
check('dongle without STATUS: explains, and scan is disabled', shown('mgOldDongle') && $('btnScan').disabled);
check('report names the dongle firmware', /dongle: .*1\.0\.0/.test(txt('diagOut')));
check('download enabled after making it', !$('btnDiagDl').disabled);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
