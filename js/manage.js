/* Manage page: the dongle's console commands as buttons.
 *
 * Everything here goes through the dongle's HID command channel (the same
 * one SlimeVR Server and the console reach), so it works with the server
 * running. Nothing is sent without a click, and the one command that moves
 * every device - a channel change - asks first.
 */
import { t } from './i18n.js';
import { OP, ACK, ALL_TRACKERS, LINK, TEV } from './ota.js';
import { isAwake, trackerState } from './telemetry.js';
import { log, sleep } from './util.js';

/* Rendezvous channels, same order and values as ESB_SEARCH_CHANNELS in both
 * firmware repositories. The first is the default. */
export const RENDEZVOUS = [76, 2, 24, 50];
export const DEFAULT_CHANNEL = RENDEZVOUS[0];

const $ = id => document.getElementById(id);

/* Channel colours from a scan, by the share of samples above -85 dBm: that
 * share is what predicts lost packets. */
export const BUSY_OK = 50;      // < 5 %: green
export const BUSY_BAD = 200;    // > 20 %: red; in between yellow
export function busyLevel(permille){
  return permille < BUSY_OK ? 'good' : permille > BUSY_BAD ? 'bad' : 'fair';
}
/* Every rendezvous channel this busy points at the PC, not the room: USB 3.0
 * next to the dongle raises the whole band. */
export const BUSY_USB3 = 500;

export function busyText(permille){
  const pct = permille / 10;
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
}

/* Calibration: how long the page waits for every tracker's result. A tracker
 * needs ~1-3 s to see it is still, 0.5 s, then 3-5 s of samples. */
export const CAL_WAIT_MS = 20000;
export const CAL_EXPECT_MS = 10000;     // what the progress bar is drawn over

/* Reason in a failed calibration END -> text key. */
export function calReasonKey(detail){
  if (detail === TEV.R_MOTION) return 'calR_motion';
  if (detail === TEV.R_TEMPERATURE) return 'calR_temp';
  if (detail === TEV.R_BUSY) return 'calR_busy';
  return 'calR_other';
}

/* Fold one tracker event into the per-tracker results of a calibration run.
 * `run` = { since, targets:Set, results:Map id -> {st, why?, op?} }.
 * Only ZRO operations a user asked for (no auto-origin bit), only targets,
 * only after the command went out: a fresh subscription replays each
 * tracker's last cached event, which may be an old calibration's END. */
export function calApplyEvent(run, e, now = Date.now()){
  if (now < run.since || e.kind !== TEV.KIND_ZRO || !run.targets.has(e.tracker)) return false;
  const r = run.results.get(e.tracker) || { st: 'wait' };
  if (r.st === 'ok' || r.st === 'fail') return false;
  if (e.event === TEV.END){
    if (r.op !== undefined && e.op !== r.op) return false;
    run.results.set(e.tracker, e.outcome === TEV.SUCCESS ? { st: 'ok', op: e.op }
      : { st: 'fail', op: e.op, why: calReasonKey(e.detail) });
  } else if (e.event === TEV.REJECTED){
    run.results.set(e.tracker, { st: 'fail', why: 'calR_busy' });
  } else {
    run.results.set(e.tracker, { st: 'run', op: r.op !== undefined ? r.op : e.op, phase: e.phase });
  }
  return true;
}

