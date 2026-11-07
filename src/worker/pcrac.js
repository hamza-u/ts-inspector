// PCR_AC: measured PCR minus the PCR a constant-rate line predicts from
// the packet index. A discontinuity starts a new line. H.222.0 allows
// ±500 ns. PCR_OJ, drift and frequency offset need an arrival clock.

import { PCR_MOD, unwrapClock, createDecimator } from "./tsutil.js";

const LIMIT_NS = 500;

function fitSegment(seg) {
  const n = seg.length;
  if (n < 2) return [];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of seg) {
    sx += p.index;
    sy += p.pcr;
    sxx += p.index * p.index;
    sxy += p.index * p.pcr;
  }
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const intercept = (sy - slope * sx) / n;
  const out = [];
  for (const p of seg) {
    const expect = intercept + slope * p.index;
    const ticks = p.pcr - expect;
    const ns = ticks / 27e6 * 1e9;
    out.push({ t: p.t, index: p.index, ns, packetIndex: p.packetIndex });
  }
  return out;
}

export function pcrAccuracy(samples) {
  let prev = null;
  let prevIndex = null;
  const segs = [];
  let cur = [];
  for (const s of samples) {
    const uw = unwrapClock(prev, s.pcr, PCR_MOD);
    let split = false;
    if (prev !== null && prevIndex !== null && s.index > prevIndex) {
      const dms = (uw - prev) / 27000;
      if (dms < 0 || dms > 100) split = true;
    }
    if (split && cur.length) {
      segs.push(cur);
      cur = [];
    }
    cur.push({ index: s.index, pcr: uw, t: s.t, packetIndex: s.packetIndex });
    prev = uw;
    prevIndex = s.index;
  }
  if (cur.length) segs.push(cur);
  const points = [];
  for (const seg of segs) points.push(...fitSegment(seg));
  let min = null;
  let max = null;
  let sumSq = 0;
  let over = 0;
  let first = null;
  for (const p of points) {
    if (min === null || p.ns < min) min = p.ns;
    if (max === null || p.ns > max) max = p.ns;
    sumSq += p.ns * p.ns;
    if (Math.abs(p.ns) > LIMIT_NS) {
      over += 1;
      if (!first) first = p;
    }
  }
  const hist = [];
  const lo = -2000;
  const step = 200;
  const bins = 20;
  for (let i = 0; i < bins; i++) hist.push({ lo: lo + i * step, n: 0 });
  let tailLo = 0;
  let tailHi = 0;
  for (const p of points) {
    if (p.ns < lo) { tailLo += 1; continue; }
    const idx = Math.floor((p.ns - lo) / step);
    if (idx >= bins) tailHi += 1;
    else hist[idx].n += 1;
  }
  const series = createDecimator();
  for (const p of points) series.push(p);
  return {
    limitNs: LIMIT_NS,
    count: points.length,
    minNs: min,
    maxNs: max,
    rmsNs: points.length ? Math.sqrt(sumSq / points.length) : null,
    overLimit: over,
    firstPacket: first ? first.packetIndex : -1,
    firstNs: first ? first.ns : null,
    series: series.rows().map((p) => ({
      t: Math.round(p.t * 1e6) / 1e6,
      ns: Math.round(p.ns * 10) / 10,
      packetIndex: p.packetIndex,
    })),
    hist,
    tailLo,
    tailHi,
    oj: null,
    drift: null,
    frequencyOffset: null,
    arrivalNote: "PCR_OJ, drift and frequency offset need packet arrival time. A file has only PCR time.",
  };
}

export function createPcrAc() {
  const samples = [];
  return {
    add(index, pcr, t) {
      samples.push({ index, pcr, t, packetIndex: index });
    },
    finish() {
      return pcrAccuracy(samples);
    },
  };
}
