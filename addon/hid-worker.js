const CAPACITY   = 512;   // max buffered reports (power of 2)
// Layout of sab:
//   bytes 0-3   : head index  (Int32, written by worker)
//   bytes 4-7   : tail index  (Int32, written by page)
//   bytes 8-11  : dropped count (Int32)
//   bytes 12+   : report data (CAPACITY * REPORT_SIZE)
//
// Each ring slot stores `[len_u8][report_id_u8][...payload]` (len includes
// the report_id byte). This matches the WebSocket batch frame format so
// variable-length reports can be passed through verbatim. Slots are
// REPORT_SIZE bytes wide; any report larger than REPORT_SIZE-1 is truncated,
// which is a bug the caller must avoid by passing a sufficiently large
// reportSize when the worker is started.

let sab = null;
let meta = null;
let data = null;
let reportSize = 64;

self.onmessage = ({ data: msg }) => {
  if (msg.type !== 'connect') return;

  reportSize = msg.reportSize || 64;
  sab = new SharedArrayBuffer(12 + CAPACITY * reportSize);
  meta = new Int32Array(sab, 0, 3);   // [head, tail, dropped]
  data = new Uint8Array(sab, 12);

  const ws = new WebSocket(
    `ws://127.0.0.1:${msg.wsPort}?token=${msg.token}`
  );
  ws.binaryType = 'arraybuffer';

  ws.onopen  = () => self.postMessage({ type: 'ready', sab });
  ws.onerror = (e) => self.postMessage({ type: 'error', error: e.message });
  ws.onclose = ()  => self.postMessage({ type: 'closed' });

  ws.onmessage = ({ data: frame }) => {
    const batch  = new Uint8Array(frame);
    let   offset = 0;
    while (offset < batch.length) {
      const len  = batch[offset++];           // total report length (incl. report_id)
      if (len === 0 || offset + len > batch.length) break;

      const head = Atomics.load(meta, 0);
      const next = (head + 1) % CAPACITY;

      if (next === Atomics.load(meta, 1)) {
        Atomics.add(meta, 2, 1); // ring full — drop
        offset += len;
        continue;
      }

      // Write `[len][report_bytes...]` into the slot. Page-side consumer
      // reads `slot[0]` for the actual length, then reads that many bytes
      // starting at `slot[1]`. No truncation/padding to reportSize.
      const slotStart = head * reportSize;
      const slotEnd   = slotStart + reportSize;
      // Zero the slot so leftover bytes from a previous longer report
      // don't leak into the new one.
      data.fill(0, slotStart, slotEnd);
      // First byte = length (cap at reportSize-1 so we never overflow slot).
      const storedLen = Math.min(len, reportSize - 1);
      data[slotStart] = storedLen;
      data.set(
        batch.subarray(offset, offset + storedLen),
        slotStart + 1
      );

      Atomics.store(meta, 0, next);
      offset += len;
    }
    Atomics.notify(meta, 0);
  };
};
