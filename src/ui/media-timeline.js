// Sticky media timeline. Lanes are an I-frame filmstrip, SCTE cues,
// H.264 picture types, subtitle points, and an audio level meter.
// Times are seconds from the first PCR. Cue markers run the full height.
// The bar is sized to the height the caller asks for, so it can stand
// beside the T-STD plots instead of under them as a strip.

import { dbText, levelAt, lufsText, luText, peakOf, toDb } from "./audio-level.js";

const TL_FRAME_COLOR = { I: "#e1306c", P: "#833ab4", B: "#f77737", "?": "#a49bb3" };
const THUMB_W = 62; // rough cull margin while scrolling a long file
const RULER = 22; // time ruler under the last lane
const PAD = 8;
const BASE_POINTS = 34;
const BASE_THUMBS = 92;
const BASE_AUDIO = 150;
const MIN_HEIGHT = 260; // the bar has to stand beside the T-STD plots, not under them
const IMAGES = new Map();

// Narrowest window the zoom will go to, in seconds. Below this the ruler
// reads in milliseconds and single pictures are still apart.
export const MIN_SPAN = 0.05;

function tlCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function baseHeight(kind) {
  if (kind === "audio") return BASE_AUDIO;
  if (kind === "thumbs") return BASE_THUMBS;
  return BASE_POINTS;
}

// A report may carry the peak and RMS envelope plus the EBU R128 measurement,
// or only an older flat samples list. All of it is reduced to one shape here,
// so the lane has a single drawing path.
function waveOf(wave) {
  if (!wave) return null;
  if (wave.peak && wave.peak.length) {
    return {
      hz: wave.hz || 100,
      peak: wave.peak,
      rms: wave.rms && wave.rms.length ? wave.rms : wave.peak,
      peakDb: wave.peakDb,
      rmsDb: wave.rmsDb,
      clipped: wave.clipped || 0,
      sampleRate: wave.sampleRate || 0,
      loudness: wave.loudness || null,
    };
  }
  if (wave.samples && wave.samples.length) {
    const peak = new Array(wave.samples.length);
    let top = 0;
    for (let i = 0; i < wave.samples.length; i++) {
      const a = Math.abs(wave.samples[i] || 0);
      peak[i] = a;
      if (a > top) top = a;
    }
    return {
      hz: wave.hz || 100,
      peak,
      rms: peak,
      peakDb: toDb(top),
      rmsDb: toDb(top),
      clipped: 0,
      sampleRate: 0,
      loudness: wave.loudness || null,
    };
  }
  if (wave.loudness && wave.loudness.measured) {
    // A report that kept only the loudness series still gets a lane.
    return {
      hz: 100,
      peak: [],
      rms: [],
      peakDb: null,
      rmsDb: null,
      clipped: 0,
      sampleRate: 0,
      loudness: wave.loudness,
    };
  }
  return null;
}

export function timelineLanes(report, hidden) {
  const tl = report.timeline || { scte: [], frames: [], subs: [], audio: [] };
  const lanes = [];
  if ((report.thumbnails || []).length) {
    lanes.push({ pid: 0, kind: "thumbs", label: "I-frames", rows: report.thumbnails });
  }
  const byPid = (rows, kind) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.pid)) map.set(row.pid, []);
      map.get(row.pid).push(row);
    }
    for (const [pid, rowsOfPid] of map) lanes.push({ pid, kind, label: kind + " " + pid, rows: rowsOfPid });
  };
  byPid(tl.scte || [], "scte");
  byPid(tl.frames || [], "video");
  byPid(tl.subs || [], "subtitle");
  // Caption cues from the wasm decoder become their own lane, so a CEA-608
  // subtitle can be seen against the pictures and the SCTE cues.
  const cues = report.captions && report.captions.cues;
  if (cues && cues.length) {
    lanes.push({
      pid: 0,
      kind: "caption",
      label: "captions",
      rows: cues.map((cue) => ({ t: cue.t0, t1: cue.t1, text: cue.text })),
    });
  }
  const audio = new Map();
  for (const row of tl.audio || []) audio.set(row.pid, row.label);
  for (const wave of report.audio || []) {
    if (!audio.has(wave.pid)) audio.set(wave.pid, "audio");
  }
  for (const [pid, label] of audio) {
    const wave = waveOf((report.audio || []).find((w) => w.pid === pid));
    lanes.push({
      pid,
      kind: "audio",
      label: label + " " + pid,
      rows: [],
      wave,
      peak: wave ? wave.peak : null,
      rms: wave ? wave.rms : null,
      hz: wave ? wave.hz : 100,
      loudness: wave ? wave.loudness : null,
    });
  }
  return lanes.filter((lane) => !hidden.has(laneKey(lane)));
}

