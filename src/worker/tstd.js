// H.222.0 2.14.3.1 T-STD for one AVC PID.
// TB is 512 bytes. Rx is 1.2 × BitRate[SchedSelIdx] (Annex E when the
// stream has no NAL HRD). MB and EB sizes, and the leak rate Rbx, use the
// 1200 × MaxBR / MaxCPB formulas in that clause. High-profile Annex A
// limits (factor 1500) are reported beside them: the transport clause is
// tighter on purpose.
// hrd_management_valid_flag 1 moves MB→EB on the Annex C schedule.
// Otherwise MB leaks into EB at Rbx and stops when EB is full.

import { createDecimator } from "./tsutil.js";

// Table A-1 columns are MaxBR and MaxCPB in units of 1000 bit/s and 1000 bits
// before the NAL/VCL factor is applied.
const LEVEL = {
  10: [64, 175],
  11: [192, 500],
  12: [384, 1000],
  13: [768, 2000],
  20: [2000, 2000],
  21: [4000, 4000],
  22: [4000, 4000],
  30: [10000, 10000],
  31: [14000, 14000],
  32: [20000, 20000],
  40: [20000, 25000],
  41: [50000, 62500],
  42: [50000, 62500],
  50: [135000, 135000],
  51: [240000, 240000],
  52: [240000, 240000],
  60: [240000, 240000],
  61: [480000, 240000],
  62: [800000, 240000],
};

const HIGH = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export function tstdLimits(profile, level, cpbBits, bitRate) {
  const known = LEVEL[level] || null;
  const row = known || LEVEL[40];
  const maxBr = row[0];
  const maxCpb = row[1];
  const nalFactor = HIGH.has(profile) ? 1500 : 1200;
  const tsBr = 1200 * maxBr;
  const tsCpb = 1200 * maxCpb;
  const usedCpb = cpbBits > 0 ? cpbBits : tsCpb;
  const usedBr = bitRate > 0 ? bitRate : nalFactor * maxBr;
  const cap = Math.max(tsBr, 2_000_000);
  const bsOh = cap / 750;
  const bsMux = 0.004 * cap;
  const mbBits = bsMux + bsOh + Math.max(0, tsCpb - usedCpb);
  return {
    tbBytes: 512,
    mbBytes: mbBits / 8,
    ebBytes: usedCpb / 8,
    rxBps: 1.2 * usedBr / 8,
    rbxBps: tsBr / 8,
    bitRate: usedBr,
    cpbBits: usedCpb,
    level,
    levelKnown: !!known,
    profile,
    annexABitRate: nalFactor * maxBr,
    annexACpbBits: nalFactor * maxCpb,
    tsFactor: 1200,
    nalFactor,
  };
}

function pushSeg(q, n, kind) {
  if (n <= 1e-9) return;
  const last = q[q.length - 1];
  if (last && last.kind === kind) last.n += n;
  else q.push({ n, kind });
}

