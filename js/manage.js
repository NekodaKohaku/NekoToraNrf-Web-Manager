/* Manage page: the dongle's console commands as buttons.
 *
 * Everything here goes through the dongle's HID command channel (the same
 * one SlimeVR Server and the console reach), so it works with the server
 * running. Nothing is sent without a click, and the one command that moves
 * every device - a channel change - asks first.
 */
import { t } from './i18n.js';
import { OP, ACK, ALL_TRACKERS } from './ota.js';
import { isAwake } from './telemetry.js';
import { log } from './util.js';

/* Rendezvous channels, same order and values as ESB_SEARCH_CHANNELS in both
 * firmware repositories. The first is the default. */
export const RENDEZVOUS = [76, 2, 24, 50];
export const DEFAULT_CHANNEL = RENDEZVOUS[0];

const $ = id => document.getElementById(id);

/* How the page reads an ACK. A tracker command answers STARTED and then,
 * with the same seq, OK when every target confirmed or ENOENT when the dongle
 * stopped waiting - the command still went out, some tracker just did not
 * answer (switched off, out of range). */
export function ackOutcome(a, { final = false } = {}){
  if (!a) return 'noAnswer';
  if (a.status === ACK.EBUSY) return 'busy';
  if (a.status === ACK.OK || a.status === ACK.QUEUED) return 'ok';
  if (a.status === ACK.STARTED){
    if (!final) return 'ok';
    if (a.final && a.final.status === ACK.OK) return 'ok';
    return 'partial';
  }
  return 'fail';
}

