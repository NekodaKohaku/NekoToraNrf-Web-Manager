/* Intel HEX parsing and address classification.
 *
 * Lifted verbatim from the single-file version - this is the code path that has
 * flashed every unit so far, so it is moved rather than rewritten. The only
 * changes are the import/export lines and dropping the TEST markers, which
 * existed to let a harness carve the pure functions out of index.html; with
 * modules a test can simply import them.
 */
import { mkErr, hex } from './util.js';
import { CONFIG } from './config.js';

/* ----------------------- Intel HEX parser --------------------------- */
export function parseIntelHex(text){
  let upper = 0; const raw = []; let cur = null;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++){
    const line = lines[li].trim();
    if (!line) continue;
    if (line[0] !== ':' || (line.length - 1) % 2 !== 0) throw mkErr('errHexFormat', {line: li + 1});
    const b = new Uint8Array((line.length - 1) / 2);
    for (let i = 0; i < b.length; i++){
      const v = parseInt(line.substr(1 + i * 2, 2), 16);
      if (Number.isNaN(v)) throw mkErr('errHexFormat', {line: li + 1});
      b[i] = v;
    }
    let sum = 0; for (const v of b) sum = (sum + v) & 0xFF;
    if (sum !== 0) throw mkErr('errHexChecksum', {line: li + 1});
    const len = b[0], addr = (b[1] << 8) | b[2], type = b[3];
    if (b.length !== len + 5) throw mkErr('errHexFormat', {line: li + 1});
    const data = b.subarray(4, 4 + len);
    if (type === 0){
      const abs = (upper + addr) >>> 0;
      if (cur && cur.start + cur.bytes.length === abs){ for (const v of data) cur.bytes.push(v); }
      else { cur = {start: abs, bytes: Array.from(data)}; raw.push(cur); }
    } else if (type === 1){ break; }
    else if (type === 4){ upper = (((b[4] << 8) | b[5]) * 0x10000) >>> 0; }
    else if (type === 2){ upper = (((b[4] << 8) | b[5]) * 16) >>> 0; }
    else if (type === 3 || type === 5){ /* start address records — ignored */ }
    else throw mkErr('errHexFormat', {line: li + 1});
  }
  if (!raw.length) throw mkErr('errHexEmpty');
  raw.sort((a, b2) => a.start - b2.start);
  // merge segments separated by small gaps (fill 0xFF) so padded words never overlap
  const merged = [];
  for (const s of raw){
    const last = merged[merged.length - 1];
    if (last){
      const lastEnd = last.start + last.bytes.length;
      if (s.start < lastEnd) throw mkErr('errHexOverlap');
      if (s.start - lastEnd <= 8){
        for (let i = lastEnd; i < s.start; i++) last.bytes.push(0xFF);
        for (const v of s.bytes) last.bytes.push(v);
        continue;
      }
    }
    merged.push(s);
  }
  // word-align each segment (pad with 0xFF)
  return merged.map(s => {
    const start = s.start & ~3;
    const end = (s.start + s.bytes.length + 3) & ~3;
    const buf = new Uint8Array(end - start).fill(0xFF);
    buf.set(Uint8Array.from(s.bytes), s.start - start);
    const dv = new DataView(buf.buffer);
    const words = new Uint32Array(buf.length >> 2);
    for (let i = 0; i < words.length; i++) words[i] = dv.getUint32(i * 4, true);
    return {start, data: buf, words};
  });
}

export function classifySegments(segs){
  const flash = [], uicr = [];
  for (const s of segs){
    const end = s.start + s.data.length;
    if (s.start >= CONFIG.flashBase && end <= CONFIG.flashBase + CONFIG.flashSize) flash.push(s);
    else if (s.start >= CONFIG.uicrBase && end <= CONFIG.uicrBase + CONFIG.uicrSize) uicr.push(s);
    else throw mkErr('errRange', {range: hex(s.start) + '–' + hex(end)});
  }
  return {flash, uicr};
}
