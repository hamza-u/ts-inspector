// One-pass inspection of a transport stream. The caller pushes chunks
// (a File slice, or a whole Uint8Array in tests) and then finish().

import { createBitrate } from "./bitrate.js";
import { buildCompliance } from "./compliance.js";
import { createClock } from "./clock.js";
import { createDvbSub } from "./dvbsub.js";
import { createFramer } from "./framer.js";
import { scheduleAus, summarizeHrd } from "./hrd.js";
import { createPcrAc } from "./pcrac.js";
import { createVideo, pesContent } from "./pes.js";
import { createPsi } from "./psi.js";
import { createScte } from "./scte35.js";
import { createTeletext } from "./teletext.js";
import { createTiming } from "./timing.js";
import { createTr290 } from "./tr290.js";
import { simulateTstd, tstdLimits } from "./tstd.js";
import { buildTimeline } from "./timeline.js";
import { payloadBytes, readPid, readPcr } from "./tsutil.js";

export function createInspector(opts = {}) {
  const fileSize = opts.fileSize || 0;
  let expected = opts.expectedPackets || 0;
  const framer = createFramer();
  const clock = createClock();
  const tr = createTr290();
  const psi = createPsi();
  const scte = createScte();
  const timing = createTiming();
  const video = createVideo();
  const pcrac = createPcrAc();
  const teletext = createTeletext();
  const dvbsub = createDvbSub();
  const textPids = new Set();
  const subPids = new Set();
  const privatePes = new Map();
  let bitrate = null;
  let framed = false;
  const held = [];
  let heldRead = 0;

  function ensureBitrate() {
    if (!bitrate && expected > 0) bitrate = createBitrate(expected, opts.steps || 1200);
  }

  function deliver(ts, index, now) {
    ensureBitrate();
    const pid = readPid(ts);
    if (pid === 0x1FFF) {
      if (bitrate) bitrate.add(index, pid);
      tr.feed(ts, now, index);
      return;
    }
    const pcr = readPcr(ts);
    if (pcr !== null) {
      timing.pcr(index, pcr, now);
      pcrac.add(index, pcr, now);
    }
    timing.pes(ts, index, now);
    if (bitrate) bitrate.add(index, pid);
    tr.feed(ts, now, index);
    psi.push(ts, index);
    for (const item of psi.takeScte()) scte.add(item.section, item.pid, item.packetIndex, now);
    const tree = psi.tree();
    for (const pmt of tree.pmts) {
      for (const stream of pmt.streams || []) {
        if (stream.teletext) textPids.add(stream.pid);
        if (stream.subtitle) subPids.add(stream.pid);
      }
    }
    video.sync(tree);
    video.push(ts, index, null);
    if (textPids.has(pid) || subPids.has(pid)) pushPrivate(ts, pid, index, now);
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

  function flushPrivate(pid) {
    const heldPes = privatePes.get(pid);
    if (!heldPes || !heldPes.parts.length) return;
    privatePes.delete(pid);
    const parsed = pesContent(concat(heldPes.parts));
    if (!parsed) return;
    if (textPids.has(pid)) teletext.push(parsed.es, heldPes.index, heldPes.now, pid);
    if (subPids.has(pid)) dvbsub.push(parsed.es, heldPes.index, heldPes.now, pid);
  }

  function pushPrivate(ts, pid, index, now) {
    const payload = payloadBytes(ts);
    if (!payload || !payload.length) return;
    const pusi = (ts[1] & 0x40) !== 0;
    if (pusi) {
      flushPrivate(pid);
      privatePes.set(pid, { parts: [payload.slice()], index, now });
    } else {
      const buf = privatePes.get(pid);
      if (buf) buf.parts.push(payload.slice());
    }
  }

  function apply(released) {
    for (const [index, now] of released) {
      const ts = held[heldRead];
      heldRead += 1;
      deliver(ts, index, now);
    }
    if (heldRead > 2048 && heldRead === held.length) {
      held.length = 0;
      heldRead = 0;
    } else if (heldRead > 4096) {
      held.splice(0, heldRead);
      heldRead = 0;
    }
  }

  function onFrame(framing) {
    framed = true;
    if (!expected && fileSize && framing.size) {
      expected = Math.floor(fileSize / framing.size);
    }
    ensureBitrate();
  }

  function onPacket(ts, index) {
    const pcr = readPcr(ts);
    const before = held.length - heldRead;
    const released = clock.push(index, pcr);
    if (before === 0 && released.length === 1 && released[0][0] === index) {
      deliver(ts, index, released[0][1]);
      return;
    }
    if (released.length === 0) {
      held.push(ts.slice());
      return;
    }
    held.push(ts.slice());
    apply(released);
  }

  return {
    packetCount() { return framer.index; },
    resyncs() { return framer.resyncs; },
    framing() { return framer.framing; },
    push(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      framer.push(bytes, onPacket, framed ? null : onFrame);
    },
    finish() {
      framer.finish(onPacket, framed ? null : onFrame);
      apply(clock.finish());
      for (const pid of [...privatePes.keys()]) flushPrivate(pid);
      const timingReport = timing.finish();
      const parsed = video.finish();
      const muxBps = timingReport.muxRate || timing.muxRate() || 0;
      let hrd = { modelled: false, sps: [], counts: {}, joins: [], segments: [], bps: [], fullness: [], leads: [], frames: [] };
      let tstd = { modelled: false, counts: {}, events: [], series: [] };
      const videoStreams = [];
      const ranked = parsed.streams.slice().sort((a, b) => b.aus.length - a.aus.length);
      const primary = ranked.find((s) => s.sps.length) || ranked[0] || null;
      for (const stream of parsed.streams) {
        for (const pkt of stream.packets) {
          const ticks = timing.pcrAt(pkt.packetIndex);
          pkt.t = ticks === null || ticks === undefined ? null : ticks / 27e6;
        }
        for (const au of stream.aus) {
          const a = timing.pcrAt(au.firstPacket);
          const b = timing.pcrAt(au.lastPacket);
          au.wireFirstS = a === null || a === undefined ? null : a / 27e6;
          au.wireLastS = b === null || b === undefined ? null : b / 27e6;
        }
        let summary = null;
        if (stream.aus.length) {
          const scheduled = scheduleAus(stream.aus);
          summary = summarizeHrd(stream.aus, scheduled.joins, scheduled.bps);
          summary.modelled = stream.sps.length > 0;
          summary.pid = stream.pid;
          summary.method = stream.hrdManagementValid === 1 ? "hrd" : "leak";
        }
        if (stream === primary && summary) hrd = summary;
        let sim = null;
        if (stream === primary && stream.sps.length) {
          const sps = stream.sps[0];
          const limits = tstdLimits(sps.profile, sps.level, sps.cpbSize, sps.bitRate);
          const packets = stream.packets.filter((p) => p.t !== null && p.t !== undefined);
          sim = simulateTstd({
            limits,
            method: stream.hrdManagementValid === 1 ? "hrd" : "leak",
            lowDelay: !!sps.lowDelayHrdFlag,
            muxBps,
            packets,
            aus: stream.aus,
          });
          tstd = {
            modelled: true,
            pid: stream.pid,
            method: sim.method,
            limits: {
              tbBytes: Math.round(limits.tbBytes),
              mbBytes: Math.round(limits.mbBytes),
              ebBytes: Math.round(limits.ebBytes),
              rxBps: Math.round(limits.rxBps),
              rbxBps: Math.round(limits.rbxBps),
              bitRate: limits.bitRate,
              cpbBits: limits.cpbBits,
              level: limits.level,
              levelKnown: limits.levelKnown,
              annexABitRate: limits.annexABitRate,
              annexACpbBits: limits.annexACpbBits,
            },
            counts: sim.counts,
            events: sim.events,
            series: sim.series,
          };
          const first = sim.events[0];
          tr.addCount("Buffer_error", sim.counts.tb_overflow + sim.counts.mb_overflow + sim.counts.eb_overflow,
            "T-STD overflow", first ? first.packetIndex : -1, first ? first.t : 0);
          tr.addCount("Empty_buffer_error", sim.counts.eb_underflow + sim.counts.tb_not_empty,
            "T-STD underflow or TB not empty", first ? first.packetIndex : -1, first ? first.t : 0);
          tr.addCount("Data_delay_error", sim.counts.data_delay,
            "T-STD delay above 10 s", first ? first.packetIndex : -1, first ? first.t : 0);
        }
        videoStreams.push({
          pid: stream.pid,
          hrdManagementValid: stream.hrdManagementValid,
          captions: stream.captions,
          auCount: stream.aus.length,
          idrCount: stream.aus.filter((au) => au.idr).length,
          gops: stream.gops,
          sps: summary ? summary.sps : [],
          pps: stream.pps,
          frames: summary ? summary.frames : [],
        });
      }
      const pcrAccuracy = pcrac.finish();
      if (pcrAccuracy.overLimit) {
        tr.addCount("PCR_accuracy_error", pcrAccuracy.overLimit,
          (pcrAccuracy.firstNs >= 0 ? "+" : "") + Math.round(pcrAccuracy.firstNs) + " ns",
          pcrAccuracy.firstPacket, 0);
      }
      const tr290 = tr.snapshot();
      const rate = timingReport.muxRate;
      const bitrateReport = bitrate
        ? bitrate.finish(rate || 1)
        : { mux: 0, dur: 0, pkts: tr290.pkts, steps: 0, series: [] };
      const tree = psi.tree();
      const teletextPages = teletext.finish();
      const subtitleSets = dvbsub.finish();
      const timeline = buildTimeline({
        timing,
        scte: scte.events(),
        streams: parsed.streams,
        teletext: teletextPages,
        subtitles: subtitleSets,
        pids: tr290.pids,
      });
      const report = {
        framing: framer.framing,
        resyncs: framer.resyncs,
        summary: {
          packets: tr290.pkts,
          bytes: tr290.bytes,
          durationS: bitrateReport.dur,
          muxBps: rate || 0,
          muxEstimated: !rate,
          pcrPid: tr290.pcr_pid,
          pcrMaxIntervalMs: tr290.pcr_max_interval_ms,
          resyncs: framer.resyncs,
          programs: tree.pat ? tree.pat.programs.length : 0,
        },
        tr290,
        pids: tr290.pids.map((row) => {
          const series = bitrateReport.series.find((s) => s.pid === row.pid);
          return {
            ...row,
            packets: series ? series.pkts : 0,
            meanMbps: series ? series.mean : 0,
            minMbps: series ? series.min : 0,
            maxMbps: series ? series.max : 0,
          };
        }),
        psi: {
          pat: tree.pat,
          pmts: tree.pmts,
          sdt: tree.sdt,
          nit: tree.nit,
          eit: tree.eit,
          epg: tree.epg,
          tdt: tree.tdt,
          crcErrors: tree.crcErrors,
        },
        scte35: scte.events(),
        bitrate: bitrateReport,
        timing: {
          intervals: timingReport.intervals,
          fit: timingReport.fit,
          ptsPcr: timingReport.ptsPcr,
        },
        video: { streams: videoStreams },
        hrd,
        tstd,
        pcrAccuracy,
        teletext: teletextPages,
        subtitles: subtitleSets,
        timeline,
        audio: [],
        events: tr.events(),
      };
      report.compliance = buildCompliance(report);
      return report;
    },
  };
}

export function inspectBytes(bytes, opts = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const inspector = createInspector({ fileSize: data.length, ...opts });
  inspector.push(data);
  return inspector.finish();
}