export function simulateTstd(opts) {
  const limits = opts.limits;
  const method = opts.method === "hrd" ? "hrd" : "leak";
  const low = !!opts.lowDelay;
  const muxBps = opts.muxBps > 0 ? opts.muxBps : 10_000_000;
  const packets = opts.packets || [];
  const aus = (opts.aus || []).map((au) => ({
    dts: au.dts,
    size: au.sizeB || 0,
    tAi: au.tAi,
    tAf: au.tAf,
    bitRate: au.bitRate || limits.bitRate,
    tFirst: au.wireFirstS,
    packetIndex: au.firstPacket,
    got: 0,
    removed: false,
  }));
  const tb = [];
  const mb = [];
  let tbN = 0;
  let mbN = 0;
  let eb = 0;
  let delivered = 0;
  const counts = {
    tb_overflow: 0, mb_overflow: 0, eb_overflow: 0,
    eb_underflow: 0, tb_not_empty: 0, data_delay: 0,
  };
  const events = [];
  const hot = {};
  const series = createDecimator();
  const t0 = packets.length ? packets[0].t : 0;
  let cursor = t0;
  let lastEmpty = t0;
  let lastEmptyFlag = -1e9;
  let packetIndex = packets.length ? packets[0].packetIndex : -1;

  function emit(kind, t, detail) {
    counts[kind] += 1;
    if (events.length < 400) {
      events.push({
        kind,
        t: Math.round((t - t0) * 1e6) / 1e6,
        detail,
        packetIndex,
      });
    }
  }

  function clampTb() {
    if (tbN <= limits.tbBytes + 1) {
      hot.tb = false;
      return;
    }
    if (!hot.tb) {
      hot.tb = true;
      emit("tb_overflow", cursor, "TB above 512 bytes");
    }
    let extra = tbN - limits.tbBytes;
    while (extra > 1e-6 && tb.length) {
      const f = tb[tb.length - 1];
      const m = Math.min(f.n, extra);
      f.n -= m;
      tbN -= m;
      extra -= m;
      if (f.n <= 1e-9) tb.pop();
    }
  }

  function clampMb() {
    if (mbN <= limits.mbBytes + 1) {
      hot.mb = false;
      return;
    }
    if (!hot.mb) {
      hot.mb = true;
      emit("mb_overflow", cursor, "MB above " + Math.round(limits.mbBytes) + " bytes");
    }
    let extra = mbN - limits.mbBytes;
    while (extra > 1e-6 && mb.length) {
      const f = mb[mb.length - 1];
      const m = Math.min(f.n, extra);
      f.n -= m;
      mbN -= m;
      extra -= m;
      if (f.n <= 1e-9) mb.pop();
    }
  }

  function credit(n) {
    if (n <= 0) return;
    eb += n;
    let left = n;
    for (const au of aus) {
      if (au.removed) continue;
      const need = au.size - au.got;
      if (need <= 1e-6) continue;
      const m = Math.min(need, left);
      au.got += m;
      left -= m;
      if (left <= 1e-6) break;
    }
    if (eb > limits.ebBytes + 1) {
      if (!hot.eb) {
        hot.eb = true;
        emit("eb_overflow", cursor, "EB above " + Math.round(limits.ebBytes) + " bytes");
      }
    } else hot.eb = false;
  }

  function tbPull(maxBytes) {
    const out = [];
    let left = maxBytes;
    while (left > 1e-9 && tb.length) {
      const f = tb[0];
      const m = Math.min(f.n, left);
      f.n -= m;
      tbN -= m;
      left -= m;
      if (f.kind !== "drop") pushSeg(out, m, f.kind);
      if (f.n <= 1e-9) tb.shift();
    }
    return out;
  }

  function toMb(parts) {
    for (const p of parts) {
      if (!p.n) continue;
      pushSeg(mb, p.n, p.kind === "es" ? "es" : "hdr");
      mbN += p.n;
    }
    clampMb();
  }

  function mbHasEs() {
    for (const f of mb) if (f.kind === "es" && f.n > 0) return true;
    return false;
  }

  function takeMbEs(n) {
    let left = n;
    let got = 0;
    while (left > 1e-9 && mb.length) {
      if (mb[0].kind !== "es") {
        mbN -= mb[0].n;
        mb.shift();
        continue;
      }
      const m = Math.min(mb[0].n, left);
      mb[0].n -= m;
      mbN -= m;
      left -= m;
      got += m;
      if (mb[0].n <= 1e-9) mb.shift();
    }
    return got;
  }

  function leak(dt) {
    if (dt <= 0) return;
    let left = limits.rbxBps * dt;
    while (left > 1e-9 && mbHasEs() && eb < limits.ebBytes - 1e-3) {
      while (mb.length && mb[0].kind !== "es") {
        mbN -= mb[0].n;
        mb.shift();
      }
      if (!mb.length || mb[0].kind !== "es") break;
      const room = limits.ebBytes - eb;
      const m = Math.min(mb[0].n, left, room);
      if (m <= 1e-9) break;
      mb[0].n -= m;
      mbN -= m;
      left -= m;
      if (mb[0].n <= 1e-9) mb.shift();
      credit(m);
    }
  }

  function scheduled(au, t) {
    if (au.tAi === null || au.tAi === undefined) return 0;
    if (t <= au.tAi) return 0;
    if (au.tAf !== null && au.tAf !== undefined && t >= au.tAf) return au.size;
    const bps = (au.bitRate || limits.bitRate) / 8;
    return Math.min(au.size, (t - au.tAi) * bps);
  }

  function hrdPull(t) {
    let want = 0;
    for (const au of aus) want += scheduled(au, t);
    const need = want - delivered;
    if (need <= 1e-6) return;
    const moved = takeMbEs(need);
    delivered += moved;
    credit(moved);
  }

  function noteEmpty() {
    if (tbN <= 1e-3) {
      lastEmpty = cursor;
      return;
    }
    if (cursor - lastEmpty > 1 && cursor - lastEmptyFlag >= 1) {
      lastEmptyFlag = cursor;
      emit("tb_not_empty", cursor, "TB was not empty for 1 s");
    }
  }

  function sample() {
    series.push({
      t: cursor - t0,
      tb: tbN,
      mb: mbN,
      eb,
      packetIndex,
    });
  }

  function flow(dt, input) {
    if (dt < 0) dt = 0;
    const rin = input && dt > 0 ? input.n / dt : 0;
    if (!input || input.n <= 0) {
      if (tbN > 1e-9 && dt > 0) toMb(tbPull(limits.rxBps * dt));
    } else if (tbN <= 1e-9 && rin <= limits.rxBps + 1e-3) {
      if (input.kind !== "drop") toMb([{ n: input.n, kind: input.kind }]);
    } else {
      const drained = limits.rxBps * dt;
      const fromOld = Math.min(tbN, drained);
      const pulled = tbPull(fromOld);
      const fromNew = Math.min(input.n, Math.max(0, drained - fromOld));
      if (fromNew > 0 && input.kind !== "drop") pushSeg(pulled, fromNew, input.kind);
      const stay = input.n - fromNew;
      if (stay > 1e-6) {
        pushSeg(tb, stay, input.kind);
        tbN += stay;
        clampTb();
      }
      toMb(pulled);
    }
    if (method === "hrd") hrdPull(cursor + dt);
    else leak(dt);
  }

  function removeDue(t) {
    for (const au of aus) {
      if (au.removed) continue;
      if (au.dts === null || au.dts === undefined || au.dts > t + 1e-6) continue;
      if (au.got + 1 < au.size && !low) {
        emit("eb_underflow", au.dts, "AU not complete at DTS (" + Math.round(au.got) + "/" + au.size + " bytes)");
      }
      if (au.tFirst !== null && au.tFirst !== undefined && au.dts - au.tFirst > 10) {
        emit("data_delay", au.dts, "delay " + (au.dts - au.tFirst).toFixed(3) + " s");
      }
      const take = Math.min(eb, au.got);
      eb -= take;
      au.removed = true;
    }
  }

  function ingest(pkt) {
    packetIndex = pkt.packetIndex;
    const parts = [];
    if (pkt.drop) parts.push({ n: pkt.drop, kind: "drop" });
    if (pkt.hdr) parts.push({ n: pkt.hdr, kind: "hdr" });
    if (pkt.es) parts.push({ n: pkt.es, kind: "es" });
    let sum = 0;
    for (const p of parts) sum += p.n;
    if (sum < 188) parts.push({ n: 188 - sum, kind: "drop" });
    for (const part of parts) {
      const dt = muxBps > 0 ? part.n * 8 / muxBps : 0;
      flow(dt, part);
      cursor += dt;
      removeDue(cursor);
      noteEmpty();
    }
  }

  const marks = [];
  for (const pkt of packets) marks.push({ t: pkt.t, type: "pkt", pkt });
  for (const au of aus) {
    if (au.dts !== null && au.dts !== undefined) marks.push({ t: au.dts, type: "dts" });
  }
  marks.sort((a, b) => a.t - b.t || (a.type === "dts" ? -1 : 1));
  for (const mark of marks) {
    if (mark.t > cursor) {
      flow(mark.t - cursor, null);
      cursor = mark.t;
      noteEmpty();
    }
    if (mark.type === "dts") removeDue(mark.t);
    else ingest(mark.pkt);
    sample();
  }

  const rows = series.rows().map((p) => ({
    t: Math.round(p.t * 1e6) / 1e6,
    tb: Math.round(p.tb),
    mb: Math.round(p.mb),
    eb: Math.round(p.eb),
    packetIndex: p.packetIndex,
  }));
  return { method, limits, counts, events, series: rows };
}
