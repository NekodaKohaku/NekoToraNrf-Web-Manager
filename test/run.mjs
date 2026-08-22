/* Runs every test file and summarises. No dependencies beyond jsdom, which
 * only test/ui.test.mjs needs:  npm i jsdom
 * Usage:  node test/run.mjs
 */
import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort();
let bad = 0;
for (const f of files){
  console.log('\n=== ' + f + ' ===');
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) bad++;
}
console.log(bad ? `\n${bad}/${files.length} file(s) failed` : `\nall ${files.length} test file(s) passed`);
process.exit(bad ? 1 : 0);
