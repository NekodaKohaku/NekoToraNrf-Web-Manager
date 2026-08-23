/* UI and flow control.
 *
 * There is one wizard, not three. The method chooser at the top is drawn as a
 * tab strip because that reads unambiguously - a customer should never be in
 * doubt about which of the three they are doing - but underneath, steps 2-4 are
 * the same markup and the same state machine for all of them. Only the connect
 * pane and a `method` descriptor differ.
 *
 * Duplicating the wizard per method was the alternative, and it would mean
 * three copies of firmware selection, three progress bars, three sets of error
 * handling and three sets of translations, drifting apart over time.
 */
import { CONFIG, DFU_BAUD } from './config.js';
import { mkErr, log, logLines, bindLog, clearLog, hex, verStr, kb } from './util.js';
import { t, errText, applyLang, detectLang, getLang, LANGS } from './i18n.js';
import { parseIntelHex, classifySegments } from './hex.js';
import { parseUpdateBin, looksLikeUpdateBin } from './image.js';
import { WebUSBTransport, WebHIDTransport, DAP } from './swd.js';
import { flashViaSwd } from './flash.js';
import { Dongle, OtaClient } from './ota.js';
import { SmpPort, enterRecovery, uploadImage } from './smp.js';
import * as reg from './registry.js';

const $ = id => document.getElementById(id);

/* ======================= method descriptors ========================== */

/* `needs` decides which manifest field is fetched, and therefore which file
 * format the manual picker will accept. Getting this wrong is the one mistake
 * that can leave a tracker unbootable, which is why the normal flow never asks
 * the user to choose. */
const METHODS = {
  ota: { id: 'ota', needs: 'bin', pane: 'paneOta', name: 'mOtaName', tag: 'mOtaTag',
         desc: 'mOtaDesc', connTitle: 'otaStepConnect',
         connDesc: 'otaConnectDesc', accept: '.bin', tagAlt: false },
  dfu: { id: 'dfu', needs: 'bin', pane: 'paneDfu', name: 'mDfuName', tag: null,
         desc: 'mDfuDesc', connTitle: 'dfuStepConnect',
         connDesc: 'dfuConnectDesc', accept: '.bin' },
  swd: { id: 'swd', needs: 'hex', pane: 'paneSwd', name: 'mSwdName', tag: 'mSwdTag',
         desc: 'mSwdDesc', connTitle: 'step1Title',
         connDesc: 'step1Desc', accept: '.hex,.ihex', tagAlt: true },
};
const ORDER = ['ota', 'dfu', 'swd'];

/* ============================= state ================================= */

const state = {
  method: 'ota',
  device: null,          // registry entry
  manifest: null,
  manualFw: null,        // {kind, name, ...} when the user overrode the file
  busy: false,

  // SWD
  tr: null, dap: null, probeName: '',
  // wireless
  dongle: null, ota: null, trackers: new Map(), selected: new Set(),
  // wired
  smp: null, port: null, inRecovery: false,
};

const M = () => METHODS[state.method];

/* ========================= progress plumbing ========================= */

let PH = {};
function makePhases(verify){
  PH = verify
    ? { connect: [0, .08], erase: [.08, .35], program: [.35, .8], verify: [.8, .97], reset: [.97, 1] }
    : { connect: [0, .08], erase: [.08, .4],  program: [.4, .95], verify: [.95, .95], reset: [.95, 1] };
}
function setBar(frac){
  const p = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  $('barFill').style.width = p + '%';
  $('pct').textContent = p + '%';
}
function phase(name, frac){
  const [a, b] = PH[name] || [0, 1];
  setBar(a + (b - a) * Math.min(1, Math.max(0, frac)));
}
function setStage(key, params){
  $('stageLabel').textContent = key ? t(key, params) : '';
}
function setDetail(txt){ $('pct').textContent = txt; }

