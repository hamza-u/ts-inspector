// Classic worker. The Emscripten core is concatenated ahead of this file by
// build.py, so there is no importScripts: Chrome blocks it on a blob worker
// that came from a file:// page. The wasm bytes arrive with the init message
// and go to Module.wasmBinary, so nothing is fetched either.

let core = null;
let logLines = [];

function capture(message) {
  if (message) logLines.push(String(message));
}

function toBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function unlink(name) {
  try { core.FS.unlink(name); } catch (err) { /* first run */ }
}

function readText(name) {
  try {
    return core.FS.readFile(name, { encoding: "utf8" });
  } catch (err) {
    return "";
  }
}

// Read a float32 PCM file into a plain array the envelope can walk.
function pcmOf(name) {
  const raw = core.FS.readFile(name);
  const copy = new Float32Array(raw.byteLength / 4);
  copy.set(new Float32Array(raw.buffer, raw.byteOffset, copy.length));
  return copy;
}

// One ffmpeg pass over a window of the audio. The graph splits the input:
// one branch measures EBU R128 on the untouched samples and writes a
// metadata log, the other is resampled to a small mono PCM used only for the
// waveform shape. The dB readouts come from the R128 branch, so nothing is
// ever measured off the downsampled copy.
function decodeWindow(input, tag, rate, from, length) {
  const meta = "lv-" + tag + ".txt";
  const pcmName = "wf-" + tag + ".pcm";
  unlink(meta);
  unlink(pcmName);
  const graph = "[0:a:0]asplit=2[lv][wf];"
    + "[lv]ebur128=peak=true:metadata=1,ametadata=print:file=" + meta + ",anullsink;"
    + "[wf]aresample=" + rate + ",aformat=sample_fmts=flt:channel_layouts=mono[pcm]";
  const args = ["-hide_banner", "-loglevel", "error"];
  if (from > 0) args.push("-ss", String(from));
  if (length > 0) args.push("-t", String(length));
  args.push("-i", input, "-filter_complex", graph, "-map", "[pcm]", "-f", "f32le", pcmName);
  args.push("-f", "null", "-");
  let code = 0;
  try {
    code = core.exec(...args);
  } catch (err) {
    capture(err && err.message ? err.message : err);
    code = -1;
  }
  const blocks = parseLoudnessLog(readText(meta));
  let pcm = null;
  try {
    pcm = pcmOf(pcmName);
  } catch (err) {
    pcm = null;
  }
  unlink(meta);
  unlink(pcmName);
  return { code, pcm, blocks };
}

function wave(msg) {
  logLines = [];
  const input = "audio-" + msg.pid + ".ts";
  unlink(input);
  core.FS.writeFile(input, msg.bytes);
  const plan = decodePlan(msg.durationS, msg.budget || LEVEL_BUDGET);
  const rate = msg.rate || plan.rate;
  core.setTimeout(600000);

  const envelopes = [];
  const loudness = [];
  let code = 0;
  let windows = 0;

  const run = (from, length) => {
    const tag = String(windows);
    windows += 1;
    const one = decodeWindow(input, tag, rate, from, length);
    if (one.code !== 0) code = one.code;
    if (one.pcm && one.pcm.length) envelopes.push(envelope(one.pcm, rate));
    if (one.blocks && one.blocks.momentary.length) loudness.push(loudnessOf(one.blocks));
    return !!(one.pcm && one.pcm.length);
  };

  if (!plan.chunkS || plan.chunkS >= plan.duration) {
    run(0, 0);
  } else {
    for (let start = 0; start < plan.duration; start += plan.chunkS) {
      run(start, plan.chunkS);
      self.postMessage({
        type: "progress",
        pid: msg.pid,
        done: Math.min(plan.duration, start + plan.chunkS),
        total: plan.duration,
      });
    }
  }
  unlink(input);

  const merged = mergeEnvelopes(envelopes, rate);
  const loud = mergeLoudness(loudness);
  if (!merged.peak.length && !loud) {
    self.postMessage({
      type: "error",
      pid: msg.pid,
      message: "ffmpeg produced no audio (exit " + code + ")",
      log: logLines.slice(-40).join("\n"),
    });
    return;
  }
  self.postMessage({
    type: "wave",
    pid: msg.pid,
    rate,
    chunked: !!plan.chunkS && plan.chunkS < plan.duration,
    envelope: {
      hz: merged.hz,
      peak: merged.peak,
      rms: merged.rms,
      peakDb: merged.peakDb,
      rmsDb: merged.rmsDb,
      clipped: merged.clipped,
      sampleRate: merged.sampleRate,
      durationS: merged.durationS,
      loudness: loud,
    },
  });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === "init") {
      if (typeof createFFmpegCore !== "function") {
        throw new Error("FFmpeg core is missing from this build");
      }
      core = await createFFmpegCore({ wasmBinary: toBytes(msg.wasmB64) });
      core.setLogger((row) => capture(row && row.message ? row.message : row));
      self.postMessage({ type: "ready" });
      return;
    }
    if (msg.type === "thumbs" && core) {
      try {
        await thumbs(msg);
      } catch (err) {
        self.postMessage({
          type: "error",
          pid: "thumbs",
          message: String(err && err.message ? err.message : err),
          log: logLines.slice(-40).join("\n"),
        });
      }
      return;
    }
    if ((msg.type === "wave" || msg.type === "decode") && core) {
      wave(msg);
      return;
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      pid: msg.pid,
      message: String(err && err.message ? err.message : err),
      log: logLines.slice(-40).join("\n"),
    });
  }
};

function toBase64(bytes) {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(out);
}

function clearThumbs() {
  try {
    const names = core.FS.readdir("/");
    for (const name of names) {
      if (/^thumb-\d+\.jpg$/.test(name)) {
        try { core.FS.unlink(name); } catch (err) { /* already gone */ }
      }
    }
  } catch (err) { /* empty FS */ }
}

async function thumbs(msg) {
  logLines = [];
  core.setTimeout(300000);
  const jobs = msg.jobs && msg.jobs.length ? msg.jobs : [{ name: "thumb-in.ts", bytes: msg.bytes, times: msg.times || [] }];
  const outputs = [];
  for (const job of jobs) {
    const input = job.name;
    try { core.FS.unlink(input); } catch (err) { /* first run */ }
    core.FS.writeFile(input, job.bytes);
    clearThumbs();
    // First I frame in this window. The window starts just before the target
    // I frame, and a decoder must start on a keyframe anyway.
    const args = [
      "-i", input,
      "-map", "0:v:0",
      "-vf", "select='eq(pict_type\\,I)',scale=320:-2",
      "-fps_mode", "passthrough",
      "-frames:v", "1",
      "-q:v", "6",
      "-f", "image2", "thumb-001.jpg",
    ];
    try {
      core.exec(...args);
    } catch (err) {
      capture(err && err.message ? err.message : err);
    }
    let raw = null;
    try { raw = core.FS.readFile("thumb-001.jpg"); } catch (err) { raw = null; }
    try { core.FS.unlink(input); } catch (err) { /* keep going */ }
    if (!raw || raw.length < 100 || raw[0] !== 0xFF || raw[1] !== 0xD8) continue;
    outputs.push({
      t: job.times && job.times[0] !== undefined ? job.times[0] : 0,
      jpeg: toBase64(raw),
      w: 320,
      h: 180,
    });
  }
  if (!outputs.length) {
    self.postMessage({
      type: "error",
      pid: "thumbs",
      message: "No I-frame thumbnail was produced",
      log: logLines.slice(-40).join("\n"),
    });
    return;
  }
  self.postMessage({ type: "thumbs", items: outputs });
}
