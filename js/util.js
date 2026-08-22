/* Small shared helpers: formatting, errors, logging, CRC.
 *
 * Errors carry an i18n key rather than a message. Anything thrown from the
 * transport or flash layers is shown to a customer, so the string has to be
 * resolvable in whichever language they picked - which means the throw site
 * cannot format it. errText() in i18n.js does the lookup at display time.
 */

export const hex = (n, w = 8) =>
  '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');

export const le32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function mkErr(key, params){
  const e = new Error(key);
  e.i18nKey = key;
  e.i18nParams = params;
  return e;
}

/* ---------------------------- logging ---------------------------------- */

export const logLines = [];
let logEl = null;
export function bindLog(el){ logEl = el; }

export function log(msg, cls){
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8) + '.' +
             String(now.getMilliseconds()).padStart(3, '0');
  const line = '[' + ts + '] ' + msg;
  logLines.push(line);
  if (!logEl) return;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = line;
  logEl.appendChild(div);
  /* Only follow the tail when the user has not scrolled up to read something.
   * During a transfer this fires hundreds of times and yanking the view back
   * makes the log useless exactly when someone is trying to diagnose a
   * failure. */
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

export function clearLog(){
  logLines.length = 0;
  if (logEl) logEl.textContent = '';
}

/* ------------------------------ CRC32 ----------------------------------- */

/* Standard zlib CRC-32, matching Python's zlib.crc32 - the tracker computes
 * the same polynomial over the received image and the two must agree or OTA
 * VERIFY fails. Table is built once on first use. */
let crcTable = null;
function buildCrcTable(){
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++){
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[i] = c >>> 0;
  }
  return tbl;
}

export function crc32(bytes){
  if (!crcTable) crcTable = buildCrcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++){
    c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------------------------- formatting -------------------------------- */

export function kb(n){ return (n / 1024).toFixed(1) + ' KB'; }

export function verStr(code){
  if (code === null || code === undefined) return '?';
  const c = code >>> 0;
  return ((c >> 16) & 0xFF) + '.' + ((c >> 8) & 0xFF) + '.' + (c & 0xFF);
}

export function verCode(major, minor, patch){
  return (((major & 0xFF) << 16) | ((minor & 0xFF) << 8) | (patch & 0xFF)) >>> 0;
}
