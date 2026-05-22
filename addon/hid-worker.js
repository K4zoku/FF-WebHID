const CAPACITY   = 512;   // max buffered reports (power of 2)
// Layout of sab:
//   bytes 0-3   : head index  (Int32, written by worker)
//   bytes 4-7   : tail index  (Int32, written by page)
//   bytes 8-11  : dropped count (Int32)
//   bytes 12+   : report data (CAPACITY * REPORT_SIZE)

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
      const len  = batch[offset++];
      const head = Atomics.load(meta, 0);
      const next = (head + 1) % CAPACITY;
      
      if (next === Atomics.load(meta, 1)) {
        Atomics.add(meta, 2, 1); // ring full — drop
        offset += len;
        continue;
      }
      
      // write report — pad/truncate to reportSize
      data.fill(0, head * reportSize, (head + 1) * reportSize);
      data.set(
        batch.subarray(offset, offset + Math.min(len, reportSize)),
        head * reportSize
      );
      
      Atomics.store(meta, 0, next);
      offset += len;
    }
    Atomics.notify(meta, 0);
  };
};
