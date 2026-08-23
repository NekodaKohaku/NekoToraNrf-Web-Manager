/* Wired DFU uses one baud rate, and only one.
 *
 * This file used to test a five-rate auto-detect sweep. That is gone. Guessing
 * a UART rate means open, send, wait, close, repeat - slow, and when it ends in
 * failure the customer is told "nothing responded" when the real answer was
 * "wrong speed", which is not a message anyone can act on. The rate is now
 * generated from one build config into all three places that need it, so a
 * NekoTora tracker is DFU_BAUD by definition.
 *
 * What is worth pinning is that nothing quietly reintroduces a fallback: if a
 * unit ever answers at some other rate it has the wrong firmware, and that
 * should fail loudly rather than be worked around.
 */
import { enterRecovery } from '../js/smp.js';
import { DFU_BAUD } from '../js/config.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c){ pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } };

globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');

ok(DFU_BAUD === 1000000, 'DFU_BAUD is 1000000');

/* A port that records every rate it is opened at and never answers, so
 * enterRecovery is forced all the way to its timeout. */
function recordingPort(){
  const opens = [];
  let closed = true;
  return {
    opens,
    async open({ baudRate }){ opens.push(baudRate); closed = false; },
    async close(){ closed = true; },
    get readable(){
      if (closed) return null;
      return { getReader: () => ({
        read: () => new Promise(r => setTimeout(() => r({ done: true }), 30)),
        cancel: async () => { closed = true; },
        releaseLock(){},
      }) };
    },
    get writable(){
      return { getWriter: () => ({ async write(){}, releaseLock(){} }) };
    },
  };
}

const port = recordingPort();
const got = await enterRecovery(port, { baudRate: DFU_BAUD, timeoutMs: 500 });

ok(got === null, 'a silent tracker fails rather than hanging');
ok(port.opens.length === 1, `the port is opened once, not swept (${port.opens.length})`);
ok(port.opens.every(b => b === DFU_BAUD), 'the only rate opened is DFU_BAUD');

/* The signature itself is the guard: a caller cannot hand in a list of rates
 * to try, because there is no parameter for one. (length is 1 because the
 * options object has a default.) */
ok(enterRecovery.length === 1, 'enterRecovery takes (port, options) - no rate list');

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASS'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
