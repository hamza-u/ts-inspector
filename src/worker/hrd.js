// Annex C schedule on the DTS clock. CBR: t_ai(n) = t_af(n-1).
// VBR also respects the earliest-arrival floor from the governing BP.
// A later BP is agree (within 1 tick of 90 kHz), noise (under CpbSize/BitRate/4
// and no discontinuity), or a join. The chain re-anchors on a join.

import { createDecimator } from "./tsutil.js";

function sched0(sps) {
  if (!sps || !sps.hrd || !sps.hrd.scheds.length) return null;
  return sps.hrd.scheds[0];
}

function tcOf(sps) {
  if (sps && sps.timing && sps.timing.tc) return sps.timing.tc;
  return null;
}

function round3(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 1000) / 1000;
}

export function scheduleAus(aus, opts = {}) {
  const joinTol = opts.joinTolMs === undefined ? 20 : opts.joinTolMs;
  let gov = null;
  let tAfPrev = null;
  let segId = -1;
  const pending = new Set();
  const joins = [];
  const bps = [];

  function arrive(tr, cbr, rate, bits) {
    let tai;
    if (cbr || tAfPrev === null || gov === null) tai = tAfPrev;
    else {
      const g = aus[gov].bp || {};
      const earliest = tr - ((g.delay || 0) + (g.offset || 0)) / 90000;
      tai = tAfPrev > earliest ? tAfPrev : earliest;
    }
    return [tai, tai + bits / rate];
  }

  function put(au, tr, tai, taf, klass, rate, cpb, low) {
    au.tR = tr;
    au.tAi = tai;
    au.tAf = taf;
    au.segmentId = segId;
    au.bpClass = klass;
    const lead1 = tr - tai;
    const lead2 = tr - taf;
    const full = rate * lead1;
    au.planFirstLeadMs = lead1 * 1000;
    au.planLastLeadMs = lead2 * 1000;
    au.planFullnessB = full / 8;
    au.planFullnessPct = cpb ? (100 * full / cpb) : null;
    au.underflowPlan = taf > tr + 1 / 90000 && !low ? 1 : 0;
    au.overflowPlan = cpb !== null && cpb !== undefined && full > cpb + 8 ? 1 : 0;
  }

  for (let n = 0; n < aus.length; n++) {
    const au = aus[n];
    const sps = au.sps;
    const row = sched0(sps);
    if (!row) continue;
    const rate = row.bitRate;
    const cpb = row.cpbSize;
    const cbr = row.cbrFlag;
    const tc = tcOf(sps);
    const low = sps && sps.lowDelayHrdFlag ? 1 : 0;
    const bits = (au.sizeB || 0) * 8;
    if (au.discont && n > 0) pending.add("discont");
    if (au.newSps && n > 0) pending.add("sps");
    const bp = au.bp;
    const crb = au.cpbRemovalDelay;

    function chainTr() {
      if (gov === null) return null;
      if (crb !== null && crb !== undefined && tc) return aus[gov].tR + crb * tc;
      return au.dts;
    }

    if (!bp) {
      if (gov === null) continue;
      const tr = chainTr();
      if (tr === null || tr === undefined) continue;
      if (au.dts === null || au.dts === undefined) au.dts = tr;
      const pair = arrive(tr, cbr, rate, bits);
      put(au, tr, pair[0], pair[1], null, rate, cpb, low);
      tAfPrev = pair[1];
      continue;
    }

    const declared = bp.delay;
    if (gov === null) {
      const tr = au.dts === null || au.dts === undefined ? declared / 90000 : au.dts;
      if (au.dts === null || au.dts === undefined) au.dts = tr;
      const tai = tr - declared / 90000;
      const taf = tai + bits / rate;
      segId = 0;
      put(au, tr, tai, taf, "anchor", rate, cpb, low);
      gov = n;
      tAfPrev = taf;
      pending.clear();
      bps.push(bpRow(au, null, null, "anchor"));
      continue;
    }

    const trChain = chainTr();
    const dts = au.dts;
    const reasons = new Set(pending);
    if (dts !== null && dts !== undefined && trChain !== null && Math.abs(dts - trChain) * 1000 > joinTol) {
      reasons.add("dts_step");
    }
    let implied = null;
    let diff = null;
    if (trChain !== null && tAfPrev !== null) {
      implied = 90000 * (trChain - tAfPrev);
      diff = declared - implied;
    }
    const band = cpb ? (90000 * cpb / rate / 4) : 0;
    let klass;
    if (reasons.size || diff === null || Math.abs(diff) >= band) klass = "join";
    else if (Math.abs(diff) <= 1) klass = "agree";
    else klass = "noise";

    if (klass === "join") {
      const levelMs = dts !== null && dts !== undefined && tAfPrev !== null
        ? (dts - tAfPrev) * 1000 : null;
      const tr = dts === null || dts === undefined
        ? (trChain !== null ? trChain : tAfPrev + declared / 90000)
        : dts;
      if (au.dts === null || au.dts === undefined) au.dts = tr;
      const tai = tr - declared / 90000;
      const taf = tai + bits / rate;
      segId += 1;
      put(au, tr, tai, taf, "join", rate, cpb, low);
      const declMs = declared / 90;
      const debt = levelMs === null ? null : declMs - levelMs;
      joins.push({
        bAu: n,
        aAu: n - 1,
        reasons: reasons.size ? [...reasons].sort() : ["bp"],
        aLevelAtCutMs: levelMs,
        bDeclaredMs: declMs,
        debtMs: debt,
        extraBits: debt !== null && debt > 0 ? debt / 1000 * rate : 0,
        diff90k: diff,
        impliedMs: implied === null ? null : implied / 90,
        bitRate: rate,
      });
      gov = n;
      tAfPrev = taf;
      pending.clear();
    } else {
      const tr = trChain !== null ? trChain : dts;
      if ((au.dts === null || au.dts === undefined) && tr !== null) au.dts = tr;
      const pair = arrive(tr, cbr, rate, bits);
      put(au, tr, pair[0], pair[1], klass, rate, cpb, low);
      gov = n;
      tAfPrev = pair[1];
      pending.clear();
    }
    bps.push(bpRow(au, implied, diff, klass));
  }

  wireLeads(aus);
  finishJoins(aus, joins);
  return { joins, bps };
}

