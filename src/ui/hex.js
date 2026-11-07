// Decode one 188-byte transport packet for the hex view.
// PCR and PTS use multiplication so the 33-bit values stay exact.

export function decodePacket(pkt) {
  if (!pkt || pkt.length < 188) return { error: "need 188 bytes" };
  const tei = (pkt[1] & 0x80) !== 0;
  const pusi = (pkt[1] & 0x40) !== 0;
  const priority = (pkt[1] & 0x20) !== 0;
  const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
  const scrambling = (pkt[3] >> 6) & 3;
  const afc = (pkt[3] >> 4) & 3;
  const cc = pkt[3] & 0xF;
  let payloadOffset = 4;
  let adaptation = null;
  if (afc & 2) {
    const afLen = pkt[4];
    payloadOffset = 5 + afLen;
    const flags = afLen > 0 ? pkt[5] : 0;
    let pcr = null;
    if (afLen >= 7 && (flags & 0x10)) {
      const base = pkt[6] * 33554432 + pkt[7] * 131072 + pkt[8] * 512 + pkt[9] * 2 + (pkt[10] >> 7);
      const ext = (pkt[10] & 1) * 256 + pkt[11];
      pcr = base * 300 + ext;
    }
    adaptation = {
      length: afLen,
      discontinuity: (flags & 0x80) !== 0,
      randomAccess: (flags & 0x40) !== 0,
      pcr,
    };
  }
  let pes = null;
  if ((afc & 1) && payloadOffset + 14 <= 188) {
    const p = pkt.subarray(payloadOffset);
    if (p[0] === 0 && p[1] === 0 && p[2] === 1) {
      const flags = p[7] >> 6;
      const read33 = (b) => ((b[0] >> 1) & 7) * 2 ** 30
        + b[1] * 2 ** 22 + (b[2] >> 1) * 2 ** 15 + b[3] * 2 ** 7 + (b[4] >> 1);
      pes = {
        streamId: p[3],
        pts: (flags & 2) && p.length >= 14 ? read33(p.subarray(9, 14)) : null,
        dts: (flags & 1) && p.length >= 19 ? read33(p.subarray(14, 19)) : null,
      };
    }
  }
  return {
    sync: pkt[0] === 0x47, tei, pusi, priority, pid, scrambling, afc, cc,
    payloadOffset, adaptation, pes,
  };
}

export function hexRows(pkt) {
  const rows = [];
  for (let i = 0; i < pkt.length; i += 16) {
    const slice = pkt.subarray(i, Math.min(pkt.length, i + 16));
    let hex = "";
    let ascii = "";
    for (let j = 0; j < slice.length; j++) {
      const b = slice[j];
      hex += (j ? " " : "") + b.toString(16).padStart(2, "0");
      ascii += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : ".";
    }
    rows.push({ offset: i, hex, ascii });
  }
  return rows;
}

const AFC = ["reserved", "payload", "adaptation", "adaptation+payload"];

export function packetSummary(info) {
  if (info.error) return info.error;
  const parts = [
    "PID " + info.pid,
    "CC " + info.cc,
    AFC[info.afc] || "afc",
  ];
  if (info.pusi) parts.push("PUSI");
  if (info.tei) parts.push("TEI");
  if (info.scrambling) parts.push("scrambling " + info.scrambling);
  if (info.adaptation && info.adaptation.pcr !== null) {
    parts.push("PCR " + info.adaptation.pcr);
  }
  if (info.pes && info.pes.pts !== null) parts.push("PTS " + info.pes.pts);
  if (info.pes && info.pes.dts !== null) parts.push("DTS " + info.pes.dts);
  return parts.join("  ·  ");
}