const STATE_LABEL = { awake: 'stAwake', standby: 'stStandby', off: 'stOff', asleep: 'stAsleep' };
export function stateLabel(st){ return t(STATE_LABEL[st] || 'stAsleep'); }

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
  let scan = null;        // last channel scan: { results, best, current, at }

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
    for (const id of ['btnDozeAll', 'btnWakeAll', 'btnPairOn', 'btnPairOff', 'btnCal', 'rsTarget', 'btnRsPair']) $(id).disabled = on;
    if (on) for (const id of ['btnRsCal', 'btnRsFactory', 'btnRsRemove']) $(id).disabled = true;
    $('btnScan').disabled = on || ctx.dongle() && ctx.dongle().statusSupported === false;
    for (const b of document.querySelectorAll('#chCards button, #mgList button')) b.disabled = on;
  }

  /* Rows are keyed by tracker id and updated in place: this runs every
   * second, and rebuilding the buttons under the pointer would swallow a
   * click that lands mid-refresh. */
  function renderList(d){
    const list = $('mgList');
    const now = Date.now();
    const ids = [...d.seen.keys()].sort((a, b) => a - b);
    const count = { awake: 0, standby: 0, off: 0, asleep: 0 };
    for (const id of ids){
      const e = d.seen.get(id);
      const st = trackerState(d, id, now);
      const up = st === 'awake';
      count[st]++;
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
      if (isAwake(e, now) && e.battery && e.battery.present){
        bits.push(e.battery.charging ? t('battCharging') : t('battPct', { pct: e.battery.pct }));
      }
      if (isAwake(e, now) && e.rssi !== undefined) bits.push(e.rssi + ' dBm');
      if (!up && e.addr) bits.push(e.addr);
      row.querySelector('.tInfo').textContent = bits.join(' · ');
      const badge = row.querySelector('.tState');
      badge.className = 'tState' + (up ? ' ok' : st === 'standby' ? ' sb' : '');
      badge.textContent = stateLabel(st);
      const find = row.querySelector('.tBtn');
      find.textContent = t('mgFind');
      /* A tracker in standby keeps its light forced off, so a ping would do
       * nothing visible; only offer it for awake ones. */
      find.disabled = !up || running;
    }
    for (const row of [...list.children]){
      if (!d.seen.has(Number(row.dataset.tid))) row.remove();
    }
    const fresh = d.status && now - d.status.at < 6000;
    $('mgSummary').textContent = fresh
      ? t('mgSummary3', { a: count.awake, s: count.standby, o: count.off })
      : t('mgSummary', { a: count.awake, b: ids.length - count.awake });
    $('mgOldDongle').classList.toggle('hidden', d.statusSupported !== false);
    renderChannelState(d);
    renderResetTargets(d, now);
  }

  /* Cards are built once (full render) and their state - current, scan
   * colour, recommended - refreshed in place with the list. */
  function renderChannels(){
    const box = $('chCards');
    box.innerHTML = '';
    for (const n of RENDEZVOUS){
      const card = document.createElement('div');
      card.className = 'chCard';
      card.dataset.ch = String(n);
      const head = document.createElement('div');
      head.className = 'chHead';
      const title = document.createElement('span');
      title.className = 'chN';
      title.textContent = t('mgChCard', { n });
      const tag = document.createElement('span');
      tag.className = 'chTag hidden';
      head.append(title, tag);
      const freq = document.createElement('div');
      freq.className = 'chF';
      freq.textContent = t('mgChFreq', { mhz: 2400 + n }) + (n === DEFAULT_CHANNEL ? ' · ' + t('mgChDefault') : '');
      const busy = document.createElement('div');
      busy.className = 'chBusy hidden';
      const go = document.createElement('button');
      go.className = 'btn alt small';
      go.dataset.ch = String(n);
      go.onclick = () => switchChannel(n);
      card.append(head, freq, busy, go);
      box.appendChild(card);
    }
    const d = ctx.dongle();
    if (d) renderChannelState(d);
  }

  function currentChannel(d){
    if (d.status && Date.now() - d.status.at < 6000) return d.status.channel;
    return scan ? scan.current : null;
  }

  function renderChannelState(d){
    const cur = currentChannel(d);
    for (const card of document.querySelectorAll('#chCards .chCard')){
      const n = Number(card.dataset.ch);
      const r = scan ? scan.results.find(x => x.channel === n) : null;
      const lvl = r ? busyLevel(r.busy) : '';
      card.className = 'chCard' + (lvl ? ' ' + lvl : '') + (n === cur ? ' cur' : '');
      const tag = card.querySelector('.chTag');
      const tags = [];
      if (n === cur) tags.push(t('mgChCurrent'));
      if (scan && scan.best === n && n !== cur) tags.push(t('mgChBest'));
      tag.textContent = tags.join(' · ');
      tag.classList.toggle('hidden', !tags.length);
      const busy = card.querySelector('.chBusy');
      busy.textContent = r ? t('mgChBusy', { pct: busyText(r.busy), lvl: t('mgLvl_' + lvl) }) : '';
      busy.classList.toggle('hidden', !r);
      const go = card.querySelector('button');
      go.textContent = n === cur ? t('mgChInUse') : t('mgChGo');
      go.disabled = running || n === cur;
    }
    $('mgChLegend').classList.toggle('hidden', !scan);
    $('btnScan').disabled = running || d.statusSupported === false;
    const tip = scan && RENDEZVOUS.every(n => {
      const r = scan.results.find(x => x.channel === n);
      return r && r.busy > BUSY_USB3;
    });
    $('mgUsb3').classList.toggle('hidden', !tip);
  }

  /* ---- calibration (gyro zero offset, every tracker at once) ---- */
  let calRun = null;

  function renderCal(){
    const box = $('calList');
    if (!calRun){ box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '';
    const skip = new Map(calRun.skipped.map(x => [x.id, x.st]));
    for (const id of [...calRun.targets, ...skip.keys()].sort((a, b) => a - b)){
      const r = skip.has(id) ? { st: skip.get(id) === 'standby' ? 'skipSb' : 'skip' } : (calRun.results.get(id) || { st: 'wait' });
      const chip = document.createElement('span');
      chip.className = 'calChip ' + r.st;
      chip.dataset.tid = String(id);
      const label = r.st === 'fail' ? t('calStFail', { why: t(r.why || 'calR_none') })
        : t({ wait: 'calStWait', run: 'calStRun', ok: 'calStOk', skip: 'calStSkip', skipSb: 'calStSkipSb' }[r.st]);
      chip.textContent = t('otaTracker', { id }) + ' · ' + label;
      box.appendChild(chip);
    }
  }

  function setCalBar(frac){
    $('calProgress').classList.toggle('hidden', frac === null);
    if (frac !== null) $('calBar').style.width = Math.round(Math.min(1, frac) * 100) + '%';
  }

  async function calibrateAll(){
    const d = ctx.dongle();
    if (!d || running) return;
    if (ctx.busy()){ say('calMsg', t('mgBusyUpdate'), true); return; }
    running = true;
    setDisabled(true);
    $('calCard').classList.add('calOn');
    let off = null, tick = null;
    try {
      const ids = () => [...d.seen.keys()].sort((a, b) => a - b);
      /* A tracker in standby has its sensor stopped: wake those first. */
      if (ids().some(id => ['standby', 'asleep'].includes(trackerState(d, id)))){
        say('calMsg', t('calWaking'));
        await d.command(OP.WAKE, [ALL_TRACKERS], { final: true, finalMs: 6000 });
        await sleep(3000);
        if (d.statusSupported) await d.queryStatus().catch(() => null);
      }
      const targets = ids().filter(id => trackerState(d, id) === 'awake');
      const skipped = ids().filter(id => !targets.includes(id)).map(id => ({ id, st: trackerState(d, id) }));
      if (!targets.length){ say('calMsg', t('calNone'), true); return; }

      const events = await d.subscribeCalEvents().catch(() => false);
      if (events) await sleep(300);             // let the replayed cache go by
      calRun = { since: Date.now(), targets: new Set(targets), skipped, results: new Map(), events };
      off = d.onTrackerEvent(e => { if (calApplyEvent(calRun, e)) renderCal(); });
      renderCal();
      say('calMsg', t('calRunning'));
      const t0 = Date.now();
      setCalBar(0);
      tick = setInterval(() => setCalBar((Date.now() - t0) / CAL_EXPECT_MS), 200);

      const a = await d.command(OP.CALIBRATE, [ALL_TRACKERS], { final: true, finalMs: 6000 });
      const out = ackOutcome(a, { final: true });
      log(`calibrate all -> ${a ? a.status : 'none'}${a && a.final ? '/' + a.final.status : ''}, events ${events ? 'on' : 'off'}`);
      if (out === 'busy' || out === 'noAnswer' || out === 'fail'){
        say('calMsg', t(out === 'busy' ? 'mgBusy' : out === 'noAnswer' ? 'mgNoAnswer' : 'mgFail', { st: a && a.status }), true);
        calRun = null;
        return;
      }

      if (!events){
        /* No results from this dongle: give the trackers their time, then
         * say what the light shows. */
        while (Date.now() - t0 < CAL_EXPECT_MS) await sleep(200);
        say('calMsg', t('calSent'));
        calRun = null;
        return;
      }
      let renewed = false;
      const done = () => targets.every(id => {
        const r = calRun.results.get(id);
        return r && (r.st === 'ok' || r.st === 'fail');
      });
      while (!done() && Date.now() - t0 < CAL_WAIT_MS){
        if (!renewed && Date.now() - t0 > TEV.LEASE_MS - 5000){
          renewed = true;
          await d.subscribeCalEvents(TEV.RENEW).catch(() => false);
        }
        await sleep(200);
      }
      for (const id of targets){
        const r = calRun.results.get(id);
        if (!r || (r.st !== 'ok' && r.st !== 'fail')) calRun.results.set(id, { st: 'fail', why: 'calR_none' });
      }
      renderCal();
      const ok = targets.filter(id => calRun.results.get(id).st === 'ok').length;
      if (ok === targets.length) say('calMsg', t('calAllOk', { n: ok }));
      else say('calMsg', t('calSomeFail', { ok, bad: targets.length - ok }), true);
    } catch (e){
      say('calMsg', t('mgNoAnswer'), true);
      log('calibration failed: ' + (e && e.message), 'err');
    } finally {
      if (off) off();
      clearInterval(tick);
      setCalBar(null);
      $('calCard').classList.remove('calOn');
      running = false;
      setDisabled(false);
      renderCal();
      render();
    }
  }

  /* ---- reset: clear calibration, factory reset, remove from dongle ---- */
  let rsRun = null;            // { order:[id], res: Map id -> {st, why?} }

  const RS_CAL_OPS = [OP.RESET_ZRO, OP.RESET_ACC, OP.SENS_RESET, OP.RESET_TCAL];

  function rsSelected(){
    const v = $('rsTarget').value;
    return v === 'all' || v === '' ? 'all' : Number(v);
  }

  /* Options are kept in place (the list refreshes every second and a
   * rebuilt <select> would close under the pointer). */
  function renderResetTargets(d, now = Date.now()){
    const sel = $('rsTarget');
    const ids = [...d.seen.keys()].sort((a, b) => a - b);
    const want = ['all', ...ids.map(String)];
    for (const o of [...sel.options]) if (!want.includes(o.value)) o.remove();
    want.forEach((v, i) => {
      let o = [...sel.options].find(x => x.value === v);
      if (!o){ o = document.createElement('option'); o.value = v; sel.insertBefore(o, sel.options[i] || null); }
      o.textContent = v === 'all' ? t('rsAll')
        : t('otaTracker', { id: Number(v) }) + ' · ' + stateLabel(trackerState(d, Number(v), now));
    });
    if (!want.includes(sel.value)) sel.value = 'all';
    renderResetButtons(d, now);
  }

  function renderResetButtons(d, now = Date.now()){
    if (running) return;
    const target = rsSelected();
    const reachable = id => trackerState(d, id, now) !== 'off';
    let note = '';
    let canCal, canRemove;
    if (target === 'all'){
      canCal = [...d.seen.keys()].some(reachable);
      canRemove = false;
      if (!canCal && d.seen.size) note = t('rsNeedOn');
    } else {
      canCal = reachable(target);
      canRemove = d.removeSupported !== false;
      if (!canCal) note = t('rsNeedOnOne');
      else if (d.removeSupported === false) note = t('rsOldDongle');
    }
    $('btnRsCal').disabled = !canCal;
    $('btnRsFactory').disabled = !canCal;
    $('btnRsRemove').disabled = !canRemove;
    $('btnRsRemove').title = target === 'all' ? t('rsRemoveOneOnly') : '';
    $('rsNote').textContent = note;
    $('rsNote').classList.toggle('hidden', !note);
  }

  function renderResetList(){
    const box = $('rsList');
    if (!rsRun){ box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '';
    for (const id of rsRun.order){
      const r = rsRun.res.get(id) || { st: 'wait' };
      const chip = document.createElement('span');
      chip.className = 'calChip ' + r.st;
      chip.dataset.tid = String(id);
      const label = r.st === 'fail' ? t('calStFail', { why: t(r.why) })
        : t({ wait: 'calStWait', run: 'rsStRun', ok: 'calStOk', skip: 'rsStSkip', warn: r.why }[r.st] || 'calStOk');
      chip.textContent = t('otaTracker', { id }) + ' · ' + label;
      box.appendChild(chip);
    }
  }

  /* Wake trackers in standby among `ids` (their sensors are stopped and some
   * resets touch the sensor state), then return those reachable now. */
  async function rsPrepare(d, ids){
    if (ids.some(id => ['standby', 'asleep'].includes(trackerState(d, id)))){
      say('rsMsg', t('calWaking'));
      await d.command(OP.WAKE, [ALL_TRACKERS], { final: true, finalMs: 6000 });
      await sleep(3000);
      if (d.statusSupported) await d.queryStatus().catch(() => null);
    }
  }

  async function rsSend(d, op, args, finalMs = 4000){
    const a = await d.command(op, args, { final: true, finalMs });
    return ackOutcome(a, { final: true });
  }

  async function resetAction(kind){
    const d = ctx.dongle();
    if (!d || running) return;
    if (ctx.busy()){ say('rsMsg', t('mgBusyUpdate'), true); return; }
    const target = rsSelected();
    const ids = target === 'all' ? [...d.seen.keys()].sort((a, b) => a - b) : [target];
    const who = target === 'all' ? t('rsAllShort') : t('otaTracker', { id: target });
    const ok = kind === 'cal'
      ? await ctx.confirm(t('rsCalConfirmT', { who }), t('rsCalConfirm'))
      : kind === 'factory'
        ? await ctx.confirm(t('rsFactoryConfirmT', { who }), t('rsFactoryConfirm'), { danger: true, ack: t('rsAck') })
        : await ctx.confirm(t('rsRemoveConfirmT', { who }), t('rsRemoveConfirm'), { danger: true, ack: t('rsAck') });
    if (!ok) return;
    running = true;
    setDisabled(true);
    $('rsRepair').classList.add('hidden');
    try {
      if (kind === 'remove'){
        rsRun = null; renderResetList();
        say('rsMsg', t('mgSending'));
        const a = await d.command(OP.REMOVE_ID, [target], { timeoutMs: 1500 });
        log(`remove id ${target} -> ${a ? a.status : 'none'}`);
        if (a && a.status === ACK.OK){
          d.removeSupported = true;
          d.seen.delete(target);
          say('rsMsg', t('rsRemoved', { id: target }));
        } else if (a && a.status === ACK.ENOENT){
          d.removeSupported = true;
          d.seen.delete(target);
          say('rsMsg', t('rsRemoveGone', { id: target }));
        } else if (a && a.status === ACK.EINVAL){
          d.removeSupported = false;
          say('rsMsg', t('rsOldDongle'), true);
        } else {
          say('rsMsg', t('mgNoAnswer'), true);
        }
        return;
      }

      await rsPrepare(d, ids);
      const live = ids.filter(id => trackerState(d, id) !== 'off');
      rsRun = { order: ids, res: new Map(ids.filter(id => !live.includes(id)).map(id => [id, { st: 'skip' }])) };
      renderResetList();
      say('rsMsg', t('rsWorking'));
      let done = 0, removedOld = false;
      for (const id of live){
        rsRun.res.set(id, { st: 'run' }); renderResetList();
        const ops = kind === 'factory' ? [...RS_CAL_OPS, OP.RESET_BAT] : RS_CAL_OPS;
        let failed = false;
        for (const op of ops){
          const out = await rsSend(d, op, [id]);
          log(`reset op=${op} id=${id} -> ${out}`);
          if (out !== 'ok'){ failed = true; break; }
        }
        if (failed){
          rsRun.res.set(id, { st: 'fail', why: 'rsR_noAnswer' }); renderResetList();
          continue;
        }
        if (kind === 'factory'){
          /* Pairing last: after this the tracker no longer takes commands,
           * so it may never confirm - the dongle stops waiting (partial). */
          const out = await rsSend(d, OP.CLEAR_PAIR, [id], 6000);
          log(`clear pairing id=${id} -> ${out}`);
          if (out === 'busy' || out === 'noAnswer'){
            rsRun.res.set(id, { st: 'fail', why: 'rsR_noAnswer' }); renderResetList();
            continue;
          }
          const a = await d.command(OP.REMOVE_ID, [id], { timeoutMs: 1500 });
          log(`remove id ${id} -> ${a ? a.status : 'none'}`);
          if (a && (a.status === ACK.OK || a.status === ACK.ENOENT)){
            d.removeSupported = true;
            d.seen.delete(id);
            rsRun.res.set(id, { st: 'ok' });
          } else {
            if (a && a.status === ACK.EINVAL) d.removeSupported = false;
            removedOld = true;
            rsRun.res.set(id, { st: 'warn', why: 'rsStNotRemoved' });
          }
        } else {
          rsRun.res.set(id, { st: 'ok' });
        }
        done++;
        renderResetList();
      }
      const failedN = live.length - done;
      if (kind === 'cal'){
        say('rsMsg', failedN ? t('rsCalSome', { ok: done, bad: failedN }) : t('rsCalDone', { n: done }), !!failedN);
      } else {
        say('rsMsg', (failedN ? t('rsFactorySome', { ok: done, bad: failedN }) : t('rsFactoryDone', { n: done }))
          + (removedOld ? ' ' + t('rsOldDongle') : ''), !!failedN);
        if (done) $('rsRepair').classList.remove('hidden');
      }
    } catch (e){
      say('rsMsg', t('mgNoAnswer'), true);
      log('reset failed: ' + (e && e.message), 'err');
    } finally {
      running = false;
      setDisabled(false);
      renderResetList();
      render();
    }
  }

  async function scanChannels(){
    const d = ctx.dongle();
    if (!d || running) return;
    if (ctx.busy()){ say('mgChMsg', t('mgBusyUpdate'), true); return; }
    if (!(await ctx.confirm(t('mgScanConfirmT'), t('mgScanConfirm')))) return;
    running = true;
    setDisabled(true);
    let awakeIds = [];
    try {
      /* Awake trackers keep retrying on the current channel while the dongle
       * is not listening; that is our own traffic and would paint the
       * current channel red. Put them in standby first, wake them after. */
      const st0 = await d.queryStatus().catch(() => null);
      const known = st0 ? st0.links.map((l, id) => ({ l, id })).filter(x => x.l !== LINK.GONE) : [];
      awakeIds = known.filter(x => x.l === LINK.AWAKE).map(x => x.id);
      if (awakeIds.length){
        say('mgChMsg', t('mgScanDozing'));
        await d.command(OP.DOZE, [ALL_TRACKERS], { final: true, finalMs: 6000 });
        for (let i = 0; i < 10; i++){
          await sleep(500);
          const s1 = await d.queryStatus().catch(() => null);
          if (!s1 || !s1.links.includes(LINK.AWAKE)) break;
        }
      }
      say('mgChMsg', t('mgScanRunning'));
      const r = await d.rssiScan();
      log(`channel scan: ${r.ok ? r.results.map(x => `${x.channel}=${x.busy}`).join(' ') + ` best=${r.best} cur=${r.current}` : 'no result' + (r.busy ? ' (busy)' : '')}`);
      if (r.ok){
        scan = { results: r.results, best: r.best, current: r.current, at: Date.now() };
      }
      if (awakeIds.length){
        say('mgChMsg', t('mgScanWaking'));
        if (awakeIds.length === known.length){
          await d.command(OP.WAKE, [ALL_TRACKERS], { final: true, finalMs: 6000 });
        } else {
          for (const id of awakeIds) await d.command(OP.WAKE, [id], { final: true, finalMs: 4000 });
        }
      }
      if (!r.ok) say('mgChMsg', t(r.busy ? 'mgBusy' : 'mgScanFail'), true);
      else if (r.best === null) say('mgChMsg', t('mgScanDone'));
      else if (r.best === r.current) say('mgChMsg', t('mgScanKeep', { n: r.best }));
      else say('mgChMsg', t('mgScanSuggest', { n: r.best }));
    } catch (e){
      say('mgChMsg', t('mgNoAnswer'), true);
      log('channel scan failed: ' + (e && e.message), 'err');
    } finally {
      running = false;
      setDisabled(false);
      render();
      d.queryStatus().then(() => render(), () => {});
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
    const d = ctx.dongle();
    if (d && d.statusSupported){ await d.queryStatus().catch(() => null); render(); }
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
    if (full){ renderCal(); renderResetList(); }
  }

  function bind(){
    $('btnManageConnect').onclick = () => ctx.connect();
    $('btnDozeAll').onclick = () => run('mgMsg', OP.DOZE, [ALL_TRACKERS]);
    $('btnWakeAll').onclick = () => run('mgMsg', OP.WAKE, [ALL_TRACKERS]);
    $('btnPairOn').onclick = () => run('mgPairMsg', OP.PAIR, [0], { final: false, ok: 'mgPairOnDone' });
    $('btnPairOff').onclick = () => run('mgPairMsg', OP.EXIT_PAIR, [], { final: false, ok: 'mgPairOffDone' });
    $('btnScan').onclick = () => scanChannels();
    $('btnCal').onclick = () => calibrateAll();
    $('rsTarget').onchange = () => { const d = ctx.dongle(); if (d) renderResetButtons(d); };
    $('btnRsCal').onclick = () => resetAction('cal');
    $('btnRsFactory').onclick = () => resetAction('factory');
    $('btnRsRemove').onclick = () => resetAction('remove');
    $('btnRsPair').onclick = () => run('rsMsg', OP.PAIR, [0], { final: false, ok: 'rsPairOn' });
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
    /* A different dongle has other surroundings: forget the last scan. */
    reset(){ scan = null; calRun = null; rsRun = null; },
    bind,
    show(){ render(true); if (!timer) timer = setInterval(() => { if (!running) render(); }, 1000); },
    hide(){ clearInterval(timer); timer = null; },
  };
}
