/* SWD diagnostics: where is a tracker that shows no sign of life?
 *
 * A board without a UART has no console to say why it is stuck, and its LED
 * and radio may never come up. The SWD probe can still look inside: halt the
 * core for a moment, read where it is and why it last reset, resume it, and
 * repeat. A dozen PC samples say whether it is spinning in one loop, sleeping,
 * stuck in a fault handler or rebooting - and, matched against the build's
 * ELF, in which function.
 *
 * Read-only apart from halting and resuming the core: nothing is written to
 * flash, and the tracker carries on afterwards exactly as before.
 */
import { CONFIG } from './config.js';
import { hex, sleep } from './util.js';
import { Target, NRF } from './swd.js';

const DCRSR = 0xE000EDF4;
const DCRDR = 0xE000EDF8;
const S_REGRDY = 1 << 16;
const S_HALT = 1 << 17;
const S_SLEEP = 1 << 18;
const S_LOCKUP = 1 << 19;
const S_RESET_ST = 1 << 25;

/* Registers read once, after sampling. Names are the nRF52840 / Cortex-M4
 * ones so a report can be read against the datasheet. */
const SNAP = [
  ['RESETREAS', 0x40000400],
  ['VTOR', 0xE000ED08],
  ['ICSR', 0xE000ED04],
  ['CFSR', 0xE000ED28],
  ['HFSR', 0xE000ED2C],
  ['MMFAR', 0xE000ED34],
  ['BFAR', 0xE000ED38],
  ['HFCLKSTAT', 0x4000040C],
  ['LFCLKSTAT', 0x40000418],
  ['LFCLKSRC', 0x40000518],
  ['RTC1.COUNTER', 0x40011504],
  ['RTC0.COUNTER', 0x4000B504],
  ['P0.OUT', 0x50000504],
  ['P1.OUT', 0x50000804],
  ['P0.IN', 0x50000510],
  ['P1.IN', 0x50000810],
  ['UICR.NFCPINS', 0x1000120C],
];

async function readCoreReg(tgt, n){
  await tgt.write32(DCRSR, n);
  for (let i = 0; i < 50; i++){
    if ((await tgt.read32(NRF.DHCSR)) & S_REGRDY) return tgt.read32(DCRDR);
  }
  throw new Error('core register ' + n + ' not ready');
}

async function haltAndRead(tgt){
  await tgt.write32(NRF.DHCSR, 0xA05F0003);              // C_DEBUGEN | C_HALT
  let dhcsr = 0;
  for (let i = 0; i < 50; i++){
    dhcsr = await tgt.read32(NRF.DHCSR);
    if (dhcsr & S_HALT) break;
  }
  return {
    dhcsr,
    pc: await readCoreReg(tgt, 15),
    lr: await readCoreReg(tgt, 14),
    sp: await readCoreReg(tgt, 13),
    xpsr: await readCoreReg(tgt, 16),
  };
}

async function resume(tgt){
  await tgt.write32(NRF.DHCSR, 0xA05F0001);              // C_DEBUGEN, not halted
}

/* Returns the report as text lines. `onLine` streams them as they come. */
export async function cpuDiagnose(dap, { samples = 12, gapMs = 150, clockHz = CONFIG.defaultSwdClockHz, onLine = () => {} } = {}){
  const out = [];
  const say = s => { out.push(s); onLine(s); };
  const tgt = new Target(dap);
  await dap.init(clockHz);
  await tgt.dpInit();
  await tgt.memInit();

  const part = await tgt.read32(NRF.FICR_PART);
  say(`chip PART=${hex(part)}`);
  /* RESETREAS before anything touches the core. */
  say(`RESETREAS=${hex(await tgt.read32(0x40000400))}`);
  const rtcA = await tgt.read32(0x40011504);

  say('samples: pc lr sp xpsr [flags]');
  for (let i = 0; i < samples; i++){
    const r = await haltAndRead(tgt);
    const f = [];
    if (r.dhcsr & S_SLEEP) f.push('sleep');
    if (r.dhcsr & S_LOCKUP) f.push('LOCKUP');
    if (r.dhcsr & S_RESET_ST) f.push('reset');
    const exc = r.xpsr & 0x1FF;
    if (exc) f.push('exc' + exc);
    say(`  ${hex(r.pc)} ${hex(r.lr)} ${hex(r.sp)} ${hex(r.xpsr)}${f.length ? ' [' + f.join(',') + ']' : ''}`);
    await resume(tgt);
    await sleep(gapMs);
  }

  await haltAndRead(tgt);
  for (const [name, addr] of SNAP){
    try { say(`${name}=${hex(await tgt.read32(addr))}`); }
    catch (e){ say(`${name}=? (${e.message || e})`); }
  }
  const rtcB = await tgt.read32(0x40011504);
  say(`RTC1 advanced ${((rtcB - rtcA) & 0xFFFFFF)} ticks during the run`);
  await resume(tgt);
  await dap.disconnect();
  return out;
}