/* Per-tracker progress rows.
 *
 * Rows are keyed by tracker id and reused rather than rebuilt, so the CSS width
 * transition animates instead of restarting on every status packet - which
 * arrives several times a second.
 *
 * A tracker that drops out keeps its row and turns red. Removing it would make
 * the failure vanish exactly when the customer needs to see which unit it was.
 */
const P_STATE = {
  queued: 'pQueued', sending: 'pSending', done: 'pArrived',
  verifying: 'pVerifying', activating: 'pActivating',
  complete: 'pComplete', failed: 'pFailed',
};

function renderTrackerProgress(per){
  const box = $('trkProgress');
  if (!per || !per.length){ box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');

  const seen = new Set();
  for (const row of per){
    seen.add(row.id);
    let el = box.querySelector(`[data-tid="${row.id}"]`);
    if (!el){
      el = document.createElement('div');
      el.className = 'tp';
      el.dataset.tid = row.id;
      el.innerHTML = '<span class="tpName"></span><span class="tpBar"><div></div></span><span class="tpState"></span>';
      el.querySelector('.tpName').textContent = t('otaTracker', { id: row.id });
      box.appendChild(el);
    }
    el.className = 'tp' + (row.state === 'failed' ? ' failed'
                        : row.state === 'complete' ? ' complete' : '');
    el.querySelector('.tpBar > div').style.width =
      Math.round(Math.max(0, Math.min(1, row.pct || 0)) * 100) + '%';
    el.querySelector('.tpState').textContent = row.state === 'failed' && row.error
      ? t('pFailed')
      : t(P_STATE[row.state] || 'pSending');
    el.title = row.state === 'failed' && row.error ? errText(row.error) : '';
  }
  for (const el of [...box.children]){
    if (!seen.has(Number(el.dataset.tid))) el.remove();
  }
}

/* ============================ rendering ============================== */

function renderMethods(){
  const box = $('methods');
  box.innerHTML = '';
  for (const id of ORDER){
    const m = METHODS[id];
    const b = document.createElement('button');
    b.className = 'method';
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(id === state.method));
    b.innerHTML =
      `<div class="mName"><span></span>${m.tag ? `<span class="mTag${m.tagAlt ? ' alt' : ''}"></span>` : ''}</div>` +
      `<div class="mDesc"></div>`;
    b.querySelector('.mName span').textContent = t(m.name);
    if (m.tag) b.querySelector('.mTag').textContent = t(m.tag);
    b.querySelector('.mDesc').textContent = t(m.desc);
    b.onclick = () => selectMethod(id);
    box.appendChild(b);
  }
}

function renderConnect(){
  const m = M();
  $('connTitle').textContent = t(m.connTitle);
  $('connDesc').textContent = t(m.connDesc);
  for (const id of ORDER) $(METHODS[id].pane).classList.toggle('hidden', id !== state.method);
  $('swdOpts').classList.toggle('hidden', state.method !== 'swd');

  const st = $('connStatus');
  st.classList.remove('ok');
  if (state.method === 'swd'){
    st.textContent = state.tr ? t('probeConnected', { name: state.probeName }) : t('probeNone');
    if (state.tr) st.classList.add('ok');
  } else if (state.method === 'ota'){
    st.textContent = state.dongle ? t('otaDongleOk', { name: state.dongle.name }) : t('otaDongleNone');
    if (state.dongle) st.classList.add('ok');
    $('btnRescan').classList.toggle('hidden', !state.dongle);
    $('otaPick').classList.toggle('hidden', !state.dongle || !state.trackers.size);
  } else {
    st.textContent = state.port ? t('dfuPortOk') : t('dfuPortNone');
    if (state.port) st.classList.add('ok');
    $('dfuModeBox').classList.toggle('hidden', !state.port);
    const ms = $('dfuModeStatus');
    ms.textContent = state.inRecovery ? t('dfuModeIn') : t('dfuModeUnknown');
    ms.classList.toggle('ok', state.inRecovery);
  }
}

