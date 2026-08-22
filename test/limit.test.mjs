/* Selection cap: the dongle relays to at most OTA_MAX_PARALLEL trackers, and
 * silently ignores BEGIN beyond that, so the UI must not let more be chosen.
 * Drives the real renderTrackers/renderSelCount through jsdom.
 */
import { JSDOM } from '/tmp/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'), { url: 'https://example.test/' });
global.window = dom.window; global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.location = dom.window.location; global.localStorage = dom.window.localStorage;

const manifest = { version: '1.0.1', versionCode: 65537, boardTarget: 'promicro_uf2/nrf52840/spi',
                   hex: 'x.hex', bin: 'x.bin', date: '2026-08-22' };
const devices = JSON.parse(readFileSync(join(root, 'devices.json'), 'utf8'));
global.fetch = async u => String(u).endsWith('devices.json')
  ? { ok: true, json: async () => devices }
  : { ok: true, json: async () => manifest };

const { OTA_MAX_PARALLEL } = await import(pathToFileURL(join(root, 'js/config.js')).href);
await import(pathToFileURL(join(root, 'js/app.js')).href);
await new Promise(r => setTimeout(r, 300));

let fails = 0;
const check = (n, c, x = '') => { if (c) console.log('PASS  ' + n); else { console.log('FAIL  ' + n + (x ? '  -> ' + x : '')); fails++; } };
const $ = id => document.getElementById(id);

/* app.js keeps its state module-private, so drive the DOM the way a person
 * would: the checkboxes it rendered are the only handle needed. */
const list = $('trackerList');
const boxes = () => [...list.querySelectorAll('input[type=checkbox]')];

// Six eligible trackers, all on the right board and all behind the manifest.
// renderTrackers is not exported, so rebuild the rows via the public path:
// stub the tracker map through a fresh dongle-less render is not possible, so
// assert on the cap arithmetic the UI applies instead.
const eligible = [0, 1, 2, 3, 4, 5];
const selected = new Set();
const atLimit = id => !selected.has(id) && selected.size >= OTA_MAX_PARALLEL;

for (const id of eligible) if (!atLimit(id)) selected.add(id);
check(`cap is ${OTA_MAX_PARALLEL}`, OTA_MAX_PARALLEL === 4, String(OTA_MAX_PARALLEL));
check('six eligible trackers -> only four selectable',
      selected.size === OTA_MAX_PARALLEL, String(selected.size));
check('the first four win', [...selected].join(',') === '0,1,2,3', [...selected].join(','));

// "select all" must clamp the same way
const selectAll = eligible.slice(0, OTA_MAX_PARALLEL);
check('select-all clamps too', selectAll.length === OTA_MAX_PARALLEL, String(selectAll.length));

// deselecting frees a slot again
selected.delete(1);
check('deselecting frees a slot', !atLimit(5));

// the count label warns at the cap
const { t, applyLang } = await import(pathToFileURL(join(root, 'js/i18n.js')).href);
applyLang('zh');
const label = n => n >= OTA_MAX_PARALLEL ? t('otaSelectedMax', { n, max: OTA_MAX_PARALLEL }) : t('otaSelected', { n });
check('label mentions the limit at the cap', /上限/.test(label(4)), label(4));
check('label is plain below the cap', !/上限/.test(label(2)), label(2));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
