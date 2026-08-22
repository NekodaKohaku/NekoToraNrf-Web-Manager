/* Target and page configuration.
 *
 * Anything product-specific that is not per-unit lives in devices.json instead;
 * this file is for facts about the silicon and defaults for the UI.
 */

export const CONFIG = {
  deviceName: 'nRF52840 Tracker',      // shown in the page subtitle
  flashBase: 0x00000000,
  flashSize: 0x100000,                 // 1 MB
  pageSize: 4096,
  uicrBase: 0x10001000,
  uicrSize: 0x1000,
  expectedPart: 0x52840,               // FICR.INFO.PART
  blockIfPartMismatch: false,          // true = refuse to flash non-nRF52840
  defaultSwdClockHz: 1000000,
  devicesUrl: 'devices.json',          // device registry (same-origin)
};

export const DEFAULT_DEVICES = {
  devices: [
    {
      id: 'nekotora',
      probeNames: ['NekoTora'],
      dongleNames: ['NekoTora Dongle', 'NekoTora'],
      name: { zh: 'NekoTora 追蹤器', en: 'NekoTora Tracker', ja: 'NekoTora トラッカー' },
      chip: 'nrf52840',
      manifest: 'firmware/nekotora/latest.json',
      usbFilters: [{ vendorId: 0x0D28, productId: 0x0204 }],
      dongleFilters: [{ vendorId: 0x1209, productId: 0x7690 }],
    },
  ],
};

/* The three ways firmware can reach a tracker, in the order a customer should
 * reach for them. Order matters: the first entry is the default, and for a
 * finished product that has to be the wireless path - it needs no cable, no
 * disassembly and no extra hardware.
 *
 *   needs: which manifest field supplies the image.
 *     'bin' = MCUboot signed update image (.update.bin), written to slot 1 and
 *             swapped in by the bootloader.
 *     'hex' = full image including MCUboot itself, written straight to flash.
 *             Only SWD can do this, and only SWD can recover a unit whose
 *             bootloader is gone - which is why it stays available.
 */
export const METHODS = ['ota', 'dfu', 'swd'];

/* Trackers are updated one at a time, not in parallel.
 *
 * The dongle can relay to four at once (OTA_MAX_PARALLEL in its
 * src/esb_ota.h), but the 128-packet ring is shared and the producer may not
 * write past min_seq + RING_SIZE, where min_seq is the *slowest* target's
 * cursor. So the window advances at the rate of the worst tracker, and the
 * chance that at least one of N is momentarily retrying climbs quickly with N.
 * Once the window pins, the PC cannot push, which triggers a replay, which
 * slows everyone further - the failure mode compounds rather than adding up.
 *
 * Measured on hardware: one tracker is fast, two middling, three slow but
 * reliable, four never completed. That is a cliff, not a gradient, and a
 * shipped product cannot sit next to it.
 *
 * Sequential costs roughly N x 20 s and never falls off anything. For a
 * customer, a predictable minute beats an unpredictable failure.
 */
export const OTA_SEQUENTIAL = true;