function renderTrackers(){
  const list = $('trackerList');
  list.innerHTML = '';
  const want = state.manifest && state.manifest.boardTarget;

  for (const [id, tk] of state.trackers){
    const row = document.createElement('div');
    row.className = 'trk';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(id);

    /* A tracker is only selectable when it is awake and reports the same
     * board_target as the firmware. The tracker enforces this itself - BEGIN
     * with a mismatched target comes back BOARD_MISMATCH and nothing is
     * written - so this is about not offering an action that cannot work,
     * rather than about safety. */
    const eligible = tk.online && tk.info &&
                     (!want || tk.info.boardTarget === want);
    cb.disabled = !eligible;
    if (!eligible) row.classList.add('dim');
    cb.onchange = () => {
      if (cb.checked) state.selected.add(id); else state.selected.delete(id);
      renderSelCount(); gate();
    };

    const name = document.createElement('span');
    name.className = 'tName';
    name.textContent = t('otaTracker', { id });

    const info = document.createElement('span');
    info.className = 'tInfo';

    const badge = document.createElement('span');
    badge.className = 'tState';

    if (!tk.online){
      info.textContent = tk.addr ? tk.addr : '';
      badge.textContent = t('otaOffline');
    } else if (tk.querying){
      info.textContent = t('otaQuerying');
      badge.textContent = '…';
    } else if (!tk.info){
      info.textContent = t('otaNoInfo');
      badge.textContent = '?';
    } else if (want && tk.info.boardTarget !== want){
      info.textContent = tk.info.version;
      badge.textContent = t('otaMismatch', { board: tk.info.boardTarget || '?' });
      badge.classList.add('warn');
    } else {
      const latest = state.manifest ? state.manifest.versionCode : null;
      info.textContent = tk.info.version + ' · ' + tk.info.bootloader;
      if (latest !== null && tk.info.versionCode >= latest){
        badge.textContent = t('otaUpToDate');
        badge.classList.add('ok');
      } else {
        badge.textContent = t('otaNeedsUpdate', {
          from: tk.info.version,
          to: state.manifest ? state.manifest.version : '?',
        });
        badge.classList.add('upd');
      }
    }

    row.append(cb, name, info, badge);
    list.appendChild(row);
  }
  renderSelCount();
}

function renderSelCount(){
  const n = state.selected.size;
  $('otaSelCount').textContent = n ? t('otaSelected', { n }) : '';
}

function fwRangeText(fw){
  if (!fw) return '';
  if (fw.kind === 'bin') return kb(fw.size);
  const parts = [];
  if (fw.flash && fw.flash.length){
    const lo = Math.min(...fw.flash.map(s => s.start));
    const hi = Math.max(...fw.flash.map(s => s.start + s.data.length));
    parts.push(t('flashInfo', {
      kb: (fw.flash.reduce((a, s) => a + s.data.length, 0) / 1024).toFixed(1),
      pages: fw.pages.length, range: hex(lo) + '–' + hex(hi),
    }));
  }
  if (fw.uicr && fw.uicr.length){
    parts.push(t('uicrInfo', { words: fw.uicr.reduce((a, s) => a + s.words.length, 0) }));
  }
  return parts.join('\n');
}

function renderFirmware(){
  const manual = !!state.manualFw;
  $('fileInfo').classList.toggle('hidden', !manual);
  const badge = $('fwStatus');
  badge.classList.remove('ok');

  $('manualNeeds').textContent = t(M().needs === 'bin' ? 'needBin' : 'needHex');
  $('fileInput').setAttribute('accept', M().accept);

  if (manual){
    $('fwLine').textContent = t('fwManualOn');
    $('fileName').textContent = state.manualFw.name;
    $('fileRanges').textContent = fwRangeText(state.manualFw);
    badge.textContent = t('srcManual');
    return;
  }
  if (state.manifest){
    $('fwLine').textContent = t('fwLatest', {
      v: state.manifest.version, date: state.manifest.date || '',
    });
    badge.textContent = state.manifest.version;
    badge.classList.add('ok');
  } else {
    $('fwLine').textContent = t('fwLoading');
    badge.textContent = '…';
  }
}

