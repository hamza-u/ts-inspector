// Twin of scripts/pcr_clock.py. Keep the two in lockstep.
// Output is seconds, first emitted packet at 0, quantized to 1 us.

import { PCR_MOD } from "./tsutil.js";

const NOMINAL_BPS = 10_000_000;
const MAX_BUFFER = 8000;

function nominal() {
  return (188 * 8) / NOMINAL_BPS;
}

function quantize(absSec, originUs) {
  const us = Math.floor(absSec * 1_000_000 + 0.5);
  if (originUs === null) originUs = us;
  return [originUs, (us - originUs) / 1_000_000];
}

export function createClock(maxBuffer = MAX_BUFFER) {
  const buf = [];
  let originUs = null;
  let rate = null;
  let anchorIndex = null;
  let anchorSec = null;
  let unwrapped = null;
  let rebaseUw = null;
  let rebaseSec = null;
  let nominalLocked = false;

  function emit(index, absSec) {
    let now;
    [originUs, now] = quantize(absSec, originUs);
    return [index, now];
  }

  function secOf(raw) {
    if (unwrapped === null) unwrapped = raw;
    else {
      const last = unwrapped % PCR_MOD;
      let d = raw - last;
      if (d < -PCR_MOD / 2) d += PCR_MOD;
      else if (d > PCR_MOD / 2) d -= PCR_MOD;
      unwrapped += d;
    }
    if (rebaseUw === null) return unwrapped / 27_000_000;
    return rebaseSec + (unwrapped - rebaseUw) / 27_000_000;
  }

  function emitSpan(i0, t0, i1, t1) {
    const rateNow = i1 !== i0 ? (t1 - t0) / (i1 - i0) : (rate || nominal());
    const out = [];
    const kept = [];
    for (const entry of buf) {
      const index = entry[0];
      if (index > i1) {
        kept.push(entry);
        continue;
      }
      const absT = index <= i0 ? t0 - (i0 - index) * rateNow : t0 + (index - i0) * rateNow;
      out.push(emit(index, absT));
    }
    buf.length = 0;
    for (const entry of kept) buf.push(entry);
    return out;
  }

  function discontinuity(index) {
    const use = rate && rate > 0 ? rate : nominal();
    const prevI = anchorIndex;
    const prevS = anchorSec;
    const out = [];
    for (const [i] of buf) {
      const absT = prevS + (i - prevI) * use;
      out.push(emit(i, absT));
      if (i === index) {
        anchorIndex = i;
        anchorSec = absT;
      }
    }
    buf.length = 0;
    rate = use;
    rebaseUw = unwrapped;
    rebaseSec = anchorSec;
    return out;
  }

  function flushOpen() {
    if (rate === null || anchorSec === null) {
      nominalLocked = true;
      const out = [];
      for (const [index] of buf) out.push(emit(index, index * nominal()));
      buf.length = 0;
      return out;
    }
    const out = [];
    let lastAbs = null;
    let lastI = null;
    for (const [index] of buf) {
      const absT = anchorSec + (index - anchorIndex) * rate;
      out.push(emit(index, absT));
      lastAbs = absT;
      lastI = index;
    }
    if (lastI !== null) {
      anchorIndex = lastI;
      anchorSec = lastAbs;
    }
    buf.length = 0;
    return out;
  }

  return {
    push(index, pcr) {
      if (nominalLocked) return [emit(index, index * nominal())];
      buf.push([index, pcr]);
      if (pcr === null || pcr === undefined) {
        if (buf.length > maxBuffer) return flushOpen();
        return [];
      }
      const sec = secOf(pcr);
      if (anchorSec === null) {
        anchorIndex = index;
        anchorSec = sec;
        return [];
      }
      const prevI = anchorIndex;
      const prevS = anchorSec;
      let newRate = null;
      if (index !== prevI) newRate = (sec - prevS) / (index - prevI);
      if (newRate === null || newRate <= 0) return discontinuity(index);
      rate = newRate;
      const out = emitSpan(prevI, prevS, index, sec);
      anchorIndex = index;
      anchorSec = sec;
      return out;
    },
    finish() {
      if (nominalLocked) {
        const out = [];
        for (const [index] of buf) out.push(emit(index, index * nominal()));
        buf.length = 0;
        return out;
      }
      return flushOpen();
    },
  };
}
