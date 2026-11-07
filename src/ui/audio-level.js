// Audio levels. Two things arrive from one FFmpeg pass over an audio PID:
// an EBU R128 measurement of the untouched stream (momentary, short-term and
// integrated loudness, loudness range, true peak) and a resampled mono PCM
// copy used only to draw the waveform shape. The dB readouts come from
// R128, never from the downsampled copy.
//
// The same file runs in the page, in the FFmpeg worker (build.py
// concatenates it ahead of it), and in the headless command.

export const MAX_POINTS = 100000;
export const CLIP_LEVEL = 0.999;
export const SILENT_DB = -120;
export const SILENT_LUFS = -70; // the absolute gate in BS.1770
export const TARGET_LUFS = -23; // EBU R 128 target
export const LEVEL_BUDGET = 32 * 1024 * 1024;

// Waveform PCM rate. The dB numbers do not come from this copy, so a rate
// that only has to show shape is enough.
export const WAVE_RATE = 8000;

// Rate steps tried when the whole file fits in one decode, loudest first.
const RATES = [48000, 44100, 32000, 24000, 16000, 12000, 8000, 6000, 4000, 2000, 1000];

// Highest mono float rate whose PCM fits the budget for a capture this long.
export function decodeRateFor(durationS, budgetBytes = LEVEL_BUDGET) {
  const seconds = Math.max(0.001, Number(durationS) || 0);
  const fit = budgetBytes / (4 * seconds);
  for (const rate of RATES) if (rate <= fit) return rate;
  return 1000;
}

// One decode, or a run of chunks with a seek per chunk. Chunk starts land on
// whole seconds and every chunk is a whole number of 10 ms windows, so the
// envelopes join without a seam and the loudness blocks stay on a 100 ms grid.
export function decodePlan(durationS, budgetBytes = LEVEL_BUDGET) {
  const duration = Math.max(0, Number(durationS) || 0);
  const single = decodeRateFor(duration || 1, budgetBytes);
  if (!duration || single >= WAVE_RATE) {
    return { rate: Math.max(1, Math.min(48000, single)), chunkS: 0, duration };
  }
  return { rate: WAVE_RATE, chunkS: 600, duration };
}

export function toDb(v) {
  if (!v || v <= 0) return SILENT_DB;
  return Math.max(SILENT_DB, Math.round(20 * Math.log10(v) * 10) / 10);
}

// A dB value is already a level; a linear amplitude needs converting. Callers
// pass dB, so this only has to guard against silence and NaN.
export function dbText(v) {
  if (!Number.isFinite(v) || v <= SILENT_DB + 0.05) return "-inf dBFS";
  return v.toFixed(1) + " dBFS";
}

export function lufsText(v) {
  if (!Number.isFinite(v) || v <= SILENT_LUFS + 0.05) return "-inf LUFS";
  return v.toFixed(1) + " LUFS";
}

