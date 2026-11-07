// H.264 Annex B split, SPS through the VUI (Annex E), buffering-period and
// picture-timing SEI (D.1). SchedSelIdx 0 is the one the chain uses.
// High-profile scaling lists are skipped, not stored: a wrong skip shifts
// every later field, including the HRD.

import { createBits, stripEpb } from "./bits.js";

export const HIGH_PROFILES = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
]);

export const PROFILE_NAME = {
  66: "Baseline", 77: "Main", 88: "Extended", 100: "High",
  110: "High 10", 122: "High 4:2:2", 244: "High 4:4:4", 44: "CAVLC 4:4:4",
};

const SLICE_NAME = ["P", "B", "I", "SP", "SI"];

export function sliceName(sliceType) {
  if (sliceType === null || sliceType === undefined) return "?";
  return SLICE_NAME[sliceType % 5] || "?";
}

function skipScalingList(br, n) {
  let last = 8;
  let next = 8;
  for (let i = 0; i < n; i++) {
    if (next !== 0) {
      const delta = br.se();
      next = ((last + delta + 256) % 256 + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

function parseHrd(br) {
  const cnt = br.ue() + 1;
  if (cnt < 1 || cnt > 32) throw new Error("cpb_cnt " + cnt);
  const brScale = br.u(4);
  const cpbScale = br.u(4);
  const scheds = [];
  for (let i = 0; i < cnt; i++) {
    const brV = br.ue() + 1;
    const cpbV = br.ue() + 1;
    const cbr = br.u(1);
    scheds.push({
      bitRate: brV * 2 ** (6 + brScale),
      cpbSize: cpbV * 2 ** (4 + cpbScale),
      cbrFlag: cbr,
    });
  }
  return {
    cpbCnt: cnt,
    scheds,
    initialCpbRemovalDelayLength: br.u(5) + 1,
    cpbRemovalDelayLength: br.u(5) + 1,
    dpbOutputDelayLength: br.u(5) + 1,
    timeOffsetLength: br.u(5),
  };
}

function parseVui(br) {
  if (br.u(1)) {
    if (br.u(8) === 255) {
      br.u(16);
      br.u(16);
    }
  }
  if (br.u(1)) br.u(1);
  if (br.u(1)) {
    br.u(3);
    br.u(1);
    if (br.u(1)) {
      br.u(8);
      br.u(8);
      br.u(8);
    }
  }
  if (br.u(1)) {
    br.ue();
    br.ue();
  }
  let timing = null;
  if (br.u(1)) {
    const num = br.u(32);
    const scale = br.u(32);
    const fixed = br.u(1);
    timing = {
      numUnitsInTick: num,
      timeScale: scale,
      fixedFrameRateFlag: fixed,
      tc: scale ? num / scale : null,
    };
  }
  const nal = br.u(1) ? parseHrd(br) : null;
  const vcl = br.u(1) ? parseHrd(br) : null;
  const low = nal || vcl ? br.u(1) : null;
  const picStruct = br.u(1);
  if (br.u(1)) {
    br.u(1);
    for (let i = 0; i < 6; i++) br.ue();
  }
  return { nal, vcl, low, picStruct, timing };
}

export function parseSps(rbsp) {
  try {
    const br = createBits(rbsp);
    const profile = br.u(8);
    const constraint = br.u(8);
    const level = br.u(8);
    const spsId = br.ue();
    let chroma = 1;
    if (HIGH_PROFILES.has(profile)) {
      chroma = br.ue();
      if (chroma === 3) br.u(1);
      br.ue();
      br.ue();
      br.u(1);
      if (br.u(1)) {
        const nlist = chroma === 3 ? 12 : 8;
        for (let i = 0; i < nlist; i++) {
          if (br.u(1)) skipScalingList(br, i < 6 ? 16 : 64);
        }
      }
    }
    const log2MaxFrameNumMinus4 = br.ue();
    const poc = br.ue();
    if (poc === 0) br.ue();
    else if (poc === 1) {
      br.u(1);
      br.se();
      br.se();
      const n = br.ue();
      for (let i = 0; i < n; i++) br.se();
    } else if (poc !== 2) {
      return null;
    }
    br.ue();
    br.u(1);
    const widthMbs = br.ue() + 1;
    const heightMap = br.ue() + 1;
    const frameMbsOnly = br.u(1);
    if (!frameMbsOnly) br.u(1);
    br.u(1);
    if (br.u(1)) {
      for (let i = 0; i < 4; i++) br.ue();
    }
    let vui = null;
    if (br.u(1)) vui = parseVui(br);
    const nal = vui ? vui.nal : null;
    const vcl = vui ? vui.vcl : null;
    const which = nal ? "nal" : (vcl ? "vcl" : null);
    const hrd = nal || vcl || null;
    const sched = hrd && hrd.scheds.length ? hrd.scheds[0] : null;
    return {
      profile,
      profileName: PROFILE_NAME[profile] || ("profile " + profile),
      constraint,
      level,
      spsId,
      chromaFormatIdc: chroma,
      log2MaxFrameNumMinus4,
      width: widthMbs * 16,
      height: (2 - frameMbsOnly) * heightMap * 16,
      nalHrd: nal,
      vclHrd: vcl,
      hrd,
      whichHrd: which,
      lowDelayHrdFlag: vui ? vui.low : null,
      picStructPresentFlag: vui ? vui.picStruct : 0,
      timing: vui ? vui.timing : null,
      bitRate: sched ? sched.bitRate : null,
      cpbSize: sched ? sched.cpbSize : null,
      cbrFlag: sched ? sched.cbrFlag : null,
    };
  } catch (err) {
    return null;
  }
}

export function parsePps(rbsp) {
  try {
    const br = createBits(rbsp);
    return { ppsId: br.ue(), spsId: br.ue() };
  } catch (err) {
    return null;
  }
}

export function parseSliceHeader(rbsp) {
  try {
    const br = createBits(rbsp);
    const firstMb = br.ue();
    const sliceType = br.ue();
    const ppsId = br.ue();
    return { firstMb, sliceType, ppsId, frame: sliceName(sliceType) };
  } catch (err) {
    return null;
  }
}

function seiInt(data, p) {
  if (p >= data.length) return null;
  let val = 0;
  while (p < data.length && data[p] === 0xFF) {
    val += 255;
    p += 1;
    if (val > 8_000_000) return null;
  }
  if (p >= data.length) return null;
  return { val: val + data[p], p: p + 1 };
}

function readBpRows(br, hrd) {
  if (!hrd) return null;
  const n = hrd.initialCpbRemovalDelayLength;
  const rows = [];
  for (let i = 0; i < hrd.cpbCnt; i++) rows.push([br.u(n), br.u(n)]);
  return rows;
}

function parseBp(payload, spsById, fallback) {
  const br = createBits(payload);
  const spsId = br.ue();
  const ref = spsById.get(spsId) || fallback;
  if (!ref || !(ref.nalHrd || ref.vclHrd)) return null;
  const nalRows = readBpRows(br, ref.nalHrd);
  const vclRows = readBpRows(br, ref.vclHrd);
  const rows = ref.whichHrd === "nal" ? nalRows : vclRows;
  if (!rows || !rows.length) return null;
  return { spsId, delay: rows[0][0], offset: rows[0][1], rows };
}

function parsePt(payload, sps) {
  if (!sps) return null;
  const br = createBits(payload);
  const hrd = sps.hrd;
  let cpb = null;
  let dpb = null;
  let pic = null;
  if (hrd && (sps.nalHrd || sps.vclHrd)) {
    cpb = br.u(hrd.cpbRemovalDelayLength);
    dpb = br.u(hrd.dpbOutputDelayLength);
  }
  if (sps.picStructPresentFlag) pic = br.u(4);
  return { cpbRemovalDelay: cpb, dpbOutputDelay: dpb, picStruct: pic };
}

export function parseSei(rbsp, spsById, active) {
  const data = rbsp instanceof Uint8Array ? rbsp : Uint8Array.from(rbsp || []);
  let bp = null;
  let pt = null;
  let captions = null;
  let p = 0;
  while (p + 1 < data.length) {
    const t = seiInt(data, p);
    if (!t) break;
    p = t.p;
    const s = seiInt(data, p);
    if (!s || s.val < 0 || p + s.val > data.length) break;
    const payload = data.subarray(s.p, s.p + s.val);
    p = s.p + s.val;
    try {
      if (t.val === 0 && !bp) bp = parseBp(payload, spsById, active);
      else if (t.val === 1 && !pt) {
        const ref = bp ? (spsById.get(bp.spsId) || active) : active;
        pt = parsePt(payload, ref);
      } else if (t.val === 4) {
        captions = mergeCaptionSei(captions, parseCaptionSei(payload));
      }
    } catch (err) {
      // A bad message does not hide the ones already read.
    }
  }
  return { bp, pt, captions };
}

// SEI payload type 4 carries either ATSC A/53 closed captions (user data
// registered with the GA94 identifier) or the SCTE-128 / other private forms.
// Only the identifier and the presence of cc_data are read here; the captions
// themselves are decoded by CCExtractor when the user asks for them. Counting
// the messages is what tells the page there is something to ask for.
export function parseCaptionSei(payload) {
  if (!payload || payload.length < 10) return null;
  // itu_t_t35_country_code 0xB5 (United States), provider 0x0031, then "GA94".
  if (payload[0] !== 0xB5 || payload[1] !== 0x00 || payload[2] !== 0x31) return null;
  if (payload[3] !== 0x47 || payload[4] !== 0x41 || payload[5] !== 0x39 || payload[6] !== 0x34) return null;
  const type = payload[7];
  if (type !== 0x03) return null;
  const flags = payload[8];
  const count = flags & 0x1F;
  const starts = (flags & 0x40) !== 0;
  const packets = [];
  let at = 10;
  for (let i = 0; i < count && at + 3 <= payload.length; i++) {
    const head = payload[at];
    const ccValid = (head & 0x04) !== 0;
    const ccType = head & 0x03;
    if (ccValid) packets.push(ccType);
    at += 3;
  }
  const cea608 = packets.some((ccType) => ccType === 0 || ccType === 1);
  const cea708 = packets.some((ccType) => ccType === 2 || ccType === 3);
  return { messages: 1, starts, pairs: packets.length, cea608, cea708 };
}

function mergeCaptionSei(into, add) {
  if (!add) return into;
  if (!into) return add;
  into.messages += 1;
  into.pairs += add.pairs;
  into.cea608 = into.cea608 || add.cea608;
  into.cea708 = into.cea708 || add.cea708;
  return into;
}

export function splitAnnexB(es) {
  const buf = es instanceof Uint8Array ? es : Uint8Array.from(es || []);
  const marks = [];
  for (let i = 0; i + 3 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const zero = i > 0 && buf[i - 1] === 0 ? i - 1 : i;
      marks.push({ sc: i, start: zero });
      i += 2;
    }
  }
  const nals = [];
  for (let i = 0; i < marks.length; i++) {
    const sc = marks[i].sc;
    const next = i + 1 < marks.length ? marks[i + 1].start : buf.length;
    const headerAt = sc + 3;
    if (headerAt >= buf.length) continue;
    const type = buf[headerAt] & 0x1F;
    const raw = buf.subarray(headerAt + 1, next);
    nals.push({
      type,
      start: marks[i].start,
      end: next,
      rbsp: stripEpb(raw),
    });
  }
  return nals;
}

// One PES elementary-stream span. AUD (type 9) bounds an access unit.
// With no AUD the whole span is one access unit (the PES itself was the split).
export function splitAccessUnits(es) {
  const nals = splitAnnexB(es);
  const bounds = [];
  for (const nal of nals) {
    if (nal.type === 9) bounds.push(nal.start);
  }
  if (!bounds.length) return es && es.length ? [es] : [];
  const parts = [];
  if (bounds[0] > 0) parts.push(es.subarray(0, bounds[0]));
  for (let i = 0; i < bounds.length; i++) {
    const a = bounds[i];
    const b = i + 1 < bounds.length ? bounds[i + 1] : es.length;
    if (b > a) parts.push(es.subarray(a, b));
  }
  return parts;
}

export function describeAccessUnit(es, spsById) {
  const nals = splitAnnexB(es);
  const types = [];
  let sps = null;
  let pps = null;
  let bp = null;
  let pt = null;
  let slice = null;
  let idr = false;
  let active = null;
  let captions = null;
  for (const id of spsById.keys()) active = spsById.get(id);
  for (const nal of nals) {
    types.push(nal.type);
    if (nal.type === 7) {
      const parsed = parseSps(nal.rbsp);
      if (parsed) {
        sps = parsed;
        spsById.set(parsed.spsId, parsed);
        active = parsed;
      }
    } else if (nal.type === 8) {
      const parsed = parsePps(nal.rbsp);
      if (parsed) pps = parsed;
    } else if (nal.type === 6) {
      const sei = parseSei(nal.rbsp, spsById, active);
      if (sei.bp) bp = sei.bp;
      if (sei.pt) pt = sei.pt;
      if (sei.captions) captions = mergeCaptionSei(captions, sei.captions);
    } else if (nal.type === 5 || nal.type === 1) {
      if (!slice) slice = parseSliceHeader(nal.rbsp.subarray(0, 64));
      if (nal.type === 5) idr = true;
    }
  }
  const spsNow = (bp && spsById.get(bp.spsId)) || sps || active;
  return {
    nalTypes: types.join(","),
    sps: spsNow || null,
    spsInAu: sps,
    pps,
    bp,
    pt,
    captions,
    slice,
    idr,
    frame: slice ? slice.frame : (idr ? "I" : "?"),
  };
}
