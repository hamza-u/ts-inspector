// Shared packet readers. Do not use `<<` on values that can exceed 32 bits:
// a PCR base is 33 bits and a PTS is 33 bits.

export const TS_SIZE = 188;
export const PCR_MOD = 2 ** 33 * 300;
export const PCR_HZ = 27_000_000;

export function readPid(pkt) {
  return ((pkt[1] & 0x1F) << 8) | pkt[2];
}

export function readPcr(pkt) {
  const afc = (pkt[3] >> 4) & 3;
  if ((afc & 2) === 0) return null;
  const afLen = pkt[4];
  if (afLen < 7 || (pkt[5] & 0x10) === 0) return null;
  const b0 = pkt[6];
  const b1 = pkt[7];
  const b2 = pkt[8];
  const b3 = pkt[9];
  const b4 = pkt[10];
  const b5 = pkt[11];
  const base = b0 * 33554432 + b1 * 131072 + b2 * 512 + b3 * 2 + (b4 >> 7);
  const ext = (b4 & 1) * 256 + b5;
  return base * 300 + ext;
}

export function adaptationOffset(pkt) {
  const afc = (pkt[3] >> 4) & 3;
  if ((afc & 2) === 0) return 4;
  return 5 + pkt[4];
}

export function payloadBytes(pkt) {
  const afc = (pkt[3] >> 4) & 3;
  if ((afc & 1) === 0) return null;
  const off = adaptationOffset(pkt);
  if (off >= pkt.length) return null;
  return pkt.subarray(off);
}

export function readDiscont(pkt) {
  const afc = (pkt[3] >> 4) & 3;
  if ((afc & 2) === 0 || pkt[4] < 1) return false;
  return (pkt[5] & 0x80) !== 0;
}

// prev is an already-unwrapped counter. raw is the wrapped sample.
export function unwrapClock(prev, raw, mod) {
  if (prev === null || prev === undefined) return raw;
  const last = prev % mod;
  let d = raw - last;
  if (d < -mod / 2) d += mod;
  else if (d > mod / 2) d -= mod;
  return prev + d;
}

// Keep a chart series bounded. Same thinning as the PCR interval list.
export function createDecimator(cap = 2000) {
  const rows = [];
  let seen = 0;
  let stride = 1;
  return {
    push(row) {
      seen += 1;
      if (rows.length < cap) {
        rows.push(row);
        return;
      }
      if (seen % stride !== 0) {
        if (rows.length === cap) stride = 2;
        return;
      }
      rows.push(row);
      if (rows.length > cap * 2) {
        const compact = [];
        for (let i = 0; i < rows.length; i += 2) compact.push(rows[i]);
        rows.length = 0;
        for (const item of compact) rows.push(item);
        stride *= 2;
      }
    },
    rows() {
      return rows;
    },
  };
}
