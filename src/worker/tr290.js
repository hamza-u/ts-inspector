// ETSI TR 101 290 style checks for a stored transport stream.
// This is not a certified conformance checker. IAT, MDI and RTP are omitted.
// Media time starts at 0. A zero timestamp means "not set" for the one-second
// window and the last-PAT time, so checks run on (media time + 1 second).

import { crc32Mpeg } from "./crc.js";
import { describeStreamType, tablePidName } from "./stream-type.js";
import { TS_SIZE } from "./tsutil.js";

export const TIME_BIAS = 1;

const CHECKS = [
  ["TS_sync_loss", 1, ""],
  ["Sync_byte_error", 1, ""],
  ["PAT_error", 1, ""],
  ["Continuity_count_error", 1, ""],
  ["PMT_error", 1, ""],
  ["PID_error", 1, ""],
  ["Transport_error", 2, ""],
  ["CRC_error", 2, ""],
  ["PCR_repetition_error", 2, "interval > 40 ms"],
  ["PCR_discontinuity_error", 2, "jump > 100 ms w/o flag"],
  ["PCR_accuracy_error", 2, "informational: kernel ts"],
  ["PTS_error", 2, "PTS repetition > 700 ms"],
  ["CAT_error", 2, ""],
  ["Datagram_gap", 2, "informational: datagram IAT > 100 ms"],
  ["NIT_error", 3, "NIT actual absent for > 10 s"],
  ["SI_repetition_error", 3, "SI section repeated in under 25 ms"],
  ["Unreferenced_PID", 3, "PID not in a PMT for > 0.5 s"],
  ["SDT_error", 3, "SDT actual absent for > 2 s"],
  ["EIT_error", 3, "EIT present/following absent for > 2 s"],
  ["RST_error", 3, "RST absent for > 2 s after it was used"],
  ["TDT_error", 3, "TDT/TOT absent for > 30 s"],
  ["Buffer_error", 3, "TB, MB or EB overflow"],
  ["Empty_buffer_error", 3, "EB underflow, or TB not empty within 1 s"],
  ["Data_delay_error", 3, "access unit delay above 10 s"],
];

const STREAM_KIND = {
  0x1B: "H.264",
  0x24: "HEVC",
  0x02: "MPEG-2 video",
  0x03: "MPEG-1 audio",
  0x04: "MPEG-2 audio",
  0x0F: "AAC",
  0x11: "AAC",
  0x81: "AC-3",
  0x84: "E-AC-3",
  0x86: "SCTE-35",
};

