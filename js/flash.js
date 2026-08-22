/* SWD update flow.
 *
 * Moved out of index.html unchanged in substance; the UI globals it used to
 * reach for (checkbox states, the shared `state` object) are now parameters, so
 * this can be exercised without a DOM. Behaviour is deliberately identical -
 * this is the recovery path of last resort, and it is the only one that can
 * write a bootloader back onto a tracker that has lost one.
 */
import { CONFIG } from './config.js';
import { mkErr, hex, log, verStr } from './util.js';
import { t, errText } from './i18n.js';
import { Target, NRF, pollNvmcReady } from './swd.js';

export async function flashViaSwd(dap, fwsel, opts, ui){
  const { verify = true, eraseMode = 'smart', force = false,
          clockHz = CONFIG.defaultSwdClockHz, device = null, auto = false } = opts || {};
  const { setStage, phase, makePhases } = ui;
  makePhases(verify);
  const { flash, uicr, pages } = fwsel;
  const tgt = new Target(dap);

  setStage('stageConnect'); phase('connect', 0.1);
  await dap.init(clockHz);
  await tgt.dpInit();
  phase('connect', 0.6);

  // identify chip; a FAULT here usually means APPROTECT is enabled
  try {
    await tgt.memInit();
    await tgt.write32(NRF.DHCSR, 0xA05F0003);            // halt the core
    const dhcsr = await tgt.read32(NRF.DHCSR);
    log('Core halted (DHCSR=' + hex(dhcsr) + ')');
    const part = await tgt.read32(NRF.FICR_PART);
    const variant = await tgt.read32(NRF.FICR_VARIANT);
    const id0 = await tgt.read32(NRF.FICR_DEVICEID0);
    const id1 = await tgt.read32(NRF.FICR_DEVICEID1);
    log('Chip: PART=' + hex(part) + ' VARIANT=' + hex(variant) +
        ' DEVICEID=' + hex(id1) + hex(id0).slice(2));
    if (part !== CONFIG.expectedPart){
      log(t('warnPartMismatch', {part: hex(part)}), 'warn');
      if (CONFIG.blockIfPartMismatch) throw mkErr('errPart');
    }
  } catch (e){
    if (e.i18nKey === 'errSwdFail') throw mkErr('errProtected');
    throw e;
  }
  phase('connect', 1);

  // ---- optional current-version check (auto mode only) ----
  if (auto && device && device.versionAddr &&
      fwsel.versionCode !== undefined){
    try {
      const cur = await tgt.read32(device.versionAddr >>> 0);
      log(t('curVersion', {v: verStr(cur) + ' (' + hex(cur) + ')'}));
      if (cur === fwsel.versionCode && !force){
        try { await tgt.write32(NRF.DHCSR, 0xA05F0000); } catch (e){}   // resume core
        await dap.disconnect();
        return { result: 'uptodate', version: verStr(cur) };
      }
    } catch (e){ log('Version read failed (continuing with update): ' + errText(e), 'warn'); }
  }

  // ---- erase ----
  setStage('stageErase');
  if (eraseMode === 'none'){
    log('Erase skipped (advanced option)', 'warn');
    phase('erase', 1);
  } else if (eraseMode === 'full'){
    log('ERASEALL (full chip erase incl. UICR)');
    await tgt.write32(NRF.NVMC_CONFIG, 2);
    await tgt.write32(NRF.NVMC_ERASEALL, 1);
    await pollNvmcReady(tgt, 15000);
    await tgt.write32(NRF.NVMC_CONFIG, 0);
    phase('erase', 1);
  } else {
    log('Erasing ' + pages.length + ' page(s)');
    await tgt.write32(NRF.NVMC_CONFIG, 2);
    for (let i = 0; i < pages.length; i++){
      await tgt.write32(NRF.NVMC_ERASEPAGE, pages[i]);
      await pollNvmcReady(tgt, 3000);
      phase('erase', (i + 1) / pages.length);
    }
    await tgt.write32(NRF.NVMC_CONFIG, 0);
    if (uicr.length){
      // erase UICR only if the new words cannot be written over the current ones
      let needErase = false;
      for (const s of uicr){
        const cur = await tgt.readBlock(s.start, s.words.length);
        for (let i = 0; i < s.words.length; i++){
          if (((cur[i] & s.words[i]) >>> 0) !== s.words[i]){ needErase = true; break; }
        }
        if (needErase) break;
      }
      if (needErase){
        log('Erasing UICR');
        await tgt.write32(NRF.NVMC_CONFIG, 2);
        await tgt.write32(NRF.NVMC_ERASEUICR, 1);
        await pollNvmcReady(tgt, 3000);
        await tgt.write32(NRF.NVMC_CONFIG, 0);
      } else log('UICR erase not needed');
    }
  }

  // ---- program ----
  setStage('stageProgram');
  const all = flash.concat(uicr);
  const totalWords = all.reduce((a, s) => a + s.words.length, 0);
  let done = 0;
  log('Programming ' + totalWords * 4 + ' bytes');
  await tgt.write32(NRF.NVMC_CONFIG, 1);                 // write enable
  for (const s of all){
    await tgt.writeBlock(s.start, s.words, i => phase('program', (done + i) / totalWords));
    done += s.words.length;
    await pollNvmcReady(tgt, 3000);
  }
  await tgt.write32(NRF.NVMC_CONFIG, 0);

  // ---- verify ----
  if (verify){
    setStage('stageVerify');
    let vdone = 0;
    for (const s of all){
      const rb = await tgt.readBlock(s.start, s.words.length,
        i => phase('verify', (vdone + i) / totalWords));
      for (let i = 0; i < s.words.length; i++){
        if (rb[i] !== s.words[i]){
          throw mkErr('errVerify', {addr: hex(s.start + i * 4), exp: hex(s.words[i]), got: hex(rb[i])});
        }
      }
      vdone += s.words.length;
    }
    log('Verify OK');
  }

  // ---- reset & run ----
  setStage('stageReset'); phase('reset', 0.3);
  try { await tgt.write32(NRF.DHCSR, 0xA05F0000); } catch (e){}     // release core
  try { await tgt.write32(NRF.AIRCR, 0x05FA0004); } catch (e){}     // SYSRESETREQ
  await dap.disconnect();
  log('Device reset — update finished');
  phase('reset', 1);
  return { result: 'ok' };
}