// Loudness in LU relative to an EBU R 128 target, for a compact summary.
export function luText(v, target) {
  const base = Number.isFinite(target) ? target : TARGET_LUFS;
  if (!Number.isFinite(v) || v <= SILENT_LUFS + 0.05) return "silent";
  const delta = Math.round((v - base) * 10) / 10;
  return (delta > 0 ? "+" : "") + delta.toFixed(1) + " LU";
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

function emptyEnvelope(sampleRate) {
  return {
    hz: 100,
    peak: [],
    rms: [],
    peakDb: SILENT_DB,
    rmsDb: SILENT_DB,
    clipped: 0,
    sampleRate: sampleRate || 0,
    durationS: 0,
  };
}

// One pass over the samples. Each window keeps the peak amplitude and the
// RMS. Windows are 10 ms at the usual rates, so hz comes out at 100. The
// running energy is returned so chunk envelopes can be merged exactly.
export function envelope(pcm, rate, opts = {}) {
  const n = pcm ? pcm.length : 0;
  const sampleRate = Math.max(1, Number(rate) || 1);
  const maxPoints = Math.max(1, opts.maxPoints || MAX_POINTS);
  if (!n) return { ...emptyEnvelope(sampleRate), sumSq: 0, n: 0 };

  const hop = Math.max(1, Math.round(sampleRate / 100), Math.ceil(n / maxPoints));
  const count = Math.ceil(n / hop);
  const peak = new Array(count);
  const rms = new Array(count);
  let clipped = 0;
  let loudest = 0;
  let sumSq = 0;

  for (let w = 0; w < count; w++) {
    const from = w * hop;
    const to = Math.min(n, from + hop);
    let top = 0;
    let sq = 0;
    for (let i = from; i < to; i++) {
      const v = pcm[i];
      const a = v < 0 ? -v : v;
      if (a > top) top = a;
      if (a >= CLIP_LEVEL) clipped += 1;
      sq += v * v;
    }
    peak[w] = round4(top);
    rms[w] = round4(Math.sqrt(sq / Math.max(1, to - from)));
    sumSq += sq;
    if (top > loudest) loudest = top;
  }

  return {
    hz: Math.round((sampleRate / hop) * 1000) / 1000,
    peak,
    rms,
    peakDb: toDb(loudest),
    rmsDb: toDb(Math.sqrt(sumSq / n)),
    clipped,
    sampleRate,
    durationS: Math.round((n / sampleRate) * 1000) / 1000,
    sumSq,
    n,
  };
}

// Build one envelope from the pieces of a chunked decode. Clipping adds up
// and the energy is summed over every sample, so the summary lines describe
// the whole file even though no single decode saw all of it.
export function mergeEnvelopes(parts, sampleRate) {
  const kept = (parts || []).filter((p) => p && p.peak && p.peak.length);
  if (!kept.length) return emptyEnvelope(sampleRate);
  const peak = [];
  const rms = [];
  let clipped = 0;
  let loudest = 0;
  let sumSq = 0;
  let n = 0;
  for (const part of kept) {
    for (let i = 0; i < part.peak.length; i++) {
      const v = part.peak[i];
      peak.push(v);
      if (v > loudest) loudest = v;
      rms.push(part.rms ? part.rms[i] || 0 : v);
    }
    clipped += part.clipped || 0;
    sumSq += part.sumSq || 0;
    n += part.n || 0;
  }
  const hz = kept[0].hz || 100;
  return {
    hz,
    peak,
    rms,
    peakDb: toDb(loudest),
    rmsDb: n ? toDb(Math.sqrt(sumSq / n)) : SILENT_DB,
    clipped,
    sampleRate: sampleRate || kept[0].sampleRate || 0,
    durationS: Math.round((peak.length / hz) * 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------
// EBU R 128. FFmpeg's ebur128 filter prints one block per 100 ms:
//
//   frame:12   pts:57600  pts_time:1.2
//   lavfi.r128.M=-21.184      momentary loudness (400 ms window)
//   lavfi.r128.S=-23.001      short-term loudness (3 s window)
//   lavfi.r128.I=-23.190      integrated so far
//   lavfi.r128.LRA=2.000      loudness range so far
//   lavfi.r128.true_peak=0.224
//
// M is exactly the 400 ms block loudness the BS.1770 integrated measurement
// gates, so the integrated number can be recomputed from the blocks. That is
// what makes a chunked decode come out the same as one pass.

const FRAME = /^frame:\d+\s+pts:-?\d+\s+pts_time:(-?[\d.]+)/;
const FIELD = /^lavfi\.r128\.([A-Za-z_]+)=(-?[\d.]+)/;

export function parseLoudnessLog(text) {
  const blocks = { t: [], momentary: [], shortTerm: [], integrated: [], lra: [], truePeak: [] };
  if (!text) return blocks;
  let t = null;
  let pending = null;
  const push = () => {
    if (pending === null) return;
    blocks.t.push(pending.t);
    blocks.momentary.push(pending.M);
    blocks.shortTerm.push(pending.S);
    blocks.integrated.push(pending.I);
    blocks.lra.push(pending.LRA);
    blocks.truePeak.push(pending.peak);
  };
  for (const line of text.split("\n")) {
    const m = FRAME.exec(line);
    if (m) {
      push();
      t = Number(m[1]);
      pending = { t, M: SILENT_LUFS, S: SILENT_LUFS, I: SILENT_LUFS, LRA: 0, peak: 0 };
      continue;
    }
    const f = FIELD.exec(line);
    if (!f || pending === null) continue;
    const value = Number(f[2]);
    if (f[1] === "M") pending.M = Math.max(SILENT_LUFS, value);
    else if (f[1] === "S") pending.S = Math.max(SILENT_LUFS, value);
    else if (f[1] === "I") pending.I = Math.max(SILENT_LUFS, value);
    else if (f[1] === "LRA") pending.LRA = value;
    else if (f[1] === "true_peak") pending.peak = value;
  }
  push();
  return blocks;
}

// K-weighted energy of a block, relative to full scale. LUFS = -0.691 +
// 10 log10(z), so z = 10^((L + 0.691) / 10).
function energy(lufs) {
  if (!Number.isFinite(lufs)) return 0;
  return 10 ** ((Math.min(lufs, 0) + 0.691) / 10);
}

function loudness(z) {
  if (!(z > 0)) return SILENT_LUFS;
  return Math.max(SILENT_LUFS, -0.691 + 10 * Math.log10(z));
}

// Gated integrated loudness over 400 ms blocks (BS.1770-4 2.8): an absolute
// gate at -70 LUFS, then a relative gate 10 LU below the first result.
export function integratedLoudness(blocks) {
  const z = [];
  for (const m of blocks || []) {
    const e = energy(m);
    if (e > 0) z.push(e);
  }
  if (!z.length) return SILENT_LUFS;
  const abs = energy(SILENT_LUFS);
  let kept = z.filter((e) => e >= abs);
  if (!kept.length) return SILENT_LUFS;
  const first = kept.reduce((a, b) => a + b, 0) / kept.length;
  const gate = first / 10; // -10 LU
  kept = kept.filter((e) => e >= gate);
  if (!kept.length) return SILENT_LUFS;
  return Math.round(loudness(kept.reduce((a, b) => a + b, 0) / kept.length) * 10) / 10;
}

// Loudness range (EBU Tech 3342): short-term blocks gated the same way, then
// the 10th to 95th percentile.
export function loudnessRange(shortTerm) {
  const z = [];
  for (const s of shortTerm || []) {
    const e = energy(s);
    if (e > 0) z.push(e);
  }
  if (z.length < 2) return 0;
  const abs = energy(SILENT_LUFS);
  let kept = z.filter((e) => e >= abs);
  if (kept.length < 2) return 0;
  const first = kept.reduce((a, b) => a + b, 0) / kept.length;
  kept = kept.filter((e) => e >= first / 100); // -20 LU
  if (kept.length < 2) return 0;
  const values = kept.map(loudness).sort((a, b) => a - b);
  const at = (p) => values[Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * p)))];
  return Math.round((at(0.95) - at(0.1)) * 10) / 10;
}

// Blocks are 100 ms. A long capture is stored with a stride so the series
// stays a sane size, keeping the loudest block of each group so a spike is
// never dropped.
export const BLOCK_HZ = 10;
export const MAX_BLOCKS = 20000;

function compress(values, stride) {
  if (stride <= 1) return values.slice();
  const out = [];
  for (let i = 0; i < values.length; i += stride) {
    let top = values[i];
    for (let k = i + 1; k < Math.min(values.length, i + stride); k++) {
      if (values[k] > top) top = values[k];
    }
    out.push(top);
  }
  return out;
}

// Turn parsed blocks into the loudness part of a report entry.
export function loudnessOf(blocks, opts = {}) {
  if (!blocks || !blocks.momentary || !blocks.momentary.length) return null;
  const maxBlocks = Math.max(10, opts.maxBlocks || MAX_BLOCKS);
  const stride = Math.max(1, Math.ceil(blocks.momentary.length / maxBlocks));
  const truePeak = (blocks.truePeak && blocks.truePeak.length)
    ? blocks.truePeak
    : (blocks.truePeakCurve || []);
  let peak = 0;
  for (const v of truePeak) if (v > peak) peak = v;
  return {
    measured: true,
    hz: BLOCK_HZ / stride,
    stride,
    blocks: blocks.momentary.length,
    target: TARGET_LUFS,
    integrated: integratedLoudness(blocks.momentary),
    lra: loudnessRange(blocks.shortTerm),
    truePeakDb: peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : null,
    momentary: compress(blocks.momentary, stride),
    shortTerm: compress(blocks.shortTerm || blocks.momentary, stride),
    truePeakCurve: truePeak.length ? compress(truePeak, stride) : [],
  };
}

// Join the loudness blocks of several chunks. The block grid is 100 ms and
// every chunk starts on a whole second, so the arrays simply concatenate,
// and the integrated value is recomputed over every block rather than
// averaged from the per-chunk numbers.
export function mergeLoudness(parts) {
  const kept = (parts || []).filter((p) => p && p.momentary && p.momentary.length);
  if (!kept.length) return null;
  const momentary = [];
  const shortTerm = [];
  const truePeak = [];
  for (const part of kept) {
    for (let i = 0; i < part.momentary.length; i++) {
      momentary.push(part.momentary[i]);
      shortTerm.push(part.shortTerm ? part.shortTerm[i] : part.momentary[i]);
      truePeak.push(part.truePeakCurve ? part.truePeakCurve[i] || 0 : 0);
    }
  }
  return loudnessOf({ momentary, shortTerm, truePeak });
}

// Loudest window over the whole envelope and the R128 summary, for the lane
// label. Falls back to the envelope when a report has no measured loudness.
export function peakOf(wave) {
  if (!wave) return { peakDb: SILENT_DB, rmsDb: SILENT_DB, clipped: 0, loudness: null };
  const loud = wave.loudness || null;
  let peakDb = Number.isFinite(wave.peakDb) ? wave.peakDb : SILENT_DB;
  if (!(peakDb > SILENT_DB)) {
    let top = 0;
    for (const v of wave.peak || []) if (v > top) top = v;
    peakDb = toDb(top);
  }
  return {
    peakDb,
    rmsDb: Number.isFinite(wave.rmsDb) ? wave.rmsDb : SILENT_DB,
    clipped: wave.clipped || 0,
    loudness: loud,
  };
}

// Values at one point in time, for the readout under the pointer.
export function levelAt(wave, t) {
  if (!wave) return null;
  const at = Math.max(0, Number(t) || 0);
  const out = { t: at, peakDb: SILENT_DB, rmsDb: SILENT_DB, momentary: null, shortTerm: null, truePeakDb: null };
  if (wave.peak && wave.peak.length) {
    const hz = wave.hz || 100;
    const i = Math.max(0, Math.min(wave.peak.length - 1, Math.round(at * hz)));
    out.peakDb = toDb(wave.peak[i] || 0);
    out.rmsDb = wave.rms && wave.rms.length ? toDb(wave.rms[i] || 0) : out.peakDb;
  }
  const loud = wave.loudness;
  if (loud && loud.momentary && loud.momentary.length) {
    const i = Math.max(0, Math.min(loud.momentary.length - 1, Math.round(at * (loud.hz || 10))));
    out.momentary = loud.momentary[i];
    out.shortTerm = loud.shortTerm ? loud.shortTerm[i] : null;
    const p = loud.truePeakCurve && loud.truePeakCurve[i];
    out.truePeakDb = p > 0 ? Math.round(20 * Math.log10(p) * 10) / 10 : null;
  }
  return out;
}
