/* Diagnostics report: what support needs to know, as plain text.
 *
 * Versions, battery and signal for every device the dongle knows, plus the
 * page's own recent log. No names, no addresses beyond the radio address the
 * dongle already prints, nothing from outside this page. */
import { trackerState } from './telemetry.js';
import { logLines } from './util.js';

export function buildReport(ctx){
  /* ctx: { lang, dongle, dongleInfo, dongleManifest, manifest, trackers (Map id -> {info}) } */
  const L = [];
  const now = Date.now();
  L.push('NekoTora Manager - diagnostics');
  L.push('generated: ' + new Date(now).toISOString());
  L.push('page: ' + (typeof location !== 'undefined' ? location.href.split('#')[0] : '?'));
  L.push('browser: ' + (typeof navigator !== 'undefined' ? navigator.userAgent : '?'));
  L.push('language: ' + ctx.lang);
  L.push('');
  L.push('latest firmware: tracker ' + (ctx.manifest ? ctx.manifest.version : '?') +
         ', dongle ' + (ctx.dongleManifest ? ctx.dongleManifest.version : '?'));
  L.push('');
  if (!ctx.dongle){
    L.push('dongle: not connected');
  } else {
    const i = ctx.dongleInfo;
    L.push('dongle: ' + ctx.dongle.name + (i
      ? ` - ${i.version} (${i.bootloader}, ${i.boardTarget}, built ${i.buildDate})`
      : ' - no firmware info'));
    const st = ctx.dongle.status;
    if (st){
      L.push(`dongle status: channel ${st.channel}${st.explicit ? ' (set)' : ' (default)'}, ` +
             `${st.stored} stored, pairing ${st.pairing ? 'on' : 'off'}, ` +
             `${((now - st.at) / 1000).toFixed(1)} s ago`);
    } else if (ctx.dongle.statusSupported === false){
      L.push('dongle status: not supported by this firmware');
    }
    L.push('');
    L.push('trackers:');
    const ids = [...ctx.dongle.seen.keys()].sort((a, b) => a - b);
    if (!ids.length) L.push('  (none)');
    for (const id of ids){
      const e = ctx.dongle.seen.get(id);
      const state = trackerState(ctx.dongle, id, now);
      const info = ctx.trackers && ctx.trackers.get(id) && ctx.trackers.get(id).info;
      const parts = [
        `#${id}`,
        e.addr || '-',
        { awake: 'awake', standby: 'standby (doze)', off: 'off or out of range', asleep: 'standby-or-off' }[state],
      ];
      if (info) parts.push(`fw ${info.version} (${info.bootloader}, ${info.boardTarget})`);
      else if (e.fw) parts.push(`fw ${e.fw}`);
      if (e.battery && e.battery.present){
        parts.push(`battery ${e.battery.pct}%` + (e.battery.mV ? ` ${e.battery.mV} mV` : '') +
                   (e.battery.charging ? ' charging' : ''));
      } else if (e.battery){
        parts.push('no battery');
      }
      if (e.rssi !== undefined) parts.push(`rssi ${e.rssi} dBm`);
      if (e.lastSeen) parts.push(`last data ${((now - e.lastSeen) / 1000).toFixed(1)} s ago`);
      L.push('  ' + parts.join(' | '));
    }
  }
  L.push('');
  L.push('recent log:');
  for (const line of logLines.slice(-120)) L.push('  ' + line);
  return L.join('\n');
}
