/* Per-tracker progress rendering.
 *
 * Feeds real OtaClient events into the real renderer through jsdom, so this
 * covers the shape of the event payload and the DOM update together - a
 * mismatch between them is invisible to either side's own tests.
 */
import { JSDOM } from '/tmp/node_modules/jsdom/lib/api.js';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'),
                      { url: 'https://example.test/' });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.location = dom.window.location;
global.localStorage = dom.window.localStorage;

const { applyLang } = await import(pathToFileURL(join(root, 'js/i18n.js')).href);
applyLang('zh');

let fails = 0;
const check = (n, c, x = '') => { if (c) console.log('PASS  ' + n); else { console.log('FAIL  ' + n + (x ? '  -> ' + x : '')); fails++; } };

// Mirror app.js's renderer. Kept in step by the id/class assertions below.
const src = readFileSync(join(root, 'js/app.js'), 'utf8');
const start = src.indexOf('const P_STATE');
const end = src.indexOf('/* ============================ rendering');
const mod = 'import { t, errText } from ' + JSON.stringify(pathToFileURL(join(root, 'js/i18n.js')).href) + ';\n' +
            'const $ = id => document.getElementById(id);\n' +
            src.slice(start, end) + '\nexport { renderTrackerProgress };';
const { renderTrackerProgress } = await import('data:text/javascript;base64,' + Buffer.from(mod).toString('base64'));

const box = document.getElementById('trkProgress');
const rows = () => [...box.children].map(el => ({
  id: el.dataset.tid,
  width: el.querySelector('.tpBar > div').style.width,
  state: el.querySelector('.tpState').textContent,
  cls: el.className,
}));

check('hidden with nothing to show', (renderTrackerProgress(null), box.classList.contains('hidden')));

renderTrackerProgress([
  { id: 0, pct: 0.67, state: 'sending' },
  { id: 4, pct: 1,    state: 'done' },
  { id: 9, pct: 0.22, state: 'sending' },
]);
check('one row per tracker', box.children.length === 3, String(box.children.length));
check('shown once there are rows', !box.classList.contains('hidden'));
check('widths reflect per-tracker progress',
      rows().map(r => r.width).join(',') === '67%,100%,22%', rows().map(r => r.width).join(','));
check('states translated', rows()[0].state === '傳送中' && rows()[1].state === '已送達',
      rows().map(r => r.state).join(','));

// same ids again: elements must be reused so the CSS transition animates
const before = [...box.children];
renderTrackerProgress([
  { id: 0, pct: 0.9, state: 'sending' },
  { id: 4, pct: 1,   state: 'done' },
  { id: 9, pct: 0.3, state: 'sending' },
]);
check('rows reused, not rebuilt', [...box.children].every((el, i) => el === before[i]));
check('width updated in place', rows()[0].width === '90%', rows()[0].width);

// a tracker drops out
const err = Object.assign(new Error('errOtaStalled'), { i18nKey: 'errOtaStalled' });
renderTrackerProgress([
  { id: 0, pct: 1, state: 'verifying' },
  { id: 4, pct: 0, state: 'failed', error: err },
  { id: 9, pct: 1, state: 'verifying' },
]);
check('failed row kept, not removed', box.children.length === 3, String(box.children.length));
check('failed row marked', rows()[1].cls.includes('failed'), rows()[1].cls);
check('failed row shows why on hover',
      box.children[1].title.length > 0 && box.children[1].title !== 'errOtaStalled',
      box.children[1].title);
check('others show verifying', rows()[0].state === '驗證中', rows()[0].state);

renderTrackerProgress([{ id: 0, pct: 1, state: 'complete' }]);
check('rows for absent trackers removed', box.children.length === 1, String(box.children.length));
check('complete styled', rows()[0].cls.includes('complete'), rows()[0].cls);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