/* Which steps are reachable right now. */
function connected(){
  return state.method === 'swd' ? !!state.tr
       : state.method === 'ota' ? !!state.dongle
       : !!state.port;
}
function readyToStart(){
  if (!connected()) return false;
  if (!state.manifest && !state.manualFw) return false;
  if (state.method === 'ota' && !state.selected.size) return false;
  if (state.method === 'dfu' && !state.inRecovery) return false;
  return true;
}
function gate(){
  $('card2').classList.toggle('disabled', state.busy);
  $('card3').classList.toggle('disabled', !connected() || state.busy);
  $('card4').classList.toggle('disabled', !connected() || state.busy);
  $('btnStart').disabled = !readyToStart() || state.busy;

  /* Holding the button down is an SWD-only requirement: it is what keeps the
   * tracker powered while the probe drives it. Wireless and wired updates go
   * through the running firmware, so the tracker powers itself and there is
   * nothing to hold. Saying otherwise on those two tabs tells the customer to
   * do something pointless - and worse, implies the update needs physical
   * access, which is exactly what the wireless path avoids.
   *
   * The button label is set here rather than with data-i18n because it varies
   * by method; applyLang() runs before refresh() on a language change, so this
   * still ends up in the right language. */
  const swd = state.method === 'swd';
  $('btnStart').textContent = t(swd ? 'start' : 'startPlain');
  $('holdBox').classList.toggle('hidden', !swd);
  $('holdRemind').classList.toggle('hidden', !swd);
}

function showView(v){
  $('preUpdate').classList.toggle('hidden', v !== 'pre');
  $('progressArea').classList.toggle('hidden', v !== 'progress');
  $('resultOk').classList.toggle('hidden', v !== 'ok');
  $('resultBad').classList.toggle('hidden', v !== 'bad');
}

function refresh(){
  renderMethods(); renderConnect(); renderFirmware();
  if (state.method === 'ota') renderTrackers();
  gate();
}

/* ========================= method switching ========================== */

async function selectMethod(id){
  if (state.busy || id === state.method) return;
  state.method = id;
  try { localStorage.setItem('method', id); } catch (_) {}
  /* Connections do not carry across methods - a CMSIS-DAP probe is not a
   * dongle - so drop whatever is open rather than leaving a stale handle that
   * looks connected in the UI. */
  await dropConnections();
  state.manualFw = null;
  showView('pre');
  refresh();
}

async function dropConnections(){
  if (state.dongle){ await state.dongle.close().catch(() => {}); state.dongle = null; state.ota = null; }
  if (state.smp){ await state.smp.close().catch(() => {}); state.smp = null; }
  state.port = null;
  if (state.tr){ try { await state.tr.close(); } catch (_) {} state.tr = null; state.dap = null; }
  state.trackers.clear(); state.selected.clear(); state.inRecovery = false;
  /* Whatever identified itself is gone, so the banner saying so has to go too. */
  $('devDetected').classList.add('hidden');
  $('connErr').classList.add('hidden');
}

/* ========================== manifest loading ========================= */

/* `detected` means a real device told us what it is - a probe or dongle whose
 * USB product name matched the registry. It is not the same as knowing which
 * manifest to fetch: with one product registered we can fetch that up front so
 * step 3 is answered before anything is plugged in. Announcing "device
 * detected" for that case claims something that has not happened, and the
 * banner then sits there whether or not anything is connected. */
async function loadManifestFor(dev, { detected = false } = {}){
  state.device = dev;
  $('fwErr').classList.add('hidden');
  $('devDetected').classList.toggle('hidden', !(dev && detected));
  if (!dev){ state.manifest = null; renderFirmware(); return; }
  if (detected) $('devDetected').textContent = t('autoDetected', { name: reg.devName(dev) });
  try {
    state.manifest = await reg.loadManifest(dev);
    log(`manifest: ${state.manifest.version} (code ${state.manifest.versionCode})`);
  } catch (e){
    state.manifest = null;
    $('fwErr').textContent = errText(e);
    $('fwErr').classList.remove('hidden');
    log('manifest load failed: ' + errText(e), 'err');
  }
  renderFirmware(); gate();
}

