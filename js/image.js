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