export function laneKey(lane) {
  return lane.kind + ":" + lane.pid;
}

export function allLaneKeys(report) {
  return timelineLanes(report, new Set()).map(laneKey);
}

export function cueMarkers(report) {
  const rows = (report.timeline && report.timeline.scte) || [];
  return rows.filter((row) => row.cue === "out" || row.cue === "in");
}

// Height the bar wants for a report with the current lanes shown.
export function timelineHeight(report, hidden) {
  const lanes = timelineLanes(report, hidden || new Set());
  let body = 0;
  for (const lane of lanes) body += baseHeight(lane.kind);
  return Math.max(MIN_HEIGHT, body + RULER + PAD * 2);
}

function tlFit(canvas, cssHeight) {
  const r = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const h = cssHeight;
  canvas.style.height = h + "px";
  canvas.width = Math.max(1, Math.floor(w * r));
  canvas.height = Math.max(1, Math.floor(h * r));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return { ctx, w, h };
}

let REDRAW = null;

export function onThumbnailLoad(fn) {
  REDRAW = fn;
}

function imageFor(thumb) {
  const key = thumb.t + ":" + (thumb.jpeg || "").length;
  let img = IMAGES.get(key);
  if (img) return img;
  img = new Image();
  img.onload = () => { if (REDRAW) REDRAW(); };
  img.src = "data:image/jpeg;base64," + (thumb.jpeg || "");
  IMAGES.set(key, img);
  return img;
}

export function resetThumbnailCache() {
  IMAGES.clear();
}

// Zoom about an anchor time, keeping the window inside the file. A factor
// above 1 zooms in. The span never goes under MIN_SPAN or over the file.
export function zoomSpan(t0, t1, factor, anchorT, duration) {
  const total = Math.max(1e-6, Number(duration) || 1);
  const span = Math.max(MIN_SPAN, Math.min(total, (t1 - t0) || total));
  const f = Number(factor) > 0 ? Number(factor) : 1;
  const next = Math.max(MIN_SPAN, Math.min(total, span / f));
  const anchor = anchorT === null || anchorT === undefined || !Number.isFinite(anchorT)
    ? t0 + span / 2
    : Math.max(t0, Math.min(t1, anchorT));
  const rel = (anchor - t0) / span;
  let a = anchor - rel * next;
  let b = a + next;
  if (a < 0) { a = 0; b = next; }
  if (b > total) { b = total; a = Math.max(0, total - next); }
  return { t0: a, t1: b };
}

// Slide the window by a number of seconds, clamped to the file.
export function panSpan(t0, t1, dt, duration) {
  const total = Math.max(1e-6, Number(duration) || 1);
  const span = Math.min(total, Math.max(MIN_SPAN, t1 - t0));
  const a = Math.max(0, Math.min(total - span, t0 + dt));
  return { t0: a, t1: a + span };
}

// Time under an x position in the canvas, or null outside the plot.
export function timeAtX(canvas, x) {
  const layout = canvas && canvas._layout;
  if (!layout) return null;
  const span = layout.span1 - layout.span0;
  const left = layout.ml;
  const right = layout.ml + layout.plotW;
  const clamped = Math.max(left, Math.min(right, x));
  return { t: layout.span0 + ((clamped - left) / Math.max(1, layout.plotW)) * span, inside: x >= left && x <= right };
}

