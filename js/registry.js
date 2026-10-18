/* Device registry and firmware manifest.
 *
 * devices.json lets a new product be added without touching code. Both the
 * probe (SWD) and the dongle (wireless) are identified by USB product-name
 * prefix, which needs a word of explanation: WebUSB and WebHID filters can only
 * match vendor/product IDs, never strings. The IDs in play are shared -
 * 0x0D28/0x0204 is generic CMSIS-DAP, 0x1209/0x7690 is every SlimeNRF receiver
 * regardless of who made it - so the browser's picker will always list other
 * people's hardware too. Name matching therefore happens after the user picks,
 * and its job is to refuse politely rather than to filter the dialog.
 */
import { CONFIG, DEFAULT_DEVICES } from './config.js';
import { mkErr, log } from './util.js';
import { getLang } from './i18n.js';

let registry = DEFAULT_DEVICES;

export async function loadRegistry(){
  try {
    const r = await fetch(CONFIG.devicesUrl, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && Array.isArray(j.devices) && j.devices.length) registry = j;
    log(`registry: ${registry.devices.length} device(s)`);
  } catch (e){
    /* Falling back is deliberate: the page still works offline or when opened
     * from the filesystem, just with whatever was compiled in. */
    log('registry: using built-in defaults (' + e.message + ')', 'warn');
  }
  return registry;
}

export function devices(){ return registry.devices; }

export function devName(dev){
  if (!dev) return '';
  const n = dev.name;
  if (!n) return dev.id;
  return n[getLang()] || n.en || dev.id;
}

function matchByPrefix(productName, field){
  const p = (productName || '').toLowerCase();
  for (const d of registry.devices){
    for (const n of (d[field] || [])){
      if (p.startsWith(String(n).toLowerCase())) return d;
    }
  }
  return null;
}

/* Which product does this CMSIS-DAP probe belong to? */
export const matchProbe = name => matchByPrefix(name, 'probeNames');

/* Which product does this dongle belong to? Returns null for a SlimeNRF
 * receiver made by someone else, which is exactly the case worth catching:
 * it would relay happily and push NekoTora firmware at whatever trackers it is
 * paired with. */
export const matchDongle = name => matchByPrefix(name, 'dongleNames');

export function usbFilters(){
  const out = [];
  for (const d of registry.devices) for (const f of (d.usbFilters || [])) out.push(f);
  return out;
}

export function hidFilters(){
  const out = [];
  for (const d of registry.devices) for (const f of (d.dongleFilters || [])) out.push(f);
  return out;
}

/* ------------------------------ manifest -------------------------------- */

/* Resolve a manifest path against the page, so devices.json can use either a
 * relative path or an absolute URL on another host. */
function resolve(base, rel){ return new URL(rel, new URL(base, location.href)).href; }

export async function loadManifest(dev){
  if (!dev || !dev.manifest) throw mkErr('fwLoadFailed', { err: 'no manifest' });
  const url = resolve(location.href, dev.manifest);
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw mkErr('fwLoadFailed', { err: 'HTTP ' + r.status });
  const m = await r.json();
  m._base = url;
  return m;
}

/* Fetch the image a given method needs. 'hex' is text, 'bin' is binary; the
 * caller never chooses, the method does - see METHODS in config.js for why. */
export async function fetchImage(manifest, want){
  const file = manifest[want];
  if (!file) throw mkErr('fwLoadFailed', { err: 'manifest has no "' + want + '"' });
  const url = resolve(manifest._base, file);
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw mkErr('fwLoadFailed', { err: 'HTTP ' + r.status });
  return {
    name: file.split('/').pop(),
    bytes: want === 'bin' ? new Uint8Array(await r.arrayBuffer()) : null,
    text: want === 'hex' ? await r.text() : null,
  };
}

/* The manifest entry for a tracker's board target.
 *
 * The top level describes one build; "variants" may add others for the same
 * product, matched by board target - e.g. the A/B build, whose trackers
 * report "<board>+ab". A variant inherits everything it does not override
 * (version, date). null when nothing in the manifest fits the tracker. */
export function manifestFor(manifest, boardTarget){
  if (!manifest) return null;
  if (!manifest.boardTarget || manifest.boardTarget === boardTarget) return manifest;
  const v = (manifest.variants || []).find(x => x && x.boardTarget === boardTarget);
  if (!v) return null;
  const merged = { ...manifest, ...v };
  delete merged.variants;
  return merged;
}

export const isAbTracker = info => !!info && (info.bootloader === 'mcuboot-a' || info.bootloader === 'mcuboot-b');

/* Which manifest field holds the image a tracker needs: an A/B tracker
 * running from slot A takes the slot-B build ("binSlot1"); everything else
 * takes "bin". */
export const binKeyFor = info => (info && info.bootloader === 'mcuboot-a') ? 'binSlot1' : 'bin';

/* Why an image must not go to this tracker, or null. Only decides what the
 * page can know: slot layout comes from the manifest ("slotBase": [A, B]),
 * so without it the link check is left to the tracker, which repeats all of
 * this before anything is marked for boot.
 *   img   - updateBinInfo() of the file
 *   info  - the tracker's FW_INFO
 *   slots - [slotA, slotB] base addresses, or null */
export function imageProblem(img, info, slots){
  if (!img || !info) return null;
  if (slots && img.reset != null){
    const [a, b] = slots;
    const inB = img.reset >= b;
    const inA = img.reset >= a && img.reset < b;
    const needB = info.bootloader === 'mcuboot-a';
    if (needB ? !inB : !inA) return { key: 'errFwWrongSlot', slot: needB ? 'B' : 'A' };
  }
  if (isAbTracker(info) && img.versionCode < info.versionCode){
    return { key: 'errFwNotNewer', v: info.version };
  }
  return null;
}

/* The dongle's own firmware, when the product has one (devices.json
 * "dongleManifest"). Same manifest shape as a tracker's, with "hex" (the
 * app-only image the page writes over USB) and "uf2" (drag-and-drop recovery)
 * instead of "bin". A product without the field simply has no dongle row. */
export async function loadDongleManifest(dev){
  if (!dev || !dev.dongleManifest) return null;
  const url = resolve(location.href, dev.dongleManifest);
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw mkErr('fwLoadFailed', { err: 'HTTP ' + r.status });
  const m = await r.json();
  m._base = url;
  return m;
}

/* Absolute URL of a manifest-relative file, for download links. */
export function manifestFileUrl(manifest, file){
  return resolve(manifest._base, file);
}