/* Resolve the image to send, honouring a manual override. */
async function resolveImage(){
  if (state.manualFw) return state.manualFw;
  if (!state.manifest) throw mkErr('fwLoadFailed', { err: 'no manifest' });
  const got = await reg.fetchImage(state.manifest, M().needs);
  return M().needs === 'bin'
    ? parseUpdateBin(got.bytes, got.name)
    : buildHexFw(got.text, got.name);
}

function buildHexFw(text, name){
  const segs = parseIntelHex(text);
  const { flash, uicr } = classifySegments(segs);
  const pages = new Set();
  for (const s of flash){
    const first = Math.floor(s.start / CONFIG.pageSize) * CONFIG.pageSize;
    const last = Math.floor((s.start + s.data.length - 1) / CONFIG.pageSize) * CONFIG.pageSize;
    for (let a = first; a <= last; a += CONFIG.pageSize) pages.add(a);
  }
  return {
    kind: 'hex', name, flash, uicr,
    pages: [...pages].sort((a, b) => a - b),
    versionCode: state.manifest ? state.manifest.versionCode : undefined,
  };
}

/* ========================= connect: SWD ============================== */

async function attachProbe(tr){
  await tr.open();
  state.tr = tr;
  state.dap = new DAP(tr);
  state.probeName = tr.name;
  log('probe: ' + tr.name + ' (' + tr.kind + ')');
  const dev = reg.matchProbe(tr.name);
  if (dev) await loadManifestFor(dev, { detected: true });
  refresh();
}

async function connectUsb(){
  if (!navigator.usb) return connFail(mkErr('errNoWebUsb'));
  try {
    const dev = await navigator.usb.requestDevice({ filters: reg.usbFilters() });
    await attachProbe(new WebUSBTransport(dev));
  } catch (e){ if (!isCancel(e)) connFail(e); }
}

async function connectProbeHid(){
  if (!navigator.hid) return connFail(mkErr('errNoWebHid'));
  try {
    const devs = await navigator.hid.requestDevice({ filters: [] });
    if (!devs.length) return;
    await attachProbe(new WebHIDTransport(devs[0]));
  } catch (e){ if (!isCancel(e)) connFail(e); }
}

/* ======================= connect: wireless =========================== */

async function connectDongle(){
  if (!navigator.hid) return connFail(mkErr('errNoWebHid'));
  let devs;
  try {
    devs = await navigator.hid.requestDevice({ filters: reg.hidFilters() });
  } catch (e){ return isCancel(e) ? undefined : connFail(e); }
  if (!devs.length) return;

  const dev = devs[0];
  /* The picker cannot filter on the product string, so this is the first
   * chance to notice that the user selected somebody else's SlimeNRF receiver.
   * Refuse rather than proceed: that dongle is paired with trackers that are
   * not ours, and BEGIN would be aimed at them. */
  const match = reg.matchDongle(dev.productName);
  if (!match){
    return connFail(mkErr('errNotOurDongle', { name: dev.productName || '?' }));
  }

  try {
    const d = new Dongle(dev);
    await d.open();
    state.dongle = d;
    state.ota = new OtaClient(d);
    log('dongle: ' + d.name);
    await loadManifestFor(match, { detected: true });
    refresh();
    await scanTrackers();
  } catch (e){ connFail(e); }
}