export function drawMediaTimeline(canvas, report, view) {
  if (!canvas || !report) return 0;
  const hidden = view.hidden || new Set();
  const lanes = timelineLanes(report, hidden);
  const cues = cueMarkers(report);
  const showCues = !hidden.has("scte:cues");
  let base = 0;
  for (const lane of lanes) base += baseHeight(lane.kind);
  const wanted = view.height || (base + RULER + PAD * 2);
  const height = Math.max(MIN_HEIGHT, Math.round(wanted));
  const { ctx, w, h } = tlFit(canvas, height);
  const ml = 104;
  const mr = 16;
  const span0 = view.t0 || 0;
  const span1 = view.t1 || report.summary.durationS || 1;
  const span = Math.max(1e-6, span1 - span0);
  const plotW = Math.max(1, w - ml - mr);
  const xOf = (t) => ml + plotW * ((t - span0) / span);
  const ink2 = tlCss("--ink2");
  const grid = tlCss("--grid");
  const ink = tlCss("--ink");
  ctx.clearRect(0, 0, w, h);
  ctx.font = "11px ui-sans-serif, sans-serif";

  const rows = [];
  if (!lanes.length) {
    ctx.fillStyle = ink2;
    ctx.textAlign = "left";
    ctx.fillText("No pictures, SCTE, subtitles, or audio were found in this file.", ml, 30);
    canvas._lanes = [];
    canvas._rows = [];
    canvas._layout = { ml, mr, span0, span1, plotW, ruler: RULER, top: PAD, height };
    return height;
  }

  // Lanes fill whatever height the bar has. A taller bar gives each lane more
  // room, which is what makes the audio meter readable.
  const avail = Math.max(60, h - RULER - PAD);
  const scale = avail / Math.max(1, base);
  const tops = [];
  let y = PAD;
  for (const lane of lanes) {
    const lh = Math.max(16, Math.min(320, Math.round(baseHeight(lane.kind) * scale)));
    tops.push({ lane, top: y, height: lh });
    y += lh;
  }
  // Give any rounding leftover to the last lane so the ruler stays put.
  const used = y;
  if (tops.length && used < PAD + avail) tops[tops.length - 1].height += PAD + avail - used;

  for (const row of tops) {
    const lane = row.lane;
    const lh = row.height;
    const top = row.top;
    ctx.fillStyle = ink2;
    ctx.textAlign = "right";
    ctx.fillText(lane.label, ml - 10, top + lh / 2 + 4);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(ml, top + lh - 0.5);
    ctx.lineTo(w - mr, top + lh - 0.5);
    ctx.stroke();
    if (lane.kind === "audio") drawWave(ctx, lane, xOf, top, lh, span0, span1, ml, w - mr, view);
    else if (lane.kind === "thumbs") drawThumbs(ctx, lane, xOf, top, lh, ml, w - mr);
    else drawPoints(ctx, lane, xOf, top, lh, ml, w - mr, plotW, span0, span1);
    rows.push({ lane, top, height: lh });
  }

  if (showCues) {
    let labelRight = -1e9;
    for (const cue of cues) {
      const x = xOf(cue.t);
      cue._x = x;
      if (x < ml || x > w - mr) continue;
      const out = cue.cue === "out";
      ctx.save();
      ctx.strokeStyle = out ? "#f77737" : "#833ab4";
      ctx.lineWidth = 1.5;
      ctx.setLineDash(out ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x, RULER - 6);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const text = (out ? "CUE-OUT " : "CUE-IN ") + cue.t.toFixed(2) + "s";
      if (x - labelRight > ctx.measureText(text).width + 12) {
        ctx.fillStyle = out ? "#c2410c" : "#6d28d9";
        ctx.textAlign = "left";
        ctx.fillText(text, x + 4, 11);
        labelRight = x + ctx.measureText(text).width + 6;
      }
      ctx.restore();
    }
  }

  ctx.fillStyle = ink2;
  ctx.textAlign = "center";
  for (let k = 0; k <= 6; k++) {
    const t = span0 + span * k / 6;
    ctx.fillText(formatTime(t), xOf(t), h - 4);
  }
  if (view.hoverX !== undefined && view.hoverX !== null) {
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(view.hoverX, RULER - 6);
    ctx.lineTo(view.hoverX, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  canvas._lanes = lanes;
  canvas._rows = rows;
  canvas._layout = { ml, mr, span0, span1, plotW, ruler: RULER, top: PAD, height, cues: showCues ? cues : [] };
  return height;
}

function formatTime(t) {
  if (t >= 3600) return (t / 3600).toFixed(2) + "h";
  if (t >= 60) {
    const m = Math.floor(t / 60);
    return m + ":" + String(Math.floor(t % 60)).padStart(2, "0");
  }
  return t.toFixed(2) + "s";
}

function drawThumbs(ctx, lane, xOf, y, lh, left, right) {
  const thumbs = lane.rows || [];
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, y, right - left, lh);
  ctx.clip();
  const th = Math.max(12, lh - 12);
  const tw = Math.round(th * 16 / 9);
  let lastRight = -1e9;
  thumbs.forEach((thumb) => {
    const x = xOf(thumb.t);
    if (x > right + tw || x < left - tw) return;
    const img = imageFor(thumb);
    // Keep a filmstrip: skip a still that would overlap the previous one.
    if (x + tw * 0.6 < lastRight) return;
    if (img.complete && img.naturalWidth) ctx.drawImage(img, x, y + 2, tw, th);
    else {
      ctx.fillStyle = tlCss("--grid");
      ctx.fillRect(x, y + 2, tw, th);
    }
    ctx.strokeStyle = tlCss("--edge");
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y + 1.5, tw + 1, th + 1);
    lastRight = x + tw;
  });
  ctx.restore();
}

