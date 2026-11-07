// Build a small MPEG-TS for FFmpeg from the packets it actually needs.
// A 225 MB capture is mostly null padding and the video PID; an audio
// decode only needs that PID's packets plus one PAT and one PMT. Reading
// goes through File.slice in packet-aligned steps, so the whole file never
// sits in memory, and the size stops being a limit.

const TS = 188;

export function framingOf(report) {
  const f = (report && report.framing) || {};
  return { size: f.size || 188, align: f.align || 0 };
}

function packetIndexAt(offset, framing) {
  return Math.floor((offset - framing.align) / framing.size);
}

function tableIdOf(payload) {
  if (!payload || !payload.length) return null;
  const pointer = payload[0];
  const at = 1 + pointer;
  if (at >= payload.length) return null;
  return {
    id: payload[at],
    section: payload.subarray(at),
  };
}

async function readPackets(file, framing, from, to) {
  const first = Math.max(0, from);
  const last = Math.max(first, to);
  const startByte = first * framing.size + framing.align;
  const endByte = last * framing.size + framing.align;
  const buf = new Uint8Array(await file.slice(startByte, endByte).arrayBuffer());
  return { buf, first };
}

function sectionLength(section) {
  return ((section[1] & 0x0F) << 8) | section[2];
}

// One PAT and one PMT, taken from the first few MB. Both repeat every few
// hundred milliseconds, so the head of the file always has them.
export async function findPsi(file, framing, limitPackets = 20000) {
  const total = Math.floor(file.size / framing.size);
  const to = Math.min(total, limitPackets);
  let patPkt = null;
  let pmtPid = null;
  let pmtPkt = null;
  const step = 4096;
  for (let from = 0; from < to && !(patPkt && pmtPkt); from += step) {
    const { buf, first } = await readPackets(file, framing, from, Math.min(to, from + step));
    for (let i = 0; i * framing.size + TS <= buf.length; i++) {
      const off = i * framing.size;
      if (buf[off] !== 0x47) continue;
      const pusi = (buf[off + 1] & 0x40) !== 0;
      if (!pusi) continue;
      const pid = ((buf[off + 1] & 0x1F) << 8) | buf[off + 2];
      if (pid === 0x1FFF) continue;
      const afc = (buf[off + 3] >> 4) & 3;
      if (!(afc & 1)) continue;
      const po = afc & 2 ? 5 + buf[off + 4] : 4;
      if (po >= TS) continue;
      const t = tableIdOf(buf.subarray(off + po, off + TS));
      if (!t) continue;
      const pkt = buf.slice(off, off + TS);
      if (pid === 0 && t.id === 0x00 && !patPkt) {
        patPkt = pkt;
        const body = t.section.subarray(8, 8 + sectionLength(t.section) - 4);
        for (let k = 0; k + 4 <= body.length; k += 4) {
          const program = (body[k] << 8) | body[k + 1];
          if (program !== 0) {
            pmtPid = ((body[k + 2] & 0x1F) << 8) | body[k + 3];
            break;
          }
        }
      } else if (pmtPid !== null && pid === pmtPid && t.id === 0x02 && !pmtPkt) {
        pmtPkt = pkt;
      }
      if (patPkt && pmtPkt) return { patPkt, pmtPkt, pmtPid, scanned: first + i + 1 };
    }
  }
  return { patPkt, pmtPkt, pmtPid, scanned: to };
}

// Every packet of the listed PIDs between two packet indexes, in order. Pass
// -1 to take every PID (used for the stills windows). Order is what keeps a
// continuity counter valid: nothing of a kept PID is dropped.

export async function collectPid(file, framing, pid, from, to, onProgress) {
  const total = Math.floor(file.size / framing.size);
  const first = Math.max(0, from);
  const last = Math.min(total, to);
  const out = [];
  const step = 8192;
  for (let i = first; i < last; i += step) {
    const end = Math.min(last, i + step);
    const { buf } = await readPackets(file, framing, i, end);
    for (let k = 0; k < end - i; k++) {
      const off = k * framing.size;
      if (off + TS > buf.length || buf[off] !== 0x47) continue;
      const p = ((buf[off + 1] & 0x1F) << 8) | buf[off + 2];
      if (pid >= 0 && p !== pid) continue;
      out.push(buf.slice(off, off + TS));
    }
    if (onProgress) onProgress(end, last);
  }
  return out;
}

export function joinPackets(list) {
  let n = 0;
  for (const p of list) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of list) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// The parameter sets usually sit at the start of the head, before the first
// IDR. A window that begins mid-file needs them, so they are carried into
// every mini stream.
export async function findParameterSets(file, framing, limitPackets = 200000) {
  const total = Math.floor(file.size / framing.size);
  const to = Math.min(total, limitPackets);
  const out = [];
  const step = 8192;
  for (let i = 0; i < to; i += step) {
    const end = Math.min(to, i + step);
    const { buf } = await readPackets(file, framing, i, end);
    for (let k = 0; k < end - i; k++) {
      const off = k * framing.size;
      if (off + TS > buf.length || buf[off] !== 0x47) continue;
      const pid = ((buf[off + 1] & 0x1F) << 8) | buf[off + 2];
      if (!out.pid) out.pid = pid;
      if (pid !== out.pid) continue;
      out.push(buf.slice(off, off + TS));
      if (out.length > 64) return out;
    }
  }
  out.length = 0;
  return out;
}

// A mini TS: the parameter sets, then the PAT and PMT, then the packets asked
// for. FFmpeg needs all three to find the video stream.
export async function miniTs(file, framing, psi, parts) {
  const packets = [];
  for (const p of psi.parameterSets || []) packets.push(p);
  if (psi.pmtPkt) packets.push(psi.pmtPkt);
  if (psi.patPkt) packets.push(psi.patPkt);
  for (const list of parts) packets.push(...list);
  return joinPackets(packets);
}

export function packetIndexFromOffset(offset, framing) {
  return packetIndexAt(offset, framing);
}