async function scanTrackers(){
  if (!state.ota) return;
  state.busy = true;
  $('otaNote').classList.remove('hidden');
  $('otaNote').textContent = t('otaScanning');
  gate();
  try {
    const found = await state.ota.discoverTrackers(1800);
    state.trackers = new Map([...found].map(([id, v]) => [id, { ...v, info: null, querying: v.online }]));
    state.selected.clear();
    renderConnect(); renderTrackers();

    if (!state.trackers.size){
      $('otaNote').textContent = t('otaNoTrackers');
      return;
    }
    $('otaNote').classList.add('hidden');

    /* Ask each awake tracker what it is running. This is what makes automatic
     * selection possible: the version comes from the tracker, not a guess. */
    const outdated = [];
    for (const [id, tk] of state.trackers){
      if (!tk.online) continue;
      try { tk.info = await state.ota.queryInfo(id, 4000); }
      catch (_) { tk.info = null; }
      tk.querying = false;
      const want = state.manifest && state.manifest.boardTarget;
      if (tk.info && (!want || tk.info.boardTarget === want) &&
          state.manifest && tk.info.versionCode < state.manifest.versionCode){
        outdated.push(id);
      }
      renderTrackers();
    }

    /* Tick everything that is out of date. Updates run one tracker at a time,
     * so there is no batch size to keep under - selecting six simply means six
     * consecutive updates. */
    state.selected.clear();
    for (const id of outdated) state.selected.add(id);
    renderTrackers();

    if (!state.trackers.size) $('otaNote').textContent = t('otaNoTrackers');
  } finally {
    state.busy = false;
    gate();
  }
}

/* ========================= connect: wired ============================ */

async function connectSerial(){
  if (!navigator.serial) return connFail(mkErr('errNoWebSerial'));
  try {
    const port = await navigator.serial.requestPort();
    state.port = port;
    state.smp = null;
    state.inRecovery = false;
    log('serial port selected');
    if (!state.device) await loadManifestFor(reg.devices()[0] || null);
    refresh();
  } catch (e){ if (!isCancel(e)) connFail(e); }
}

async function doEnterRecovery(){
  if (!state.port) return connFail(mkErr('errDfuNoPort'));
  state.busy = true; gate();
  $('btnEnterDfu').disabled = true;
  try {
    if (state.smp){ try { await state.smp.close(); } catch (_) {} state.smp = null; }

    const smp = await enterRecovery(state.port, { baudRate: DFU_BAUD });
    if (!smp){ state.inRecovery = false; connFail(mkErr('errDfuNoResponse')); return; }

    state.smp = smp;
    state.inRecovery = true;
    $('connErr').classList.add('hidden');
  } finally {
    $('btnEnterDfu').disabled = false;
    state.busy = false;
    refresh();
  }
}

/* ============================= errors ================================ */

function isCancel(e){
  return e && (e.name === 'NotFoundError' || /No device selected|cancell?ed/i.test(String(e.message || '')));
}
function connFail(e){
  const msg = errText(e);
  $('connErr').textContent = msg;
  $('connErr').classList.remove('hidden');
  log('connect failed: ' + msg, 'err');
  refresh();
}

/* ============================ the update ============================= */

async function start(){
  if (!readyToStart() || state.busy) return;
  state.busy = true;
  gate();
  showView('progress');
  setBar(0);
  $('errDetail').textContent = '';
  renderTrackerProgress(null);

  try {
    const fw = await resolveImage();
    if (state.method === 'ota') await runOta(fw);
    else if (state.method === 'dfu') await runDfu(fw);
    else await runSwd(fw);
  } catch (e){
    log('update failed: ' + errText(e), 'err');
    /* The SWD failure advice is about the button and re-plugging USB, which
     * only makes sense for SWD. */
    $('badHint').textContent = t(state.method === 'swd' ? 'failHint' : 'failHintPlain');
    $('errDetail').textContent = errText(e);
    showView('bad');
  } finally {
    state.busy = false;
    gate();
  }
}

