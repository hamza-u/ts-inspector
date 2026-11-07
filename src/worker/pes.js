// Reassemble one PES at a time on each H.264 PID and split access units.
// The elementary stream stays in memory only until the PES ends.

import { describeAccessUnit, splitAccessUnits, splitAnnexB } from "./h264.js";
import { payloadBytes, readDiscont, readPid } from "./tsutil.js";

const PES_PTS_MOD = 2 ** 33;
const PES_CAP = 8_000_000;

function read33(b) {
  return ((b[0] >> 1) & 7) * 2 ** 30
    + b[1] * 2 ** 22
    + (b[2] >> 1) * 2 ** 15
    + b[3] * 2 ** 7
    + (b[4] >> 1);
}

export function pesContent(payload) {
  if (!payload || payload.length < 9) return null;
  if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return null;
  if ((payload[6] & 0xC0) !== 0x80) return null;
  const flags = payload[7] >> 6;
  const total = 9 + payload[8];
  if (payload.length < total) return null;
  let pts = null;
  let dts = null;
  if (flags & 2) {
    if (total < 14) return null;
    pts = read33(payload.subarray(9, 14));
    dts = pts;
    if ((flags & 1) && total >= 19) dts = read33(payload.subarray(14, 19));
  }
  return { header: total, pts, dts, es: payload.subarray(total), streamId: payload[3] };
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function unwrap33(prev, raw) {
  if (prev === null || prev === undefined) return raw;
  const last = prev % PES_PTS_MOD;
  let d = raw - last;
  if (d < -PES_PTS_MOD / 2) d += PES_PTS_MOD;
  else if (d > PES_PTS_MOD / 2) d -= PES_PTS_MOD;
  return prev + d;
}

export function buildGops(aus) {
  const gops = [];
  let cur = null;
  for (const au of aus) {
    const frame = au.frame || "?";
    const boundary = au.idr || frame === "I";
    if (boundary || !cur) {
      if (cur) gops.push(cur);
      cur = {
        closed: au.idr ? 1 : 0,
        pattern: frame,
        start: au.idx,
        length: 1,
        packetIndex: au.firstPacket,
      };
    } else {
      if (cur.pattern.length < 64) cur.pattern += frame;
      cur.length += 1;
    }
    if (gops.length >= 500) break;
  }
  if (cur && gops.length < 500) gops.push(cur);
  return gops;
}

export function createVideo() {
  const pids = new Set();
  const pidInfo = new Map();
  const open = new Map();
  const aus = [];
  const packets = [];
  let idx = 0;

  function info(pid) {
    let row = pidInfo.get(pid);
    if (!row) {
      row = { hrd: null, spsById: new Map(), prevSpsKey: null, dtsUw: null, ptsUw: null, headerLeft: 0 };
      pidInfo.set(pid, row);
    }
    return row;
  }

  function sync(tree) {
    for (const pmt of tree.pmts || []) {
      for (const stream of pmt.streams || []) {
        if (stream.type !== 0x1B) continue;
        pids.add(stream.pid);
        const row = info(stream.pid);
        if (stream.hrdManagementValid === 0 || stream.hrdManagementValid === 1) {
          row.hrd = stream.hrdManagementValid;
        }
      }
    }
  }

  function finishPes(pid) {
    const st = open.get(pid);
    if (!st || !st.buf.length) return;
    const bytes = concat(st.buf);
    const row = info(pid);
    const first = st.first;
    const last = st.last;
    const discont = st.discont;
    st.buf = [];
    st.len = 0;
    st.discont = false;
    const parsed = pesContent(bytes);
    if (!parsed) return;
    let pts = parsed.pts;
    let dts = parsed.dts;
    if (pts !== null) {
      row.ptsUw = unwrap33(row.ptsUw, pts);
      pts = row.ptsUw;
    }
    if (dts !== null) {
      row.dtsUw = unwrap33(row.dtsUw, dts);
      dts = row.dtsUw;
    }
    const parts = splitAccessUnits(parsed.es);
    let firstAu = true;
    for (const part of parts) {
      if (!part.length || !splitAnnexB(part).length) continue;
      const desc = describeAccessUnit(part, row.spsById);
      const key = desc.sps
        ? [desc.sps.spsId, desc.sps.profile, desc.sps.bitRate, desc.sps.cpbSize].join(":")
        : null;
      const neu = !!(key && row.prevSpsKey && key !== row.prevSpsKey);
      if (key) row.prevSpsKey = key;
      aus.push({
        idx: idx,
        pid,
        sizeB: part.length,
        firstPacket: first,
        lastPacket: last,
        discont: firstAu && discont ? 1 : 0,
        newSps: neu ? 1 : 0,
        dts: firstAu && dts !== null ? dts / 90000 : null,
        pts: firstAu && pts !== null ? pts / 90000 : null,
        bp: desc.bp,
        cpbRemovalDelay: desc.pt ? desc.pt.cpbRemovalDelay : null,
        dpbOutputDelay: desc.pt ? desc.pt.dpbOutputDelay : null,
        picStruct: desc.pt ? desc.pt.picStruct : null,
        sps: desc.sps,
        pps: desc.pps,
        frame: desc.frame,
        idr: desc.idr ? 1 : 0,
        nalTypes: desc.nalTypes,
        sliceType: desc.slice ? desc.slice.sliceType : null,
        captions: desc.captions,
      });
      if (desc.captions) {
        const seenRow = info(pid);
        seenRow.captions = seenRow.captions || { messages: 0, pairs: 0, cea608: false, cea708: false };
        seenRow.captions.messages += desc.captions.messages;
        seenRow.captions.pairs += desc.captions.pairs;
        seenRow.captions.cea608 = seenRow.captions.cea608 || desc.captions.cea608;
        seenRow.captions.cea708 = seenRow.captions.cea708 || desc.captions.cea708;
      }
      idx += 1;
      firstAu = false;
    }
  }

  return {
    sync,
    push(pkt, index, pcrSec) {
      const pid = readPid(pkt);
      if (!pids.has(pid)) return;
      const row = info(pid);
      const pusi = (pkt[1] & 0x40) !== 0;
      const payload = payloadBytes(pkt);
      const plen = payload ? payload.length : 0;
      let st = open.get(pid);
      if (pusi) {
        finishPes(pid);
        st = { buf: [], len: 0, first: index, last: index, discont: readDiscont(pkt) };
        open.set(pid, st);
        if (payload && payload.length >= 9 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
          row.headerLeft = 9 + payload[8];
        } else row.headerLeft = 0;
      } else if (!st) {
        return;
      } else {
        st.last = index;
        if (readDiscont(pkt)) st.discont = true;
      }
      if (payload && payload.length && st.len < PES_CAP) {
        st.buf.push(payload.slice());
        st.len += payload.length;
      }
      let hdr = 0;
      let es = 0;
      if (plen) {
        hdr = Math.min(row.headerLeft, plen);
        es = plen - hdr;
        row.headerLeft -= hdr;
      }
      packets.push({
        t: pcrSec === undefined ? null : pcrSec,
        drop: pkt.length - plen,
        hdr,
        es,
        packetIndex: index,
        pid,
      });
    },
    finish() {
      for (const pid of pids) finishPes(pid);
      const byPid = new Map();
      for (const au of aus) {
        if (!byPid.has(au.pid)) byPid.set(au.pid, []);
        byPid.get(au.pid).push(au);
      }
      const streams = [];
      for (const pid of pids) {
        const row = info(pid);
        const list = byPid.get(pid) || [];
        const sps = [];
        const seen = new Set();
        const pps = [];
        const seenPps = new Set();
        for (const au of list) {
          if (au.sps) {
            const key = au.sps.spsId + ":" + au.sps.bitRate;
            if (!seen.has(key)) {
              seen.add(key);
              sps.push(au.sps);
            }
          }
          if (au.pps && !seenPps.has(au.pps.ppsId)) {
            seenPps.add(au.pps.ppsId);
            pps.push(au.pps);
          }
        }
        streams.push({
          pid,
          hrdManagementValid: row.hrd,
          captions: row.captions || null,
          aus: list,
          packets: packets.filter((p) => p.pid === pid),
          sps,
          pps,
          gops: buildGops(list),
        });
      }
      return { aus, streams };
    },
  };
}