function lowerBound(rows, t) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function drawPoints(ctx, lane, xOf, y, lh, left, right, plotW, span0, span1) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, y, plotW, lh);
  ctx.clip();
  // Rows are in time order, so a window only has to walk the part it shows.
  const span = Math.max(1e-6, span1 - span0);
  const pad = span * 0.02;
  const rows = lane.rows;
  const from = Math.max(0, lowerBound(rows, span0 - pad) - 1);
  const to = Math.min(rows.length, lowerBound(rows, span1 + pad) + 1);
  const dense = (to - from) > plotW;
  const tick = dense ? 1 : Math.max(1, Math.min(4, plotW / Math.max(1, to - from)));
  for (let i = from; i < to; i++) {
    const row = rows[i];
    const x = xOf(row.t);
    if (x < left - 8 || x > right + 8) continue;
    if (lane.kind === "video") {
      ctx.fillStyle = row.idr ? "#9f1239" : (TL_FRAME_COLOR[row.frame] || TL_FRAME_COLOR["?"]);
      const wide = row.frame === "I" || row.idr;
      ctx.fillRect(x, y + 3, wide ? 3 : tick, lh - 6);
    } else if (lane.kind === "caption") {
      // A caption occupies a span, not an instant, so its cue is a bar.
      const x1 = Math.max(x + 2, xOf(row.t1 || row.t));
      ctx.fillStyle = "#fcaf45";
      ctx.fillRect(x, y + lh / 2 - 3, Math.max(2, Math.min(x1, right) - x), 6);
    } else if (lane.kind === "scte") {
      const color = row.cue === "out" ? "#f77737" : row.cue === "in" ? "#833ab4" : "#a49bb3";
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y + 3);
      ctx.lineTo(x + 5, y + lh / 2);
      ctx.lineTo(x, y + lh - 3);
      ctx.lineTo(x - 5, y + lh / 2);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = "#5851db";
      ctx.beginPath();
      ctx.arc(x, y + lh / 2, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Audio lane: the EBU R128 loudness curves on a LUFS scale when FFmpeg has
// measured them, with the resampled waveform drawn faintly behind as shape.
// Without a measurement the lane falls back to a dBFS waveform.
function drawWave(ctx, lane, xOf, y, lh, span0, span1, left, right, view) {
  const wave = lane.wave;
  const loud = wave && wave.loudness && wave.loudness.measured ? wave.loudness : null;
  const peak = lane.peak;
  const rms = lane.rms || peak;
  const hz = lane.hz || 100;
  const top = y + 6;
  const bottom = y + lh - 14;
  const plotW = Math.max(1, right - left);
  const span = Math.max(1e-6, span1 - span0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, y, plotW, lh);
  ctx.clip();

  if (!loud && (!peak || !peak.length)) {
    ctx.fillStyle = tlCss("--ink2");
    ctx.textAlign = "left";
    ctx.font = "11px ui-sans-serif, sans-serif";
    ctx.fillText("Audio not decoded yet. The chip decodes it with the embedded FFmpeg.", left + 8, y + lh / 2 + 4);
    ctx.restore();
    return;
  }

  if (loud) drawLoudness(ctx, lane, loud, y, lh, span0, span1, left, right, top, bottom, view);

  // Waveform shape, thin and low contrast behind the loudness curves.
  if (peak && peak.length && bottom - top > 12) {
    const mid = (top + bottom) / 2;
    const amp = (bottom - top) / 2;
    const cols = Math.max(1, Math.floor(plotW));
    const lo = Math.max(0, Math.floor(span0 * hz));
    const hi = Math.min(peak.length, Math.ceil(span1 * hz));
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const a = span0 + (c / cols) * span;
      const b = span0 + ((c + 1) / cols) * span;
      const f = Math.max(lo, Math.floor(a * hz));
      const g = Math.min(hi, Math.max(f + 1, Math.ceil(b * hz)));
      let p = 0;
      for (let i = f; i < g; i++) {
        const v = peak[i] || 0;
        if (v > p) p = v;
      }
      ctx.lineTo(left + c + 0.5, mid - Math.min(1, p) * amp);
    }
    for (let c = cols - 1; c >= 0; c--) {
      const a = span0 + (c / cols) * span;
      const b = span0 + ((c + 1) / cols) * span;
      const f = Math.max(lo, Math.floor(a * hz));
      const g = Math.min(hi, Math.max(f + 1, Math.ceil(b * hz)));
      let p = 0;
      for (let i = f; i < g; i++) {
        const v = peak[i] || 0;
        if (v > p) p = v;
      }
      ctx.lineTo(left + c + 0.5, mid + Math.min(1, p) * amp);
    }
    ctx.closePath();
    ctx.fillStyle = loud ? tlCss("--edge") : "#d6249f";
    ctx.globalAlpha = loud ? 0.55 : 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Readout under the pointer.
  const hoverX = view.hoverX;
  if (hoverX !== undefined && hoverX !== null && hoverX >= left && hoverX <= right && wave) {
    const t = span0 + ((hoverX - left) / plotW) * span;
    const level = levelAt(wave, t);
    if (level) {
      const bits = [];
      if (level.momentary !== null && level.momentary !== undefined) bits.push("M " + lufsText(level.momentary));
      if (level.shortTerm !== null && level.shortTerm !== undefined) bits.push("S " + lufsText(level.shortTerm));
      if (level.truePeakDb !== null && level.truePeakDb !== undefined) bits.push("TP " + level.truePeakDb.toFixed(1) + " dBFS");
      // The waveform is a mono downmix kept only for shape, so this peak is
      // labelled as such. The true peak above is measured on the real channels.
      bits.push("mono peak " + dbText(level.peakDb));
      const text = bits.join(" · ");
      ctx.font = "10px ui-sans-serif, sans-serif";
      const tw = ctx.measureText(text).width + 10;
      const bx = Math.min(right - tw, Math.max(left, hoverX + 8));
      ctx.fillStyle = tlCss("--panel");
      ctx.globalAlpha = 0.94;
      ctx.fillRect(bx, y + 2, tw, 15);
      ctx.globalAlpha = 1;
      ctx.fillStyle = tlCss("--ink");
      ctx.textAlign = "left";
      ctx.fillText(text, bx + 5, y + 13);
    }
  }
  ctx.restore();

  if (loud) {
    const target = Number.isFinite(loud.target) ? loud.target : -23;
    const parts = ["I " + lufsText(loud.integrated)];
    if (loud.lra) parts.push("LRA " + loud.lra.toFixed(1) + " LU");
    if (Number.isFinite(loud.truePeakDb)) parts.push("true peak " + loud.truePeakDb.toFixed(1) + " dBFS");
    parts.push("target " + target + " LUFS · " + luText(loud.integrated, target));
    if (Number.isFinite(loud.truePeakDb) && loud.truePeakDb > -1) parts.push("above -1 dBTP");
    ctx.fillStyle = tlCss("--ink2");
    ctx.font = "10px ui-sans-serif, sans-serif";
    ctx.textAlign = "left";
    ctx.globalAlpha = 0.9;
    ctx.fillText(parts.join(" · "), left + 4, y + lh - 4);
    ctx.globalAlpha = 1;
  } else if (wave) {
    const level = peakOf(wave);
    ctx.fillStyle = tlCss("--ink2");
    ctx.font = "10px ui-sans-serif, sans-serif";
    ctx.textAlign = "left";
    ctx.globalAlpha = 0.85;
    ctx.fillText("peak " + dbText(level.peakDb) + " · RMS " + dbText(level.rmsDb)
      + (level.clipped ? " · " + level.clipped + " clipped" : ""), left + 4, y + lh - 4);
    ctx.globalAlpha = 1;
  }
}

// EBU R 128 curves on a LUFS scale: momentary (400 ms), short-term (3 s) and
// the integrated value as a flat line, with the -23 LUFS target dashed and a
// true-peak lane above the scale. The vertical scale runs -50 to 0 LUFS.
function drawLoudness(ctx, lane, loud, y, lh, span0, span1, left, right, top, bottom, view) {
  const plotW = Math.max(1, right - left);
  const span = Math.max(1e-6, span1 - span0);
  const hz = loud.hz || 10;
  const yOf = (lufs) => {
    const v = Math.max(-50, Math.min(0, lufs));
    return top + (bottom - top) * (-v / 50);
  };

  ctx.font = "9px ui-sans-serif, sans-serif";
  ctx.textAlign = "right";
  for (const lufs of [0, -10, -20, -30, -40, -50]) {
    const gy = yOf(lufs);
    ctx.strokeStyle = tlCss("--grid");
    ctx.globalAlpha = lufs === 0 ? 1 : 0.45;
    ctx.beginPath();
    ctx.moveTo(left, gy + 0.5);
    ctx.lineTo(right, gy + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = tlCss("--ink2");
    ctx.fillText(String(lufs), left + 14, gy + 3);
  }
  ctx.globalAlpha = 1;

  // EBU R 128 target.
  if (loud.target !== undefined && loud.target !== null) {
    const gy = yOf(loud.target);
    ctx.strokeStyle = "#fdc468";
    ctx.setLineDash([4, 3]);
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(left, gy + 0.5);
    ctx.lineTo(right, gy + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Integrated loudness across the window shown.
  if (Number.isFinite(loud.integrated)) {
    const gy = yOf(loud.integrated);
    ctx.strokeStyle = "#fdc468";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left, gy + 0.5);
    ctx.lineTo(right, gy + 0.5);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  const series = (values, color, width, dash) => {
    if (!values || !values.length) return;
    const lo = Math.max(0, Math.floor(span0 * hz));
    const hi = Math.min(values.length, Math.ceil(span1 * hz));
    if (hi <= lo) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    let started = false;
    for (let i = lo; i < hi; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      const x = left + (i / hz - span0) / span * plotW;
      const py = yOf(v);
      if (!started) {
        ctx.moveTo(x, py);
        started = true;
      } else ctx.lineTo(x, py);
    }
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
    ctx.lineWidth = 1;
  };

  series(loud.shortTerm, "#833ab4", 1.1, [3, 2]);
  series(loud.momentary, "#d6249f", 1.6, null);

  // Legend, small enough not to hide the curve.
  const items = [["M", "#d6249f"], ["S", "#833ab4"]];
  ctx.textAlign = "left";
  let lx = right - 4;
  for (let i = items.length - 1; i >= 0; i--) {
    const [name, color] = items[i];
    const w = ctx.measureText(name).width + 14;
    lx -= w;
    ctx.fillStyle = color;
    ctx.fillRect(lx, y + 4, 8, 2);
    ctx.fillStyle = tlCss("--ink2");
    ctx.textAlign = "left";
    ctx.fillText(name, lx + 11, y + 8);
  }
}

export function hitTimeline(canvas, event) {
  const layout = canvas._layout;
  const rows = canvas._rows || [];
  if (!layout) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < layout.ml) return null;
  for (const cue of layout.cues || []) {
    if (cue._x !== undefined && Math.abs(cue._x - x) <= 5) return { lane: { kind: "cue" }, row: cue, t: cue.t };
  }
  const span = Math.max(1e-6, layout.span1 - layout.span0);
  const t = layout.span0 + ((Math.max(layout.ml, Math.min(layout.ml + layout.plotW, x)) - layout.ml) / layout.plotW) * span;
  for (const row of rows) {
    if (y < row.top || y >= row.top + row.height) continue;
    const lane = row.lane;
    if (lane.kind === "audio") return { lane, row: null, t };
    let best = null;
    let bestDx = lane.kind === "thumbs" ? 40 : 9;
    for (const item of lane.rows) {
      const rx = layout.ml + layout.plotW * ((item.t - layout.span0) / span);
      const dx = Math.abs(rx - x);
      if (dx < bestDx) {
        best = item;
        bestDx = dx;
      }
    }
    return { lane, row: best, t };
  }
  return null;
}
