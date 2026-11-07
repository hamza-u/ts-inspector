// Human names for stream types (ISO/IEC 13818-1 table 2-34 and the private
// ranges), PSI PIDs, and the private-stream descriptors that say what is in
// a 0x06 payload. One table, used by the PID list, the PMT view and TR 101 290.

export const STREAM_TYPES = {
  0x01: "MPEG-1 video",
  0x02: "MPEG-2 video",
  0x03: "MPEG-1 audio",
  0x04: "MPEG-2 audio",
  0x05: "private sections",
  0x06: "PES private data",
  0x07: "MHEG",
  0x08: "DSM-CC",
  0x09: "H.222.1 auxiliary",
  0x0A: "DSM-CC A",
  0x0B: "DSM-CC B",
  0x0C: "DSM-CC C",
  0x0D: "DSM-CC D",
  0x0E: "H.222.0 auxiliary",
  0x0F: "AAC (ADTS)",
  0x10: "MPEG-4 video",
  0x11: "AAC (LATM)",
  0x12: "MPEG-4 PES",
  0x13: "MPEG-4 sections",
  0x14: "MPEG-4 sync download",
  0x15: "metadata in PES",
  0x16: "metadata in sections",
  0x17: "metadata in sync download",
  0x18: "MPEG-2 IPMP",
  0x19: "MPEG-2 IPMP 2",
  0x1A: "MPEG-2 IPMP 3",
  0x1B: "H.264",
  0x1C: "MPEG-4 audio",
  0x1D: "MPEG-4 text",
  0x1E: "MPEG-4 subtitle",
  0x1F: "MPEG-4 auxiliary",
  0x20: "MPEG-4 AVC SVC",
  0x21: "MPEG-4 JPEG 2000",
  0x22: "MPEG-4 MVC",
  0x23: "MPEG-4 HEVC temp",
  0x24: "HEVC",
  0x25: "HEVC temporal sub-layer",
  0x26: "MPEG-H 3D audio",
  0x27: "MPEG-H 3D audio (LATM)",
  0x28: "MPEG-H 3D audio (PES)",
  0x42: "AVS (China)",
  0x7F: "IPMP",
  0x80: "MPEG-2 stereo (private)",
  0x81: "AC-3",
  0x82: "HDMV DTS",
  0x83: "Dolby TrueHD",
  0x84: "E-AC-3",
  0x85: "DTS-HD HRA",
  // 0x86 is SCTE-35 in broadcast practice and DTS-HD MA on Blu-ray. The
  // registration descriptor decides when one is present; SCTE-35 wins by
  // default, because that is what this tool is read for.
  0x86: "SCTE-35",
  0x87: "E-AC-3 (deprecated)",
  0x8A: "DTS",
  0x90: "PGS subtitle",
  0x91: "IGS",
  0x92: "text subtitle",
  0xEA: "VC-1",
};

// PIDs with a fixed meaning in H.222.0 and EN 300 468.
export const TABLE_PIDS = {
  0x00: "PAT",
  0x01: "CAT",
  0x02: "TSDT",
  0x03: "reserved",
  0x10: "NIT",
  0x11: "SDT/BAT",
  0x12: "EIT",
  0x13: "RST",
  0x14: "TDT/TOT",
  0x15: "network sync",
  0x16: "RNT",
  0x17: "SDT/BAT·other",
  0x18: "EIT·other",
  0x1F: "SCTE-35",
  0x1FFB: "ATSC PSIP",
};

// What a stream type alone cannot tell you: the descriptor does.
const PRIVATE_BY_DESCRIPTOR = [
  { tag: 0x59, name: "subtitling" },
  { tag: 0x56, name: "teletext" },
  { tag: 0x46, name: "VBI teletext" },
  { tag: 0x6A, name: "AC-3" },
  { tag: 0x7A, name: "E-AC-3" },
  { tag: 0x7B, name: "DTS" },
  { tag: 0x7C, name: "AAC" },
  { tag: 0x7F, name: "DTS-HD" },
];

function descriptorNames(info) {
  const names = [];
  for (const d of info || []) {
    if (d && typeof d.name === "string") names.push(d.name);
  }
  return names;
}

function registrationOf(info) {
  for (const d of info || []) {
    if (d && d.tag === 0x05 && d.text) return String(d.text).toUpperCase();
  }
  return "";
}

// Stream type plus descriptors to a display name. A private PES payload is
// named from its descriptor, which is how subtitle and teletext tracks are
// signalled; the stream type alone cannot say what is inside.
export function streamName(type, info) {
  const base = STREAM_TYPES[type] || ("stream type 0x" + Number(type).toString(16).padStart(2, "0"));
  const names = descriptorNames(info);
  for (const rule of PRIVATE_BY_DESCRIPTOR) {
    if (names.includes(rule.name)) return privateName(rule.name);
  }
  if (type === 0x86) {
    // 0x86 is SCTE-35 in broadcast practice and DTS-HD MA on Blu-ray.
    return registrationOf(info) === "HDMV" ? "DTS-HD MA" : "SCTE-35";
  }
  if (type === 0x06) {
    const reg = registrationOf(info);
    if (reg === "AC-3" || reg === "AC3 ") return "AC-3";
    if (reg === "EAC3") return "E-AC-3";
    if (reg === "HDMV") return "PGS subtitle";
    if (reg === "CUEI") return "SCTE-35";
    if (reg === "KLVA") return "KLV metadata";
    if (reg) return "PES private data (" + reg.trim() + ")";
    return "PES private data";
  }
  return base;
}

function privateName(name) {
  if (name === "subtitling") return "DVB subtitles";
  if (name === "teletext" || name === "VBI teletext") return "Teletext";
  return name;
}

export function tablePidName(pid) {
  return TABLE_PIDS[pid] || "";
}

// Same naming from raw descriptor bytes, for the one-packet TR 101 290
// parser, which reads the PMT without building the full descriptor tree.
export function describeStreamType(type, bytes) {
  const tags = new Set();
  if (bytes && bytes.length) {
    let i = 0;
    while (i + 2 <= bytes.length) {
      const tag = bytes[i];
      const len = bytes[i + 1];
      if (i + 2 + len > bytes.length) break;
      tags.add(tag);
      i += 2 + len;
    }
  }
  const info = [];
  if (tags.has(0x59)) info.push({ tag: 0x59, name: "subtitling" });
  if (tags.has(0x56)) info.push({ tag: 0x56, name: "teletext" });
  if (tags.has(0x46)) info.push({ tag: 0x46, name: "VBI teletext" });
  if (tags.has(0x6A)) info.push({ tag: 0x6A, name: "AC-3" });
  if (tags.has(0x7A)) info.push({ tag: 0x7A, name: "E-AC-3" });
  if (tags.has(0x7C)) info.push({ tag: 0x7C, name: "AAC" });
  return { long: streamName(type, info), short: shortKind(type, info) };
}

// Short label for the PID table, where the column is narrow.
export function shortKind(type, info, pid) {
  const table = pid === undefined ? "" : tablePidName(pid);
  if (table) return table;
  if (type === 0x06) {
    const name = streamName(type, info);
    if (name === "DVB subtitles") return "DVB subtitles";
    if (name === "Teletext") return "Teletext";
    if (name === "VBI teletext") return "Teletext";
    return name;
  }
  if (type === 0x04) return "MPEG-2 audio";
  if (type === 0x03) return "MPEG-1 audio";
  return streamName(type, info);
}