async function runOta(fw){
  const ids = [...state.selected].sort((a, b) => a - b);
  const board = (state.manifest && state.manifest.boardTarget) || '';
  makePhases(true);

  /* One tracker at a time. See OTA_SEQUENTIAL in config.js for why: the
   * dongle's ring is shared and paced by the slowest target, so parallel
   * updates degrade sharply rather than gracefully.
   *
   * Rows for the whole batch are kept here and merged with whatever the
   * current update reports, so finished and queued trackers stay on screen
   * instead of the list collapsing to one row at a time. */
  const batch = new Map(ids.map(id => [id, { id, pct: 0, state: 'queued' }]));
  const paint = () => renderTrackerProgress([...batch.values()]);
  paint();

  const ok = [], failed = [];

  for (let i = 0; i < ids.length; i++){
    const id = ids[i];
    const label = { i: i + 1, n: ids.length, id };
    batch.set(id, { id, pct: 0, state: 'sending' });

    const res = await state.ota.update([id], fw, board, ev => {
      if (ev.per && ev.per.length){
        const r = ev.per.find(x => x.id === id);
        if (r) batch.set(id, { ...r, id });
      }
      if (ev.stage === 'begin'){
        setStage('otaStageBegin');
        setDetail(ids.length > 1 ? t('otaBatch', label) : '');
      } else if (ev.stage === 'data'){
        setStage('otaStageData');
        setDetail(ids.length > 1
          ? t('otaBatch', label) + ' · ' + t('otaProgress', { done: kb(ev.bytes), total: kb(ev.size), speed: ev.speed.toFixed(1) })
          : t('otaProgress', { done: kb(ev.bytes), total: kb(ev.size), speed: ev.speed.toFixed(1) }));
      } else if (ev.stage === 'verify'){
        setStage('otaStageVerify');
      } else if (ev.stage === 'activate'){
        setStage('otaStageActivate');
      }
      /* The shared bar spans the whole batch: whole trackers already done,
       * plus how far the current one has got. */
      const within = ev.stage === 'data' && ev.total ? ev.done / ev.total
                   : ev.stage === 'verify' ? 0.95
                   : ev.stage === 'activate' || ev.stage === 'done' ? 1
                   : 0;
      setBar((i + within) / ids.length);
      paint();
    });

    if (res.ok.length){
      ok.push(id);
      batch.set(id, { id, pct: 1, state: 'complete' });
    } else {
      const e = res.failed.length ? res.failed[0].error : mkErr('errOtaNoReady');
      failed.push({ id, error: e });
      batch.set(id, { id, pct: 0, state: 'failed', error: e });
    }
    paint();
  }

  setBar(1);
  if (!ok.length) throw (failed.length ? failed[0].error : mkErr('errOtaNoReady'));

  $('okTitle').textContent = t('success');
  $('okHint').textContent = failed.length
    ? t('otaPartial', { ok: ok.length, fail: failed.length })
    : ids.length > 1 ? t('otaAllDone', { n: ok.length }) : t('otaOkHint');
  showView('ok');
  /* Versions on screen are now stale - the trackers rebooted into new
   * firmware. Re-reading them avoids showing "update available" for something
   * just updated. */
  setTimeout(() => { scanTrackers().catch(() => {}); }, 3000);
}

async function runDfu(fw){
  makePhases(false);
  setStage('dfuStageUpload');
  const bytes = fw.kind === 'bin' ? fw.data : null;
  if (!bytes) throw mkErr('errWrongFormat', { want: '.update.bin' });

  await uploadImage(state.smp, bytes, {
    onProgress: p => {
      setDetail(t('otaProgress', {
        done: kb(p.off), total: kb(p.size), speed: p.speed.toFixed(1),
      }));
      phase('program', p.off / p.size);
    },
  });
  setStage('dfuStageConfirm'); phase('reset', 1);
  state.inRecovery = false;
  $('okTitle').textContent = t('success');
  $('okHint').textContent = t('dfuOkHint');
  showView('ok');
}

async function runSwd(fw){
  const r = await flashViaSwd(state.dap, fw, {
    verify: $('optVerify').checked,
    eraseMode: $('optErase').value,
    force: $('optForce').checked,
    clockHz: parseInt($('optClock').value, 10) || CONFIG.defaultSwdClockHz,
    device: state.device,
    auto: !state.manualFw,
  }, { setStage, phase, makePhases });

  if (r.result === 'uptodate'){
    $('okTitle').textContent = t('upToDateTitle');
    $('okHint').textContent = t('upToDateHint', { v: r.version });
  } else {
    setBar(1);
    $('okTitle').textContent = t('success');
    $('okHint').textContent = t('successHint');
  }
  showView('ok');
}

