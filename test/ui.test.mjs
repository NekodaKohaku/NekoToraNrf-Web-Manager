/* Headless smoke test: loads index.html in jsdom, runs app.js for real, and
 * checks the pieces a customer actually touches. Catches the class of mistake
 * that only shows up in a browser - a missing element, a key that renders as
 * its own name, a handler wired to nothing. */
import { JSDOM } from '/tmp/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;

// Minimal browser surface app.js reaches for. No transports are provided, so
// the connect buttons are exercised only up to the capability check.
global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
global.location = window.location;
global.localStorage = window.localStorage;
global.Blob = window.Blob;
global.URL = window.URL;
global.HTMLElement = window.HTMLElement;

const manifest = {
  version: '1.4.2', versionCode: 0x010402,
  boardTarget: 'promicro_uf2/nrf52840/spi',
  hex: 'nekotora-1.4.2.hex', bin: 'nekotora-1.4.2.update.bin', date: '2026-08-20',
};
const devices = JSON.parse(readFileSync(join(root, 'devices.json'), 'utf8'));
global.fetch = async (u) => {
  const s = String(u);
  if (s.endsWith('devices.json')) return { ok: true, json: async () => devices };
  if (s.endsWith('latest.json')) return { ok: true, json: async () => manifest };
  return { ok: false, status: 404 };
};

let fails = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('PASS  ' + name);
  else { console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); fails++; }
};

await import(pathToFileURL(join(root, 'js/app.js')).href);
await new Promise(r => setTimeout(r, 300));

const $ = id => window.document.getElementById(id);
const txt = id => ($(id) ? $(id).textContent.trim() : null);

// --- structure ---
check('three method tabs rendered', $('methods').children.length === 3,
      $('methods').children.length + ' children');
const names = [...$('methods').children].map(b => b.querySelector('.mName span').textContent);
check('wireless offered first', names[0] && /無線|Wireless|ワイヤレス/.test(names[0]), names.join(' | '));
check('exactly one tab selected',
      [...$('methods').children].filter(b => b.getAttribute('aria-selected') === 'true').length === 1);

// --- i18n actually resolved (no key names leaking to screen) ---
const leaked = [...window.document.querySelectorAll('[data-i18n]')]
  .filter(el => el.textContent.trim() === el.dataset.i18n)
  .map(el => el.dataset.i18n);
check('no untranslated keys on screen', leaked.length === 0, leaked.join(', '));

// --- manifest loaded without any device connected ---
check('manifest fetched up front', txt('fwStatus') === '1.4.2', txt('fwStatus'));
check('version line shows date', /1\.4\.2/.test(txt('fwLine')) && /2026-08-20/.test(txt('fwLine')), txt('fwLine'));

// --- gating: nothing connected, so update must be unreachable ---
check('start disabled before connecting', $('btnStart').disabled === true);
check('firmware step gated', $('card3').classList.contains('disabled'));
check('update step gated', $('card4').classList.contains('disabled'));

// --- method switching swaps the connect pane and the required file format ---
const panes = () => ['paneOta', 'paneDfu', 'paneSwd'].filter(p => !$(p).classList.contains('hidden'));
check('one connect pane visible', panes().length === 1, panes().join(','));
check('wireless pane is the default', panes()[0] === 'paneOta', panes()[0]);
check('wireless wants .update.bin', $('fileInput').getAttribute('accept') === '.bin',
      $('fileInput').getAttribute('accept'));
check('SWD options hidden for wireless', $('swdOpts').classList.contains('hidden'));
check('hold-button warning hidden for wireless', $('holdBox').classList.contains('hidden'));

[...$('methods').children][2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 120));
check('clicking SWD swaps pane', panes()[0] === 'paneSwd', panes().join(','));
check('SWD wants .hex', $('fileInput').getAttribute('accept') === '.hex,.ihex',
      $('fileInput').getAttribute('accept'));
check('SWD options shown', !$('swdOpts').classList.contains('hidden'));
check('hold-button warning shown for SWD', !$('holdBox').classList.contains('hidden'));
check('method choice persisted', window.localStorage.getItem('method') === 'swd');

// --- language switching rewrites everything, including the tabs ---
// jsdom reports navigator.language as en-US, so the page starts in English;
// switch away from it first or the assertion is vacuous.
$('langSel').value = 'zh';
$('langSel').dispatchEvent(new window.Event('change'));
await new Promise(r => setTimeout(r, 120));
check('Chinese tabs read correctly', /無線/.test(txt('methods')), txt('methods').slice(0, 40));
const before = txt('methods');
$('langSel').value = 'en';
$('langSel').dispatchEvent(new window.Event('change'));
await new Promise(r => setTimeout(r, 120));
check('switching language changes tab text', txt('methods') !== before);
check('English tabs read correctly', /Wireless/.test(txt('methods')), txt('methods').slice(0, 60));
const leaked2 = [...window.document.querySelectorAll('[data-i18n]')]
  .filter(el => el.textContent.trim() === el.dataset.i18n).map(el => el.dataset.i18n);
check('no untranslated keys after switch', leaked2.length === 0, leaked2.join(', '));

$('langSel').value = 'ja';
$('langSel').dispatchEvent(new window.Event('change'));
await new Promise(r => setTimeout(r, 120));
check('Japanese tabs read correctly', /ワイヤレス/.test(txt('methods')), txt('methods').slice(0, 40));

// --- "device detected" must mean a device actually identified itself --------
// It used to be printed by the manifest prefetch on page load, so it appeared
// with nothing plugged in and stayed there for the whole session.
const detectedVisible = () => !$('devDetected').classList.contains('hidden');
check('no "detected" banner before connecting', !detectedVisible(),
      'text was: ' + txt('devDetected'));
check('manifest still prefetched anyway', txt('fwStatus') === '1.4.2', txt('fwStatus'));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
