/* cpuDiagnose against a fake core: halts, reads PC samples, resumes. */
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Target } = await import(pathToFileURL(join(root, 'js/swd.js')).href);
const { cpuDiagnose } = await import(pathToFileURL(join(root, 'js/swddiag.js')).href);

let fails = 0;
const check = (n, c, x = '') => { if (c) console.log('PASS  ' + n); else { console.log('FAIL  ' + n + (x ? '  -> ' + x : '')); fails++; } };

const mem = new Map([[0x10000100, 0x52840], [0x40000400, 0x4], [0xE000ED08, 0xC200]]);
let halted = false, regsel = 0, halts = 0, resumes = 0, rtc = 100;
const regs = { 15: 0x2F604, 14: 0x31A9D, 13: 0x20001000, 16: 0x61000000 };
Target.prototype.dpInit = async function(){};
Target.prototype.memInit = async function(){};
Target.prototype.write32 = async function(a, v){
  if (a === 0xE000EDF0){ if (v === 0xA05F0003){ halted = true; halts++; } else if (v === 0xA05F0001){ halted = false; resumes++; } }
  else if (a === 0xE000EDF4) regsel = v;
  else mem.set(a, v);
};
Target.prototype.read32 = async function(a){
  if (a === 0xE000EDF0) return (halted ? (1 << 17) : 0) | (1 << 16);
  if (a === 0xE000EDF8) return regs[regsel] >>> 0;
  if (a === 0x40011504) return (rtc += 33);
  return mem.get(a) || 0;
};
const dap = { init: async () => {}, disconnect: async () => {} };
const lines = await cpuDiagnose(dap, { samples: 3, gapMs: 1 });
check('reports the chip', lines.some(l => l.includes('PART=0x00052840')), lines[0]);
check('one line per sample with pc lr sp xpsr', lines.filter(l => l.startsWith('  0x0002F604 0x00031A9D 0x20001000')).length === 3, lines.join(' | '));
check('fault and clock registers read', lines.some(l => l.startsWith('CFSR=')) && lines.some(l => l.startsWith('LFCLKSTAT=')));
check('RTC progress reported', lines.some(l => /RTC1 advanced \d+ ticks/.test(l)));
check('core resumed after every halt', halts === resumes && !halted, `${halts} halts / ${resumes} resumes`);
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
process.exit(fails ? 1 : 0);