/* ========================== manual file ============================== */

async function loadManualFile(file){
  $('fwErr').classList.add('hidden');
  try {
    if (M().needs === 'bin'){
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!looksLikeUpdateBin(bytes)) throw mkErr('errWrongFormat', { want: '.update.bin' });
      state.manualFw = parseUpdateBin(bytes, file.name);
    } else {
      state.manualFw = buildHexFw(await file.text(), file.name);
    }
    log('manual firmware: ' + file.name);
  } catch (e){
    state.manualFw = null;
    $('fwErr').textContent = errText(e);
    $('fwErr').classList.remove('hidden');
  }
  renderFirmware(); gate();
}

/* ============================== init ================================= */

function checkSupport(){
  const missing = [];
  if (!navigator.hid) missing.push('WebHID');
  if (!navigator.usb) missing.push('WebUSB');
  if (!navigator.serial) missing.push('Web Serial');
  if (missing.length === 3){
    $('unsupported').textContent = t('unsupported');
    $('unsupported').classList.remove('hidden');
  }
}

async function init(){
  bindLog($('log'));

  const l = detectLang();
  $('langSel').value = l;
  applyLang(l);

  try {
    const saved = localStorage.getItem('method');
    if (saved && METHODS[saved]) state.method = saved;
  } catch (_) {}

  await reg.loadRegistry();
  /* With a single product registered - the normal case - the manifest can be
   * fetched before anything is plugged in, so step 3 is already answered by
   * the time the user gets there. */
  if (reg.devices().length === 1) await loadManifestFor(reg.devices()[0]);

  $('langSel').onchange = e => { applyLang(e.target.value); refresh(); };

  $('btnConnect').onclick = connectUsb;
  $('btnConnectHid').onclick = connectProbeHid;
  $('btnConnectDongle').onclick = connectDongle;
  $('btnRescan').onclick = () => scanTrackers().catch(e => connFail(e));
  $('btnConnectSerial').onclick = connectSerial;
  $('btnEnterDfu').onclick = doEnterRecovery;

  $('btnSelectAll').onclick = () => {
    const eligible = [...state.trackers].filter(([, tk]) => tk.online && tk.info).map(([id]) => id);
    const all = eligible.every(id => state.selected.has(id));
    state.selected = new Set(all ? [] : eligible);
    renderTrackers(); gate();
  };

  $('btnStart').onclick = start;
  $('btnRetry').onclick = () => { showView('pre'); gate(); };
  $('btnAgain').onclick = () => { showView('pre'); gate(); };
  $('btnUseAuto').onclick = () => { state.manualFw = null; renderFirmware(); gate(); };

  $('drop').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { if (e.target.files[0]) loadManualFile(e.target.files[0]); };
  for (const ev of ['dragenter', 'dragover']){
    $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']){
    $('drop').addEventListener(ev, e => { e.preventDefault(); $('drop').classList.remove('over'); });
  }
  $('drop').addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadManualFile(f);
  });

  $('btnLogClear').onclick = clearLog;
  $('btnLogDl').onclick = () => {
    const blob = new Blob([logLines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'update-log.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (navigator.hid){
    navigator.hid.addEventListener('disconnect', e => {
      if (state.dongle && state.dongle.device === e.device){
        state.dongle = null; state.ota = null;
        state.trackers.clear(); state.selected.clear();
        $('devDetected').classList.add('hidden');
        log('dongle disconnected', 'warn');
        refresh();
      }
    });
  }
  if (navigator.serial){
    navigator.serial.addEventListener('disconnect', () => {
      if (state.smp || state.port){ state.smp = null; state.port = null; state.inRecovery = false; log('serial disconnected', 'warn'); refresh(); }
    });
  }

  checkSupport();
  showView('pre');
  refresh();
}

init().catch(e => { log('init failed: ' + errText(e), 'err'); });
