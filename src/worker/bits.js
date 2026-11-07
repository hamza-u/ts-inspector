// Big-endian bit cursor for H.264 RBSP. u(n) stays inside the 53-bit integer
// range: SPS and SEI fields we read are at most 32 bits.

export function stripEpb(data) {
  const src = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const out = new Uint8Array(src.length);
  let w = 0;
  for (let i = 0; i < src.length; i++) {
    if (i + 2 < src.length && src[i] === 0 && src[i + 1] === 0 && src[i + 2] === 3) {
      out[w++] = 0;
      out[w++] = 0;
      i += 2;
      continue;
    }
    out[w++] = src[i];
  }
  return out.subarray(0, w);
}

export function createBits(data) {
  const buf = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
  const n = buf.length * 8;
  let i = 0;

  function u(k) {
    if (!k) return 0;
    if (i + k > n) {
      const err = new Error("need " + k + " bits at " + i + "/" + n);
      err.code = "EOF";
      throw err;
    }
    let v = 0;
    for (let b = 0; b < k; b++) {
      const at = i + b;
      v = v * 2 + ((buf[at >> 3] >> (7 - (at & 7))) & 1);
    }
    i += k;
    return v;
  }

  function ue() {
    let z = 0;
    while (u(1) === 0) {
      z += 1;
      if (z > 31) throw new Error("exp-golomb");
    }
    if (!z) return 0;
    return ((1 << z) - 1) + u(z);
  }

  function se() {
    const k = ue();
    if (k & 1) return (k + 1) >> 1;
    return -(k >> 1);
  }

  // False when nothing remains, or only rbsp_trailing_bits (a 1 then zeros),
  // or only the zero padding after that stop bit was already consumed.
  function moreRbspData() {
    const left = n - i;
    if (left <= 0) return false;
    let ones = 0;
    let zeroBefore = false;
    for (let b = 0; b < left; b++) {
      const at = i + b;
      const bit = (buf[at >> 3] >> (7 - (at & 7))) & 1;
      if (bit) {
        ones += 1;
        if (ones > 1 || zeroBefore) return true;
      } else if (!ones) zeroBefore = true;
    }
    return false;
  }

  return {
    u, ue, se, moreRbspData,
    left() { return n - i; },
    pos() { return i; },
    seek(bit) { i = Math.max(0, Math.min(n, bit | 0)); },
    align() {
      if (i & 7) u(8 - (i & 7));
    },
  };
}
