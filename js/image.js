/* Firmware image containers.
 *
 * Two shapes reach a tracker and they are not interchangeable:
 *
 *   .update.bin  MCUboot signed update image. Goes to slot 1; the bootloader
 *                validates the signature and swaps it in on the next boot.
 *                Used by wireless OTA and wired DFU.
 *   .hex         Full flash image including MCUboot itself, at absolute
 *                addresses. Only SWD can write it, and only SWD can put a
 *                bootloader back on a tracker that has lost one.
 *
 * Writing one where the other is expected bricks the unit - a .hex sent to
 * slot 1 fails signature validation and is discarded (recoverable), but a
 * headerless .bin written to 0x0 by SWD leaves no valid vector table (not
 * recoverable without SWD). Hence the magic check below, and hence the page
 * never letting the user pick the file by hand in the normal flow.
 */
import { mkErr, crc32 } from './util.js';
import { parseIntelHex } from './hex.js';

/* MCUboot image header magic, little-endian at offset 0. */
export const MCUBOOT_IMAGE_MAGIC = 0x96F3B83D;

export function looksLikeUpdateBin(bytes){
  if (!bytes || bytes.length < 32) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 4);
  return dv.getUint32(0, true) === MCUBOOT_IMAGE_MAGIC;
}

/* Parse a .update.bin into the form the OTA and DFU paths both want.
 * baseAddress is 0 because an MCUboot update image is position-independent as
 * far as the transport is concerned: the tracker writes it to whichever slot
 * its own partition table says, and the bootloader relocates on swap. */
export function parseUpdateBin(bytes, name){
  if (!looksLikeUpdateBin(bytes)) throw mkErr('errWrongFormat', { want: '.update.bin' });
  return {
    kind: 'bin',
    name: name || 'firmware.update.bin',
    data: bytes,
    baseAddress: 0,
    crc32: crc32(bytes),
    size: bytes.length,
  };
}

/* ------------------------------ dongle ---------------------------------- */

/* Where a dongle's self-update may write (receiver src/receiver_ota.c).
 * Below 0x1000 is the MBR; the UF2 bootloader and its settings page sit far
 * above DONGLE_APP_END, and the dongle refuses anything reaching past it. */
export const DONGLE_APP_MIN = 0x1000;
export const DONGLE_APP_END = 0xDA000;

/* The dongle is updated from an app-only Intel HEX: the image the receiver CI
 * builds for its UF2 bootloader, starting at 0x1000 and containing neither the
 * MBR nor the bootloader. The page turns it into one contiguous block (gaps
 * filled with 0xFF, as flash reads when erased) plus the address it belongs
 * at, which is what the dongle's OTA BEGIN takes.
 *
 * A tracker .hex is refused here on purpose: it starts at 0x0 with MCUboot in
 * it, and written over a dongle's application it would never boot. */
export function parseAppHex(text, name){
  const segs = parseIntelHex(text);
  let lo = Infinity, hi = 0;
  for (const s of segs){
    lo = Math.min(lo, s.start);
    hi = Math.max(hi, s.start + s.data.length);
  }
  if (lo < DONGLE_APP_MIN || hi > DONGLE_APP_END){
    throw mkErr('errWrongFormat', { want: 'nekotora-dongle-*.hex' });
  }
  const data = new Uint8Array(hi - lo).fill(0xFF);
  for (const s of segs) data.set(s.data, s.start - lo);
  return {
    kind: 'app',
    name: name || 'dongle.hex',
    data,
    baseAddress: lo,
    crc32: crc32(data),
    size: data.length,
  };
}

/* ------------------------- manual file picking --------------------------- */

const UF2_MAGIC_START0 = 0x0A324655;   // "UF2\n"

/* What a firmware file is for, from its content - never from its name.
 *
 *   uf2         dongle recovery image; only the UF2 bootloader's drive takes it
 *   trackerBin  MCUboot update image (.update.bin): wireless or wired
 *   trackerHex  Intel HEX starting below 0x1000 (bootloader included), or a
 *               signed application HEX: SWD only
 *   dongleHex   Intel HEX starting at 0x1000 or above without an MCUboot
 *               header: the dongle's application, wireless only
 *   unknown     anything else
 */
export function classifyFirmwareFile(bytes){
  if (!bytes || !bytes.length) return 'unknown';
  if (bytes.length >= 512){
    const dv = new DataView(bytes.buffer, bytes.byteOffset, 4);
    if (dv.getUint32(0, true) === UF2_MAGIC_START0) return 'uf2';
  }
  if (looksLikeUpdateBin(bytes)) return 'trackerBin';
  const text = new TextDecoder().decode(bytes);
  if (!text.trimStart().startsWith(':')) return 'unknown';
  let segs;
  try { segs = parseIntelHex(text); } catch (_) { return 'unknown'; }
  if (!segs.length) return 'unknown';
  let first = segs[0];
  for (const s of segs) if (s.start < first.start) first = s;
  if (first.start < DONGLE_APP_MIN) return 'trackerHex';
  const d = first.data;
  const magic = d.length >= 4 && (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
  return magic === MCUBOOT_IMAGE_MAGIC ? 'trackerHex' : 'dongleHex';
}