export function createManage(ctx){
  /* ctx: { dongle(): Dongle|null, connect(): Promise, confirm(title, text): Promise<bool>,
   *        busy(): bool } */
  let timer = null;
  let running = false;

  function say(el, text, bad = false){
    const p = $(el);
    p.textContent = text;
    p.style.color = bad ? 'var(--err)' : '';
    p.classList.toggle('hidden', !text);
  }

  async function run(msgEl, op, args, { final = true, ok = 'mgDone', okParams, finalMs } = {}){
    const d = ctx.dongle();
    if (!d || running) return;
    if (ctx.busy()){ say(msgEl, t('mgBusyUpdate'), true); return; }
    running = true;
    setDisabled(true);
    say(msgEl, t('mgSending'));
    try {
      const a = await d.command(op, args, { final, finalMs });
      const out = ackOutcome(a, { final });
      log(`command op=${op} args=[${args.join(',')}] -> ${a ? a.status : 'none'}${a && a.final ? '/' + a.final.status : ''}`);
      if (out === 'ok') say(msgEl, t(ok, okParams));
      else if (out === 'partial') say(msgEl, t('mgPartial'));
      else if (out === 'busy') say(msgEl, t('mgBusy'), true);
      else if (out === 'noAnswer') say(msgEl, t('mgNoAnswer'), true);
      else say(msgEl, t('mgFail', { st: a.status }), true);
      return out;
    } catch (e){
      say(msgEl, t('mgNoAnswer'), true);
      log('command failed: ' + (e && e.message), 'err');
      return 'fail';
    } finally {
      running = false;
      setDisabled(false);
      render();
      /* Awake/dozing buttons depend on each row, not only on `running`. */
      const d = ctx.dongle();
      if (d) renderList(d);
    }
  }

  function setDisabled(on){
    for (const id of ['btnDozeAll', 'btnWakeAll', 'btnPairOn', 'btnPairOff']) $(id).disabled = on;
    for (const b of document.querySelectorAll('#chCards button, #mgList button')) b.disabled = on;
  }

  /* Rows are keyed by tracker id and updated in place: this runs every
   * second, and rebuilding the buttons under the pointer would swallow a
   * click that lands mid-refresh. */
  function renderList(d){
    const list = $('mgList');
    const now = Date.now();
    const ids = [...d.seen.keys()].sort((a, b) => a - b);
    let awake = 0;
    for (const id of ids){
      const e = d.seen.get(id);
      const up = isAwake(e, now);
      if (up) awake++;
      let row = list.querySelector(`[data-tid="${id}"]`);
      if (!row){
        row = document.createElement('div');
        row.dataset.tid = String(id);
        row.innerHTML = '<span class="tName"></span><span class="tInfo"></span><span class="tState"></span>';
        const find = document.createElement('button');
        find.className = 'linklike tBtn';
        find.onclick = () => run('mgMsg', OP.PING, [id], { ok: 'mgFindSent', okParams: { id } });
        row.appendChild(find);
        list.appendChild(row);
      }
      row.className = 'trk' + (up ? '' : ' dim');
      row.querySelector('.tName').textContent = t('otaTracker', { id });
      const bits = [];
      if (up && e.battery && e.battery.present){
        bits.push(e.battery.charging ? t('battCharging') : t('battPct', { pct: e.battery.pct }));
      }
      if (up && e.rssi !== undefined) bits.push(e.rssi + ' dBm');
      if (!up && e.addr) bits.push(e.addr);
      row.querySelector('.tInfo').textContent = bits.join(' · ');
      const badge = row.querySelector('.tState');
      badge.className = 'tState' + (up ? ' ok' : '');
      badge.textContent = up ? t('stAwake') : t('stAsleep');
      const find = row.querySelector('.tBtn');
      find.textContent = t('mgFind');
      /* A dozing tracker keeps its light forced off, so a ping would do
       * nothing visible; only offer it for awake ones. */
      find.disabled = !up || running;
    }
    for (const row of [...list.children]){
      if (!d.seen.has(Number(row.dataset.tid))) row.remove();
    }
    $('mgSummary').textContent = t('mgSummary', { a: awake, b: ids.length - awake });
  }

  function renderChannels(){
    const box = $('chCards');
    box.innerHTML = '';
    for (const n of RENDEZVOUS){
      const card = document.createElement('div');
      card.className = 'chCard';
      const title = document.createElement('div');
      title.className = 'chN';
      title.textContent = t('mgChCard', { n });
      const freq = document.createElement('div');
      freq.className = 'chF';
      freq.textContent = t('mgChFreq', { mhz: 2400 + n }) + (n === DEFAULT_CHANNEL ? ' · ' + t('mgChDefault') : '');
      const go = document.createElement('button');
      go.className = 'btn alt small';
      go.textContent = t('mgChGo');
      go.disabled = running;
      go.dataset.ch = String(n);
      go.onclick = () => switchChannel(n);
      card.append(title, freq, go);
      box.appendChild(card);
    }
  }

  async function switchChannel(n){
    if (!ctx.dongle() || running) return;
    const yes = await ctx.confirm(t('mgChConfirmT', { n }), t('mgChConfirm'));
    if (!yes) return;
    say('mgChMsg', t('mgChStarted', { n }));
    /* The default goes back as "no channel set" rather than as 76, so a later
     * change of the firmware default still applies to these units. */
    const [op, args] = n === DEFAULT_CHANNEL ? [OP.TRACKER_CH_CLR, []] : [OP.TRACKER_CH_ALL, [n]];
    const out = await run('mgChMsg', op, args, { ok: 'mgChDone', okParams: { n }, finalMs: 9000 });
    /* The move itself does not depend on every tracker confirming: the dongle
     * switches after announcing it, and stragglers search their way back. */
    if (out === 'partial') say('mgChMsg', t('mgChDone', { n }));
  }

  /* full: also rebuild the static parts (channel cards) - on showing the
   * page and on a language change, not on the one-second refresh. */
  function render(full = false){
    const d = ctx.dongle();
    $('manageNeed').classList.toggle('hidden', !!d);
    $('manageBody').classList.toggle('hidden', !d);
    if (!d) return;
    renderList(d);
    if (full || !$('chCards').children.length) renderChannels();
  }

  function bind(){
    $('btnManageConnect').onclick = () => ctx.connect();
    $('btnDozeAll').onclick = () => run('mgMsg', OP.DOZE, [ALL_TRACKERS]);
    $('btnWakeAll').onclick = () => run('mgMsg', OP.WAKE, [ALL_TRACKERS]);
    $('btnPairOn').onclick = () => run('mgPairMsg', OP.PAIR, [0], { final: false, ok: 'mgPairOnDone' });
    $('btnPairOff').onclick = () => run('mgPairMsg', OP.EXIT_PAIR, [], { final: false, ok: 'mgPairOffDone' });
    bindConsole();
  }

  /* ---- advanced: the dongle's text console over Web Serial ---- */
  let port = null, writer = null, reading = false;

  function out(text){
    const box = $('consoleOut');
    box.textContent = (box.textContent + text).slice(-20000);
    box.scrollTop = box.scrollHeight;
  }

  function bindConsole(){
    $('btnConsoleConnect').onclick = async () => {
      if (!navigator.serial) { out(t('errNoWebSerial') + '\n'); return; }
      try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        writer = port.writable.getWriter();
        $('consoleIn').disabled = false;
        $('btnConsoleSend').disabled = false;
        readLoop();
      } catch (e){
        if (e && e.name !== 'NotFoundError') out(String(e.message || e) + '\n');
      }
    };
    const send = async () => {
      const line = $('consoleIn').value;
      if (!writer || !line.trim()) return;
      $('consoleIn').value = '';
      out('> ' + line + '\n');
      try { await writer.write(new TextEncoder().encode(line + '\r\n')); }
      catch (_) { closed(); }
    };
    $('btnConsoleSend').onclick = send;
    $('consoleIn').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  async function readLoop(){
    if (reading || !port) return;
    reading = true;
    const dec = new TextDecoder();
    try {
      while (port && port.readable){
        const reader = port.readable.getReader();
        try {
          for (;;){
            const { value, done } = await reader.read();
            if (done) break;
            out(dec.decode(value, { stream: true }));
          }
        } finally { reader.releaseLock(); }
      }
    } catch (_) { /* unplugged */ }
    reading = false;
    closed();
  }

  function closed(){
    if (!port) return;
    try { writer && writer.releaseLock(); } catch (_) {}
    try { port.close(); } catch (_) {}
    port = null; writer = null;
    $('consoleIn').disabled = true;
    $('btnConsoleSend').disabled = true;
    out('\n' + t('mgConsoleOff') + '\n');
  }

  return {
    render,
    bind,
    show(){ render(true); if (!timer) timer = setInterval(() => { if (!running) render(); }, 1000); },
    hide(){ clearInterval(timer); timer = null; },
  };
}