// Types that carry audio, so the timeline can offer a level lane for them.
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0F, 0x11, 0x81, 0x84, 0x87, 0x8A, 0x1C]);

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function createTr290() {
  const checks = {};
  for (const [name, prio, note] of CHECKS) {
    checks[name] = { name, prio, note, count: 0, last: 0 };
  }
  const pids = new Map();
  const pmtPids = new Set();
  const esPids = new Set();
  const events = [];
  let pkts = 0;
  let bytes = 0;
  let bytesCur = 0;
  let bitrate = 0;
  let winStart = null;
  let lastPacket = null;
  let pcrPid = -1;
  let lastPat = 0;
  let lastPmt = 0;
  let lastPcr = -1;
  let lastPcrAt = 0;
  let pcrMax = 0;
  let lastNit = 0;
  let lastSdt = 0;
  let lastEit = 0;
  let lastTdt = 0;
  let lastRst = 0;
  let seenRst = false;
  const lastSi = new Map();

  function event(now, prio, name, detail, packetIndex) {
    if (events.length >= 2000) events.shift();
    events.push({ t: now, prio, name, detail: detail || "", packetIndex });
  }

  function hit(key, t, detail, packetIndex, mediaNow) {
    const c = checks[key];
    c.count += 1;
    c.last = t;
    event(mediaNow, c.prio, key, detail, packetIndex);
  }

  function classify(pid) {
    if (pid === 0x0000) return "PAT";
    if (pid === 0x0001) return "CAT";
    if (pid === 0x1FFF) return "null";
    if (pmtPids.has(pid)) return "PMT";
    // A well-known table PID is named for the table it carries, so the PID
    // list never shows a bare question mark for NIT, SDT or EIT.
    const table = tablePidName(pid);
    if (table) return table;
    return "?";
  }

  function pidState(pid) {
    let st = pids.get(pid);
    if (!st) {
      st = {
        cc: -1, bytesCur: 0, bytesPrev: 0, ccErrs: 0, scrambled: 0,
        lastSeen: 0, kind: classify(pid), lastPtsWall: 0, firstSeen: 0, unref: false,
      };
      pids.set(pid, st);
    }
    return st;
  }

  function intervalChecks(t) {
    if (lastPat && t - lastPat > 0.5) {
      hit("PAT_error", t, "PAT interval > 0.5 s", -1, t - TIME_BIAS);
    }
    if (pmtPids.size && lastPmt && t - lastPmt > 0.5) {
      hit("PMT_error", t, "PMT interval > 0.5 s", -1, t - TIME_BIAS);
    }
    for (const pid of esPids) {
      const st = pids.get(pid);
      if (st && st.lastSeen && t - st.lastSeen > 5) {
        hit("PID_error", t, "pid " + pid + " silent", -1, t - TIME_BIAS);
      }
    }
    for (const pid of esPids) {
      const st = pids.get(pid);
      if (st && st.lastPtsWall && t - st.lastPtsWall > 0.7) {
        hit("PTS_error", t, "pid " + pid, -1, t - TIME_BIAS);
        st.lastPtsWall = t;
      }
    }
    const media = t - TIME_BIAS;
    const late = (last, limit, key, detail) => {
      if (media <= limit) return;
      if (!last || t - last > limit) hit(key, t, detail, -1, media);
    };
    late(lastNit, 10, "NIT_error", "NIT interval > 10 s");
    late(lastSdt, 2, "SDT_error", "SDT interval > 2 s");
    late(lastEit, 2, "EIT_error", "EIT p/f interval > 2 s");
    late(lastTdt, 30, "TDT_error", "TDT/TOT interval > 30 s");
    if (seenRst) late(lastRst, 2, "RST_error", "RST interval > 2 s");
  }

  function onSi(data, pid, t, packetIndex, mediaNow) {
    if (!data.length) return;
    const ptr = data[0];
    if (1 + ptr >= data.length) return;
    const s = data.subarray(1 + ptr);
    if (s.length < 3) return;
    const tableId = s[0];
    const bad = (pid === 0x10 && tableId !== 0x40 && tableId !== 0x41 && tableId !== 0x72)
      || (pid === 0x11 && tableId !== 0x42 && tableId !== 0x46 && tableId !== 0x4A && tableId !== 0x72)
      || (pid === 0x12 && (tableId < 0x4E || tableId > 0x6F) && tableId !== 0x72)
      || (pid === 0x13 && tableId !== 0x71 && tableId !== 0x72)
      || (pid === 0x14 && tableId !== 0x70 && tableId !== 0x73 && tableId !== 0x72);
    if (bad) {
      const key = pid === 0x10 ? "NIT_error"
        : pid === 0x11 ? "SDT_error"
          : pid === 0x12 ? "EIT_error"
            : pid === 0x14 ? "TDT_error" : "RST_error";
      hit(key, t, "table_id 0x" + tableId.toString(16), packetIndex, mediaNow);
    }
    if (pid !== 0x12) {
      const prev = lastSi.get(pid) || 0;
      if (prev && t - prev > 0 && t - prev < 0.025) {
        hit("SI_repetition_error", t, "pid " + pid, packetIndex, mediaNow);
      }
      lastSi.set(pid, t);
    }
    if (pid === 0x10 && (tableId === 0x40 || tableId === 0x41)) lastNit = t;
    if (pid === 0x11 && (tableId === 0x42 || tableId === 0x46)) lastSdt = t;
    if (pid === 0x12 && (tableId === 0x4E || tableId === 0x4F)) lastEit = t;
    if (pid === 0x14 && (tableId === 0x70 || tableId === 0x73)) lastTdt = t;
    if (pid === 0x13 && tableId === 0x71) {
      seenRst = true;
      lastRst = t;
    }
  }

  function onPcr(pkt, pid, t, packetIndex, mediaNow) {
    const b0 = pkt[6], b1 = pkt[7], b2 = pkt[8], b3 = pkt[9], b4 = pkt[10], b5 = pkt[11];
    const base = b0 * 33554432 + b1 * 131072 + b2 * 512 + b3 * 2 + (b4 >> 7);
    const ext = (b4 & 1) * 256 + b5;
    const pcr = base * 300 + ext;
    if (pcrPid < 0) pcrPid = pid;
    if (lastPcr >= 0) {
      const d27 = pcr - lastPcr;
      const dms = d27 / 27000;
      if (dms > pcrMax) pcrMax = dms;
      if (dms > 40) {
        hit("PCR_repetition_error", t, dms.toFixed(1) + " ms", packetIndex, mediaNow);
      }
      if (dms < 0 || dms > 100) {
        hit("PCR_discontinuity_error", t, dms.toFixed(1) + " ms", packetIndex, mediaNow);
      }
    }
    lastPcr = pcr;
    lastPcrAt = t;
  }

  function onSection(data, pid, t, packetIndex, mediaNow) {
    if (!data.length) return;
    const ptr = data[0];
    const s = data.subarray(1 + ptr);
    if (s.length < 8) return;
    const tableId = s[0];
    if (pid === 0x0000) {
      lastPat = t;
      if (tableId !== 0x00) {
        hit("PAT_error", t, "table_id 0x" + tableId.toString(16).padStart(2, "0"), packetIndex, mediaNow);
        return;
      }
    }
    const secLen = ((s[1] & 0x0F) << 8) | s[2];
    if (s.length < 3 + secLen || secLen < 9) return;
    const sec = s.subarray(0, 3 + secLen);
    if (crc32Mpeg(sec) !== 0) {
      hit("CRC_error", t, "pid " + pid + " table 0x" + tableId.toString(16).padStart(2, "0"), packetIndex, mediaNow);
      return;
    }
    const body = sec.subarray(8, sec.length - 4);
    if (tableId === 0x00) {
      for (let i = 0; i + 4 <= body.length; i += 4) {
        const prog = (body[i] << 8) | body[i + 1];
        const p = ((body[i + 2] & 0x1F) << 8) | body[i + 3];
        if (prog !== 0 && !pmtPids.has(p)) {
          pmtPids.add(p);
          const existing = pids.get(p);
          if (existing) existing.kind = "PMT";
        }
      }
    } else if (tableId === 0x02 && pmtPids.has(pid)) {
      lastPmt = t;
      if (body.length < 4) return;
      pcrPid = ((body[0] & 0x1F) << 8) | body[1];
      const piLen = ((body[2] & 0x0F) << 8) | body[3];
      let i = 4 + piLen;
      while (i + 5 <= body.length) {
        const stype = body[i];
        const epid = ((body[i + 1] & 0x1F) << 8) | body[i + 2];
        const esLen = ((body[i + 3] & 0x0F) << 8) | body[i + 4];
        esPids.add(epid);
        const named = describeStreamType(stype, body.subarray(i + 5, i + 5 + esLen));
        const kind = named.short;
        const existing = pids.get(epid);
        if (existing) {
          existing.kind = kind;
          existing.type = stype;
          existing.long = named.long;
          existing.audio = AUDIO_TYPES.has(stype);
        } else {
          pids.set(epid, {
            cc: -1, bytesCur: 0, bytesPrev: 0, ccErrs: 0, scrambled: 0,
            lastSeen: 0, kind, type: stype, long: named.long, audio: AUDIO_TYPES.has(stype),
            lastPtsWall: 0, firstSeen: 0, unref: false,
          });
        }
        i += 5 + esLen;
      }
    }
  }

  function onPusi(pkt, off, pid, st, scr, t, packetIndex, mediaNow) {
    const data = pkt.subarray(off);
    if (pid === 0x0000 || pid === 0x0001) {
      onSection(data, pid, t, packetIndex, mediaNow);
      return;
    }
    if (pid === 0x0010 || pid === 0x0011 || pid === 0x0012 || pid === 0x0013 || pid === 0x0014) {
      onSi(data, pid, t, packetIndex, mediaNow);
      return;
    }
    if (pmtPids.has(pid)) {
      if (scr) hit("PMT_error", t, "PMT scrambled", packetIndex, mediaNow);
      onSection(data, pid, t, packetIndex, mediaNow);
      return;
    }
    if (data.length >= 14 && data[0] === 0 && data[1] === 0 && data[2] === 1) {
      const flags = data[7] >> 6;
      if (flags & 0x2) {
        st.lastPtsWall = t;
      }
    }
  }

  function packet(pkt, t, packetIndex, mediaNow) {
    if (pkt[0] !== 0x47) {
      hit("Sync_byte_error", t, "", packetIndex, mediaNow);
      return;
    }
    const tei = pkt[1] & 0x80;
    const pusi = pkt[1] & 0x40;
    const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
    const scr = (pkt[3] >> 6) & 0x3;
    const afc = (pkt[3] >> 4) & 0x3;
    const cc = pkt[3] & 0x0F;
    const st = pidState(pid);
    st.bytesCur += TS_SIZE;
    st.lastSeen = t;
    if (!st.firstSeen) st.firstSeen = t;
    if (scr) st.scrambled += 1;
    if (tei) {
      hit("Transport_error", t, "pid " + pid, packetIndex, mediaNow);
      return;
    }
    if (pid !== 0x1FFF) {
      let discont = false;
      let payloadOff = 4;
      if (afc & 0x2) {
        const afLen = pkt[4];
        payloadOff = 5 + afLen;
        if (afLen > 0 && (pkt[5] & 0x80)) discont = true;
        if (afLen >= 7 && (pkt[5] & 0x10)) onPcr(pkt, pid, t, packetIndex, mediaNow);
      }
      if (afc & 0x1) {
        if (st.cc >= 0 && !discont) {
          const exp = (st.cc + 1) & 0xF;
          if (cc !== exp) {
            st.ccErrs += 1;
            hit("Continuity_count_error", t, "pid " + pid + " exp " + exp + " got " + cc, packetIndex, mediaNow);
          }
        }
        st.cc = cc;
        if (pusi && payloadOff < TS_SIZE) {
          onPusi(pkt, payloadOff, pid, st, scr, t, packetIndex, mediaNow);
        }
      }
    }
    if (pid > 0x001F && pid !== 0x1FFF && lastPmt && !esPids.has(pid) && !pmtPids.has(pid) && !st.unref) {
      if (t - st.firstSeen > 0.5) {
        st.unref = true;
        hit("Unreferenced_PID", t, "pid " + pid, packetIndex, mediaNow);
      }
    }
  }

  return {
    feed(pkt, now, packetIndex) {
      const t = now + TIME_BIAS;
      if (lastPacket !== null) {
        const dt = t - lastPacket;
        if (dt > 0.1) hit("Datagram_gap", t, (dt * 1000).toFixed(1) + " ms", packetIndex, now);
      }
      lastPacket = t;
      packet(pkt, t, packetIndex, now);
      pkts += 1;
      bytes += pkt.length;
      bytesCur += pkt.length;
      if (winStart === null) winStart = t;
      if (t - winStart >= 1) {
        const dt = t - winStart;
        bitrate = Math.trunc(bytesCur * 8 / dt);
        for (const st of pids.values()) {
          st.bytesPrev = Math.trunc(st.bytesCur / dt);
          st.bytesCur = 0;
        }
        bytesCur = 0;
        winStart = t;
        intervalChecks(t);
      }
    },
    events() {
      return events;
    },
    addCount(key, n, detail, packetIndex, mediaNow) {
      if (!n || !checks[key]) return;
      checks[key].count += n;
      event(mediaNow || 0, checks[key].prio, key, detail || "", packetIndex);
    },
    snapshot() {
      const rows = [];
      const ids = [...pids.keys()].sort((a, b) => a - b);
      for (const pid of ids) {
        const st = pids.get(pid);
        rows.push({
          pid,
          kind: st.kind,
          type: st.type === undefined ? null : st.type,
          long: st.long || st.kind,
          cc_errs: st.ccErrs,
          scrambled: st.scrambled,
          pcr: pid === pcrPid,
        });
      }
      const checkMap = {};
      for (const [name] of CHECKS) checkMap[name] = checks[name].count;
      return {
        pkts,
        bytes,
        pcr_pid: pcrPid,
        pcr_max_interval_ms: round2(pcrMax),
        checks: checkMap,
        pids: rows,
        bitrate,
      };
    },
  };
}
