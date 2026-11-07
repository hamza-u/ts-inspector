// Split a byte stream into 188-byte transport packets.
// size 192 is M2TS (4-byte prefix, sync at offset 4).
// size 204 is a 188-byte packet plus 16 trailing bytes.
// The callback view is only valid for the duration of the call.

import { TS_SIZE } from "./tsutil.js";

const SIZES = [188, 192, 204];

export function detectFraming(buf) {
  const limit = Math.min(buf.length, 8192);
  let best = null;
  for (const size of SIZES) {
    let bestRun = 0;
    let bestAlign = 0;
    for (let align = 0; align < size && align < limit; align++) {
      let run = 0;
      let longest = 0;
      for (let off = align; off < limit; off += size) {
        if (buf[off] === 0x47) {
          run++;
          if (run > longest) longest = run;
        } else {
          run = 0;
        }
      }
      if (longest > bestRun) {
        bestRun = longest;
        bestAlign = align;
      }
    }
    if (bestRun >= 2 && (!best || bestRun > best.run)) {
      best = { size, align: bestAlign, run: bestRun };
    }
  }
  if (!best) return { size: 188, align: 0 };
  return { size: best.size, align: best.align };
}

export function createFramer() {
  let size = 188;
  let align = 0;
  let configured = false;
  let buf = new Uint8Array(0);
  let index = 0;
  let resyncs = 0;
  let framing = { size: 188, align: 0 };

  function append(chunk) {
    if (!buf.length) {
      buf = chunk;
      return;
    }
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
  }

  function drain(onPacket) {
    let o = 0;
    const b = buf;
    while (o + size <= b.length) {
      const syncAt = o + align;
      // A packet already in sync is taken on its own sync byte. The following
      // sync is checked only while hunting, otherwise the last good packet
      // before a gap is thrown away with the gap.
      if (b[syncAt] !== 0x47) {
        let found = -1;
        const end = b.length - size;
        for (let i = o + 1; i <= end; i++) {
          const at = i + align;
          if (at >= b.length || b[at] !== 0x47) continue;
          const nxt = at + size;
          if (nxt < b.length && b[nxt] !== 0x47 && i + size + size <= b.length) continue;
          found = i;
          break;
        }
        if (found < 0) break;
        resyncs++;
        o = found;
        continue;
      }
      const ts = b.subarray(syncAt, syncAt + TS_SIZE);
      onPacket(ts, index);
      index += 1;
      o += size;
    }
    buf = b.subarray(o).slice();
  }

  return {
    get index() { return index; },
    get resyncs() { return resyncs; },
    get framing() { return framing; },
    push(chunk, onPacket, onFrame) {
      append(chunk);
      if (!configured) {
        if (buf.length < 204 * 5 && buf.length < 1200) return;
        framing = detectFraming(buf);
        size = framing.size;
        align = framing.align;
        configured = true;
        if (onFrame) onFrame(framing);
      }
      drain(onPacket);
    },
    finish(onPacket, onFrame) {
      if (!configured) {
        framing = detectFraming(buf);
        size = framing.size;
        align = framing.align;
        configured = true;
        if (onFrame) onFrame(framing);
      }
      drain(onPacket);
      buf = new Uint8Array(0);
    },
  };
}
