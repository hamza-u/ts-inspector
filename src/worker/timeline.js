// Markers for the bottom timeline. Times are PCR seconds from the first PCR.
// Picture ticks are capped so a long file stays a list of points.

// Audio PIDs come from the PCR-level PID table, which carries the PMT stream
// type. Naming a lane from the type keeps working when the label changes.
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0F, 0x11, 0x1C, 0x81, 0x84, 0x87, 0x8A]);
const FRAME_CAP = 50000;
const IFRAME_CAP = 2000;

// SCTE-35 segmentation type ids, EN 300 743 style advertising boundaries.
export const CUE_OUT = new Uint8Array([0x22, 0x30, 0x34, 0x11]);
export const CUE_IN = new Uint8Array([0x23, 0x31, 0x35, 0x10]);

export function cueOf(typeId) {
  if (typeId === null || typeId === undefined) return null;
  if (CUE_OUT.includes(typeId)) return "out";
  if (CUE_IN.includes(typeId)) return "in";
  return null;
}

export function pcrSeconds(timing, packetIndex) {
  if (packetIndex === null || packetIndex === undefined || packetIndex < 0) return null;
  const ticks = timing.pcrAt(packetIndex);
  if (ticks === null || ticks === undefined) return null;
  const origin = timing.pcrAt(0);
  const base = origin === null || origin === undefined ? 0 : origin;
  const t = (ticks - base) / 27e6;
  if (!Number.isFinite(t)) return null;
  return Math.round(t * 1e6) / 1e6;
}

function scteLabel(ev, cue) {
  const command = ev.command || {};
  let label = command.name || "scte";
  if (cue === "out") label = "CUE-OUT";
  else if (cue === "in") label = "CUE-IN";
  else if (command.name === "splice_insert") label = command.outOfNetwork ? "splice out" : "splice in";
  const seg = (ev.descriptors || [])
    .map((d) => d.segmentation && d.segmentation.typeName)
    .filter(Boolean)[0];
  if (seg) label += " · " + seg;
  return label;
}

export function thinFrames(rows) {
  if (rows.length <= FRAME_CAP) return rows;
  const keys = rows.filter((r) => r.idr || r.frame === "I");
  const rest = rows.filter((r) => !(r.idr || r.frame === "I"));
  const budget = Math.max(0, FRAME_CAP - keys.length);
  const step = budget ? Math.ceil(rest.length / budget) : rest.length + 1;
  const kept = [];
  for (let i = 0; i < rest.length; i += step) kept.push(rest[i]);
  return keys.concat(kept).sort((a, b) => a.t - b.t || a.packetIndex - b.packetIndex);
}

export function buildTimeline(opts) {
  const timing = opts.timing;
  const at = (packetIndex, fallback) => {
    const t = pcrSeconds(timing, packetIndex);
    if (t !== null) return t;
    return fallback === null || fallback === undefined ? null : fallback;
  };
  const scte = [];
  for (const ev of opts.scte || []) {
    const t = at(ev.packetIndex, ev.t);
    if (t === null) continue;
    const segs = (ev.descriptors || [])
      .map((d) => d.segmentation)
      .filter((s) => s && !s.cancel);
    const typeId = segs.length ? segs[0].typeId : null;
    const command = ev.command || {};
    scte.push({
      t,
      pid: ev.pid,
      packetIndex: ev.packetIndex,
      label: scteLabel(ev, cueOf(typeId)),
      cue: cueOf(typeId),
      typeId,
      eventId: command.eventId === undefined ? null : command.eventId,
      breakMs: command.breakDuration === undefined || command.breakDuration === null
        ? null
        : Math.round(command.breakDuration / 90),
    });
  }
  const frames = [];
  for (const stream of opts.streams || []) {
    for (const au of stream.aus || []) {
      const t = at(au.firstPacket, null);
      if (t === null) continue;
      frames.push({
        t,
        pid: stream.pid,
        packetIndex: au.firstPacket,
        frame: au.frame || "?",
        idr: au.idr ? 1 : 0,
      });
    }
  }
  const subs = [];
  (opts.teletext || []).forEach((page, index) => {
    const t = at(page.packetIndex, null);
    if (t === null) return;
    subs.push({
      t,
      pid: page.pid,
      packetIndex: page.packetIndex,
      kind: "teletext",
      label: String(page.number),
      text: page.text || "",
      subtitleIndex: index,
    });
  });
  (opts.subtitles || []).forEach((picture, index) => {
    const t = at(picture.packetIndex, null);
    if (t === null) return;
    subs.push({
      t,
      pid: picture.pid,
      packetIndex: picture.packetIndex,
      kind: "dvb",
      label: "subtitle",
      text: "",
      subtitleIndex: index,
    });
  });
  const audio = [];
  for (const row of opts.pids || []) {
    // A declared audio stream type, or a private PES stream whose descriptor
    // named it AC-3 or AAC.
    const labelled = /AC-3|E-AC-3|AAC|audio/i.test(row.long || row.kind || "");
    if (AUDIO_STREAM_TYPES.has(row.type) || (row.type === 0x06 && labelled)) {
      audio.push({ pid: row.pid, label: row.kind || row.long || "audio" });
    }
  }
  const allIframes = frames.filter((row) => row.idr || row.frame === "I");
  const iFrameStep = allIframes.length > IFRAME_CAP ? Math.ceil(allIframes.length / IFRAME_CAP) : 1;
  const iFrames = allIframes.filter((row, i) => i % iFrameStep === 0);
  return {
    scte,
    frames: thinFrames(frames),
    iFrames,
    subs,
    audio,
  };
}
