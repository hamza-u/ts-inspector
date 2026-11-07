// MPEG-2 CRC (poly 0x04C11DB7, init 0xFFFFFFFF, no reflection, no xor-out).
// Shifts stay unsigned:
// JavaScript `<<` is a 32-bit signed op, so every step is `>>> 0`.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = (i << 24) >>> 0;
    for (let k = 0; k < 8; k++) {
      if (c & 0x80000000) c = ((c << 1) ^ 0x04C11DB7) >>> 0;
      else c = (c << 1) >>> 0;
    }
    table[i] = c;
  }
  return table;
})();

export function crc32Mpeg(data, start = 0, end = data.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) {
    const idx = ((c >>> 24) ^ data[i]) & 0xFF;
    c = (((c << 8) >>> 0) ^ CRC_TABLE[idx]) >>> 0;
  }
  return c >>> 0;
}
