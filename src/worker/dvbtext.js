// EN 300 468 Annex A. Default is the ISO/IEC 6937 Latin subset.
// 0x10 selects an ISO 8859 table, 0x11 is UCS-2, 0x15 is UTF-8.

const SINGLE = {
  0xA0: "\u00A0", 0xA1: "\u00A1", 0xA2: "\u00A2", 0xA3: "\u00A3", 0xA4: "\u20AC",
  0xA5: "\u00A5", 0xA6: "\u00A6", 0xA7: "\u00A7", 0xA8: "\u00A4", 0xA9: "\u2018",
  0xAA: "\u201C", 0xAB: "\u00AB", 0xAC: "\u2190", 0xAD: "\u2191", 0xAE: "\u2192",
  0xAF: "\u2193", 0xB0: "\u00B0", 0xB1: "\u00B1", 0xB2: "\u00B2", 0xB3: "\u00B3",
  0xB4: "\u00D7", 0xB5: "\u00B5", 0xB6: "\u00B6", 0xB7: "\u00B7", 0xB8: "\u00F7",
  0xB9: "\u2019", 0xBA: "\u201D", 0xBB: "\u00BB", 0xBC: "\u00BC", 0xBD: "\u00BD",
  0xBE: "\u00BE", 0xBF: "\u00BF",
  0xE0: "\u2126", 0xE1: "\u00C6", 0xE2: "\u0110", 0xE3: "\u00AA", 0xE4: "\u0126",
  0xE5: "\u0132", 0xE6: "\u013F", 0xE7: "\u0132", 0xE8: "\u0141", 0xE9: "\u00D8",
  0xEA: "\u0152", 0xEB: "\u00BA", 0xEC: "\u00DE", 0xED: "\u0166", 0xEE: "\u014A",
  0xEF: "\u0149", 0xF0: "\u0138", 0xF1: "\u00E6", 0xF2: "\u0111", 0xF3: "\u00F0",
  0xF4: "\u0127", 0xF5: "\u0131", 0xF6: "\u0133", 0xF7: "\u0140", 0xF8: "\u0142",
  0xF9: "\u00F8", 0xFA: "\u0153", 0xFB: "\u00DF", 0xFC: "\u00FE", 0xFD: "\u0167",
  0xFE: "\u014B", 0xFF: "\u00AD",
};

// Non-spacing diacritics. They apply to the following character.
const MARK = {
  0xC1: "\u0300", 0xC2: "\u0301", 0xC3: "\u0302", 0xC4: "\u0303", 0xC5: "\u0304",
  0xC6: "\u0306", 0xC7: "\u0307", 0xC8: "\u0308", 0xCA: "\u030A", 0xCB: "\u0327",
  0xCD: "\u030B", 0xCE: "\u0328", 0xCF: "\u030C",
};

function decode8859(n, bytes) {
  const label = "iso-8859-" + n;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch (err) {
    return ascii(bytes);
  }
}

function ascii(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    s += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : ".";
  }
  return s;
}

function decode6937(bytes) {
  let s = "";
  let mark = "";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c < 0x20) continue;
    if (MARK[c]) {
      mark = MARK[c];
      continue;
    }
    const ch = c < 0x80 ? String.fromCharCode(c) : (SINGLE[c] || ".");
    s += mark ? (ch + mark).normalize("NFC") : ch;
    mark = "";
  }
  return s;
}

export function decodeDvbText(bytes) {
  if (!bytes || !bytes.length) return "";
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b[0] === 0x15) return new TextDecoder("utf-8").decode(b.subarray(1));
  if (b[0] === 0x11) {
    try { return new TextDecoder("utf-16be").decode(b.subarray(1)); }
    catch (err) { return ascii(b.subarray(1)); }
  }
  if (b[0] === 0x10 && b.length >= 3) {
    const n = (b[1] << 8) | b[2];
    const table = n >= 1 && n <= 15 ? n : 1;
    return decode8859(table, b.subarray(3));
  }
  return decode6937(b);
}
