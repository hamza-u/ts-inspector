// PCR interval, a straight-line fit of PCR against packet index, and
// PTS/DTS minus the PCR estimated at that packet.

import { PCR_MOD, payloadBytes, readPid } from "./tsutil.js";

const PTS_MOD = 2 ** 33;
const CAP = 2000;

function unwrap(prev, raw, mod) {
  if (prev === null) return raw;
  const last = prev % mod;
  let d = raw - last;
  if (d < -mod / 2) d += mod;
  else if (d > mod / 2) d -= mod;
  return prev + d;
}

function readPesTime(payload) {
  if (!payload || payload.length < 14) return null;
  if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return null;
  const flags = payload[7] >> 6;
  if ((flags & 2) === 0) return null;
  const p = payload.subarray(9, 14);
  if (p.length < 5) return null;
  const pts = ((p[0] >> 1) & 7) * 2 ** 30
    + p[1] * 2 ** 22
    + (p[2] >> 1) * 2 ** 15
    + p[3] * 2 ** 7
    + (p[4] >> 1);
  let dts = null;
  if ((flags & 1) && payload.length >= 19) {
    const d = payload.subarray(14, 19);
    dts = ((d[0] >> 1) & 7) * 2 ** 30
      + d[1] * 2 ** 22
      + (d[2] >> 1) * 2 ** 15
      + d[3] * 2 ** 7
      + (d[4] >> 1);
  }
  return { pts, dts };
}

export function estimatePcrAt(anchors, perPacket, index) {
  if (!anchors.length) return null;
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (anchors[mid].index <= index) lo = mid;
    else hi = mid - 1;
  }
  const a = anchors[lo];
  return a.pcr + (index - a.index) * perPacket;
}

export function linearFit(points) {
  const n = points.length;
  if (n < 2) return { maxAbsMs: 0, slope: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.index;
    sy += p.sec;
    sxx += p.index * p.index;
    sxy += p.index * p.sec;
  }
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const intercept = (sy - slope * sx) / n;
  let max = 0;
  for (const p of points) {
    const err = Math.abs(p.sec - (intercept + slope * p.index));
    if (err > max) max = err;
  }
  return { maxAbsMs: max * 1000, slope };
}

export function createTiming() {
  const anchors = [];
  let unwrapped = null;
  let lastIndex = null;
  const intervals = [];
  let seen = 0;
  let stride = 1;
  const ptsPrev = new Map();
  const dtsPrev = new Map();
  const samples = [];
  let sampleSeen = 0;
  let sampleStride = 1;

  function keepInterval(row) {
    seen += 1;
    if (intervals.length < CAP) {
      intervals.push(row);
      return;
    }
    if (seen % stride !== 0) {
      if (intervals.length === CAP) stride = 2;
      return;
    }
    intervals.push(row);
    if (intervals.length > CAP * 2) {
      const compact = [];
      for (let i = 0; i < intervals.length; i += 2) compact.push(intervals[i]);
      intervals.length = 0;
      for (const item of compact) intervals.push(item);
      stride *= 2;
    }
  }

  function keepSample(row) {
    sampleSeen += 1;
    if (samples.length < CAP) {
      samples.push(row);
      return;
    }
    if (sampleSeen % sampleStride !== 0) return;
    samples.push(row);
    if (samples.length > CAP * 2) {
      const compact = [];
      for (let i = 0; i < samples.length; i += 2) compact.push(samples[i]);
      samples.length = 0;
      for (const item of compact) samples.push(item);
      sampleStride *= 2;
    }
  }

  return {
    pcr(index, raw, mediaNow) {
      const prev = unwrapped;
      unwrapped = unwrap(unwrapped, raw, PCR_MOD);
      if (prev !== null && lastIndex !== null && index > lastIndex) {
        const dTicks = unwrapped - prev;
        keepInterval({ t: mediaNow, ms: dTicks / 27000, index });
      }
      anchors.push({ index, pcr: unwrapped });
      if (anchors.length > 20000) {
        const compact = [];
        for (let i = 0; i < anchors.length; i += 2) compact.push(anchors[i]);
        compact[compact.length - 1] = anchors[anchors.length - 1];
        anchors.length = 0;
        for (const a of compact) anchors.push(a);
      }
      lastIndex = index;
    },
    pes(pkt, index, mediaNow) {
      const payload = payloadBytes(pkt);
      const times = readPesTime(payload);
      if (!times) return;
      const pid = readPid(pkt);
      const push = (kind, raw, prevMap) => {
        const full = unwrap(prevMap.get(pid) ?? null, raw, PTS_MOD);
        prevMap.set(pid, full);
        if (anchors.length < 2) return;
        const first = anchors[0];
        const last = anchors[anchors.length - 1];
        const span = last.index - first.index;
        if (span <= 0) return;
        const per = (last.pcr - first.pcr) / span;
        const est = estimatePcrAt(anchors, per, index);
        const diffMs = (full - est / 300) / 90;
        keepSample({ pid, kind, t: mediaNow, ms: diffMs, index });
      };
      push("PTS", times.pts, ptsPrev);
      if (times.dts !== null) push("DTS", times.dts, dtsPrev);
    },
    muxRate() {
      if (anchors.length < 2) return null;
      const a = anchors[0];
      const b = anchors[anchors.length - 1];
      const dp = b.pcr - a.pcr;
      if (!(dp > 0) || b.index <= a.index) return null;
      return (b.index - a.index) * 188 * 8 * 27_000_000 / dp;
    },
    pcrAt(index) {
      if (!anchors.length) return null;
      if (anchors.length === 1) return anchors[0].pcr;
      let lo = 0;
      let hi = anchors.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (anchors[mid].index <= index) lo = mid;
        else hi = mid - 1;
      }
      const a = anchors[lo];
      const b = anchors[Math.min(lo + 1, anchors.length - 1)];
      if (b.index === a.index) return a.pcr;
      const per = (b.pcr - a.pcr) / (b.index - a.index);
      return a.pcr + (index - a.index) * per;
    },
    finish() {
      const fitPts = anchors.map((a) => ({ index: a.index, sec: a.pcr / 27e6 }));
      // The rate above simplifies to the usual PCR bitrate. Keep the explicit
      // form in muxRate; recompute plainly here for the chart.
      let rate = null;
      if (anchors.length >= 2) {
        const a = anchors[0];
        const b = anchors[anchors.length - 1];
        const dp = b.pcr - a.pcr;
        if (dp > 0 && b.index > a.index) {
          rate = (b.index - a.index) * 188 * 8 * 27_000_000 / dp;
        }
      }
      return {
        intervals: intervals.map((row) => ({ t: row.t, ms: Math.round(row.ms * 1000) / 1000 })),
        fit: linearFit(fitPts),
        ptsPcr: samples.map((row) => ({
          pid: row.pid,
          kind: row.kind,
          t: row.t,
          ms: Math.round(row.ms * 1000) / 1000,
        })),
        muxRate: rate,
      };
    },
  };
}