function bpRow(au, implied, diff, klass) {
  return {
    au: au.idx,
    t: au.dts,
    declaredMs: au.bp.delay / 90,
    offsetMs: au.bp.offset / 90,
    impliedMs: implied === null ? null : implied / 90,
    diff90k: diff,
    class: klass,
    packetIndex: au.firstPacket,
  };
}

function wireLeads(aus) {
  for (const au of aus) {
    const dts = au.dts;
    const wf = au.wireFirstS;
    const wl = au.wireLastS;
    if (dts === null || dts === undefined || wf === null || wf === undefined) {
      au.wireFirstLeadMs = null;
      au.wireLastLeadMs = null;
      au.wireLagVsPlanMs = null;
      continue;
    }
    au.wireFirstLeadMs = (dts - wf) * 1000;
    au.wireLastLeadMs = wl === null || wl === undefined ? null : (dts - wl) * 1000;
    au.wireLagVsPlanMs = au.planFirstLeadMs === null || au.planFirstLeadMs === undefined
      ? null : au.wireFirstLeadMs - au.planFirstLeadMs;
  }
}

function auBrief(au, rate) {
  if (!au || !rate) return null;
  const nbytes = au.sizeB || 0;
  return {
    au: au.idx,
    frame: au.frame,
    idr: au.idr ? 1 : 0,
    sizeB: nbytes,
    sendMs: nbytes * 8 / rate * 1000,
    packetIndex: au.firstPacket,
  };
}

