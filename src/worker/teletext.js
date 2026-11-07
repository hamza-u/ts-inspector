// EBU teletext in a PES (EN 300 472) and the page it carries (EN 300 706).
// Hamming 8/4 data bits sit at positions 1, 3, 5 and 7 (LSB is bit 0).
// Text bytes use odd parity over the whole byte. Magazine 0 is magazine 8.

const HAM = [
  0x15, 0x02, 0x49, 0x5E, 0x64, 0x73, 0x38, 0x2F,
  0xD0, 0xC7, 0x8C, 0x9B, 0xA1, 0xB6, 0xFD, 0xEA,
];

const HAM_MAP = new Map();
for (let n = 0; n < 16; n++) {
  const code = HAM[n];
  HAM_MAP.set(code, n);
  for (let b = 0; b < 8; b++) HAM_MAP.set(code ^ (1 << b), n);
}

export function hamming84(byte) {
  return HAM_MAP.has(byte) ? HAM_MAP.get(byte) : null;
}

export function oddParityChar(byte) {
  let n = 0;
  for (let i = 0; i < 8; i++) n += (byte >> i) & 1;
  if (n % 2 === 0) return null;
  const c = byte & 0x7F;
  if (c < 0x20 || c === 0x7F) return " ";
  return String.fromCharCode(c);
}

function address(b0, b1) {
  const n0 = hamming84(b0);
  const n1 = hamming84(b1);
  if (n0 === null || n1 === null) return null;
  const packet = (n0 & 0xF) | ((n1 & 1) << 4);
  let magazine = (n1 >> 1) & 7;
  if (magazine === 0) magazine = 8;
  return { packet, magazine };
}

export function decodeTeletextPes(payload) {
  if (!payload || !payload.length) return [];
  if (payload[0] < 0x10 || payload[0] > 0x1F) return [];
  const rows = [];
  let i = 1;
  while (i + 2 <= payload.length) {
    const id = payload[i];
    const len = payload[i + 1];
    const end = i + 2 + len;
    if (end > payload.length) break;
    const body = payload.subarray(i + 2, end);
    i = end;
    if ((id !== 0x02 && id !== 0x03) || body.length < 4) continue;
    const addr = address(body[2], body[3]);
    if (!addr) continue;
    const data = body.subarray(4);
    if (addr.packet === 0 && data.length >= 2) {
      const units = hamming84(data[0]);
      const tens = hamming84(data[1]);
      let text = "";
      for (let k = 8; k < data.length; k++) {
        const ch = oddParityChar(data[k]);
        text += ch === null ? " " : ch;
      }
      rows.push({
        magazine: addr.magazine,
        packet: 0,
        page: units === null || tens === null ? null : tens * 10 + units,
        text: text.replace(/\s+$/, ""),
        header: true,
      });
    } else {
      let text = "";
      for (let k = 0; k < data.length; k++) {
        const ch = oddParityChar(data[k]);
        text += ch === null ? " " : ch;
      }
      rows.push({
        magazine: addr.magazine,
        packet: addr.packet,
        page: null,
        text: text.replace(/\s+$/, ""),
        header: false,
      });
    }
  }
  return rows;
}

export function createTeletext() {
  const pages = [];
  let current = null;
  return {
    push(payload, packetIndex, pts, pid) {
      for (const row of decodeTeletextPes(payload)) {
        if (row.header && row.page !== null) {
          if (pages.length >= 80) return;
          current = {
            magazine: row.magazine,
            page: row.page,
            lines: [],
            packetIndex,
            pts,
            pid: pid || 0,
          };
          pages.push(current);
          if (row.text) current.lines.push({ packet: 0, text: row.text });
        } else if (current && row.packet > 0 && row.packet < 26) {
          current.lines.push({ packet: row.packet, text: row.text });
        }
      }
    },
    finish() {
      return pages.map((p) => ({
        magazine: p.magazine,
        page: p.page,
        number: p.magazine * 100 + p.page,
        packetIndex: p.packetIndex,
        pts: p.pts,
        pid: p.pid || 0,
        rows: p.lines,
        text: p.lines.map((l) => l.text).join("\n"),
      }));
    },
  };
}