function finishJoins(aus, joins) {
  for (const j of joins) {
    const b = aus[j.bAu];
    const a = j.aAu >= 0 ? aus[j.aAu] : null;
    const rate = j.bitRate;
    let idr = b && b.idr ? b : null;
    const t0 = b ? b.dts : null;
    const lags = [];
    if (t0 !== null && t0 !== undefined) {
      for (let i = j.bAu; i < aus.length; i++) {
        const au = aus[i];
        if (au.dts === null || au.dts === undefined) continue;
        if (au.dts > t0 + 3) break;
        if (!idr && au.idr) idr = au;
        if (au.wireLagVsPlanMs !== null && au.wireLagVsPlanMs !== undefined) lags.push(au.wireLagVsPlanMs);
      }
    }
    if (!idr) idr = b;
    j.wireLagBMs = b ? b.wireLagVsPlanMs : null;
    j.wireLagPeak3sMs = lags.length ? Math.min(...lags) : null;
    j.t = b ? b.dts : null;
    j.aLast = auBrief(a, rate);
    j.bIdr = auBrief(idr, rate);
    j.timeLeftMs = j.bIdr ? j.bDeclaredMs - j.bIdr.sendMs : null;
    j.packetIndex = b ? b.firstPacket : -1;
  }
}

function spsPublic(sps) {
  const br = sps.bitRate;
  const cpb = sps.cpbSize;
  const timing = sps.timing || {};
  return {
    spsId: sps.spsId,
    profile: sps.profile,
    profileName: sps.profileName,
    levelIdc: sps.level,
    whichHrd: sps.whichHrd,
    bitRate: br,
    cpbSizeBits: cpb,
    cpbSizeBytes: cpb === null || cpb === undefined ? null : Math.floor(cpb / 8),
    cpbMs: br && cpb ? cpb / br * 1000 : null,
    cbrFlag: sps.cbrFlag,
    lowDelayHrdFlag: sps.lowDelayHrdFlag,
    numUnitsInTick: timing.numUnitsInTick || null,
    timeScale: timing.timeScale || null,
    tcS: timing.tc || null,
    width: sps.width,
    height: sps.height,
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function summarizeHrd(aus, joins, bps) {
  const counts = {
    aus: aus.length,
    bps: { anchor: 0, agree: 0, noise: 0, join: 0 },
    joins: joins.length,
    underflowPlan: 0,
    overflowPlan: 0,
    wireLeadLt0: 0,
    wireLeadLt40: 0,
  };
  for (const au of aus) {
    if (au.underflowPlan) counts.underflowPlan += 1;
    if (au.overflowPlan) counts.overflowPlan += 1;
    if (au.wireFirstLeadMs !== null && au.wireFirstLeadMs !== undefined) {
      if (au.wireFirstLeadMs < 0) counts.wireLeadLt0 += 1;
      if (au.wireFirstLeadMs < 40) counts.wireLeadLt40 += 1;
    }
  }
  for (const bp of bps) {
    if (counts.bps[bp.class] !== undefined) counts.bps[bp.class] += 1;
  }
  const bySeg = new Map();
  for (const au of aus) {
    if (au.segmentId === null || au.segmentId === undefined) continue;
    if (!bySeg.has(au.segmentId)) bySeg.set(au.segmentId, []);
    bySeg.get(au.segmentId).push(au);
  }
  const segments = [];
  for (const sid of [...bySeg.keys()].sort((a, b) => a - b)) {
    const group = bySeg.get(sid);
    const leads = group.map((a) => a.planFirstLeadMs).filter((v) => v !== null && v !== undefined);
    const wires = group.map((a) => a.wireFirstLeadMs).filter((v) => v !== null && v !== undefined);
    const dts = group.map((a) => a.dts).filter((v) => v !== null && v !== undefined);
    let frameDt = null;
    if (dts.length >= 2) {
      const gaps = [];
      for (let i = 1; i < dts.length; i++) {
        const d = dts[i] - dts[i - 1];
        if (d > 1e-6) gaps.push(d);
      }
      frameDt = median(gaps);
    }
    const last = group[group.length - 1];
    let endLevel = null;
    if (frameDt && last.dts !== null && last.dts !== undefined && last.tAf !== null && last.tAf !== undefined) {
      endLevel = (last.dts + frameDt - last.tAf) * 1000;
    }
    let firstBp = null;
    for (const au of group) {
      if (au.bp) { firstBp = au.bp.delay / 90; break; }
    }
    segments.push({
      id: sid,
      firstAu: group[0].idx,
      lastAu: group[group.length - 1].idx,
      firstBpMs: firstBp,
      endLevelMs: endLevel,
      planLeadMinMs: leads.length ? Math.min(...leads) : null,
      planLeadMedianMs: median(leads),
      planLeadMaxMs: leads.length ? Math.max(...leads) : null,
      wireLeadMinMs: wires.length ? Math.min(...wires) : null,
      nAus: group.length,
    });
  }
  const seen = [];
  const seenKey = new Set();
  for (const au of aus) {
    if (!au.sps) continue;
    const key = [au.sps.spsId, au.sps.profile, au.sps.level, au.sps.bitRate, au.sps.cpbSize].join(":");
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    seen.push(spsPublic(au.sps));
  }
  let t0 = null;
  for (const au of aus) {
    if (au.dts !== null && au.dts !== undefined) { t0 = au.dts; break; }
    if (au.wireFirstS !== null && au.wireFirstS !== undefined) { t0 = au.wireFirstS; break; }
  }
  if (t0 === null) t0 = 0;
  const full = createDecimator();
  const leads = createDecimator();
  const frames = createDecimator();
  for (const au of aus) {
    const t = au.dts !== null && au.dts !== undefined ? au.dts - t0 : (au.wireFirstS !== null && au.wireFirstS !== undefined ? au.wireFirstS - t0 : null);
    if (t === null) continue;
    if (au.planFullnessPct !== null && au.planFullnessPct !== undefined) {
      full.push({ t, pct: au.planFullnessPct, packetIndex: au.firstPacket });
    }
    if (au.planFirstLeadMs !== null && au.planFirstLeadMs !== undefined) {
      leads.push({
        t,
        plan: au.planFirstLeadMs,
        wire: au.wireFirstLeadMs,
        packetIndex: au.firstPacket,
      });
    }
    frames.push({
      t,
      bytes: au.sizeB || 0,
      frame: au.frame || "?",
      idr: au.idr ? 1 : 0,
      packetIndex: au.firstPacket,
    });
  }
  const rel = (s) => (s === null || s === undefined ? null : s - t0);
  return {
    t0,
    sps: seen,
    counts,
    segments: segments.map((s) => ({
      ...s,
      firstBpMs: round3(s.firstBpMs),
      endLevelMs: round3(s.endLevelMs),
      planLeadMinMs: round3(s.planLeadMinMs),
      planLeadMedianMs: round3(s.planLeadMedianMs),
      planLeadMaxMs: round3(s.planLeadMaxMs),
      wireLeadMinMs: round3(s.wireLeadMinMs),
    })),
    joins: joins.map((j) => ({
      t: rel(j.t),
      packetIndex: j.packetIndex,
      reasons: j.reasons,
      aLevelAtCutMs: round3(j.aLevelAtCutMs),
      bDeclaredMs: round3(j.bDeclaredMs),
      debtMs: round3(j.debtMs),
      extraBits: Math.round(j.extraBits || 0),
      aLast: j.aLast,
      bIdr: j.bIdr ? { ...j.bIdr, sendMs: round3(j.bIdr.sendMs) } : null,
      timeLeftMs: round3(j.timeLeftMs),
      wireLagBMs: round3(j.wireLagBMs),
      wireLagPeak3sMs: round3(j.wireLagPeak3sMs),
    })),
    bps: bps.map((b) => ({
      au: b.au,
      t: rel(b.t),
      declaredMs: round3(b.declaredMs),
      impliedMs: round3(b.impliedMs),
      diff90k: b.diff90k === null ? null : round3(b.diff90k),
      class: b.class,
      packetIndex: b.packetIndex,
    })),
    fullness: full.rows().map((p) => ({ t: round3(p.t), pct: round3(p.pct), packetIndex: p.packetIndex })),
    leads: leads.rows().map((p) => ({
      t: round3(p.t), plan: round3(p.plan), wire: p.wire === null || p.wire === undefined ? null : round3(p.wire),
      packetIndex: p.packetIndex,
    })),
    frames: frames.rows().map((p) => ({
      t: round3(p.t), bytes: p.bytes, frame: p.frame, idr: p.idr, packetIndex: p.packetIndex,
    })),
  };
}
