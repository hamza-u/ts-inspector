#!/usr/bin/env node
// Headless analysis. Same inspector as the page, streamed from disk.
// --audio asks a native ffmpeg on PATH for EBU R128 loudness and a waveform.

import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { wrapReport } from "../src/report.js";
import { createInspector } from "../src/worker/inspect.js";
import { decodePlan, envelope, LEVEL_BUDGET, loudnessOf, mergeEnvelopes, mergeLoudness, parseLoudnessLog } from "../src/ui/audio-level.js";
import { compareScte, parseSrt } from "../src/ui/tools.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function help() {
  console.log(`ts-inspector capture.ts [-o report.json] [--audio] [--thumbs [N]] [--summary] [--fail-on fail]
              [--captions] [--teletext-srt DIR] [--scte-check] [--fail-on-diff]

Writes a versioned report JSON. Exit 0 after a parse, 1 when --fail-on fail
and a compliance row failed, 2 when the file could not be analysed.
--audio measures EBU R128 loudness (momentary, short-term, integrated, LRA,
    true peak) for each audio PID and keeps a small waveform for shape.
--thumbs adds N (default 12) I-frame stills at about 320 px wide.
--captions writes SubRip for CEA-608/708 into the report (needs the wasm tools).
--teletext-srt DIR writes one .srt per teletext subtitle page to DIR.
--scte-check parses every SCTE-35 section a second time with libklscte35 and
    lists any field where the two parsers disagree.`);
}

function parseArgs(argv) {
  const out = {
    input: "", output: "", audio: false, summary: false, failOn: "", help: false, thumbs: 0,
    captions: false, teletextDir: "", scteCheck: false, failOnDiff: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "-o" || arg === "--output") out.output = argv[++i] || "";
    else if (arg === "--audio") out.audio = true;
    else if (arg === "--thumbs") {
      const next = argv[i + 1];
      out.thumbs = next && /^\d+$/.test(next) ? Number(argv[++i]) : 12;
    }
    else if (arg === "--summary") out.summary = true;
    else if (arg === "--captions") out.captions = true;
    else if (arg === "--teletext-srt") out.teletextDir = argv[++i] || "";
    else if (arg === "--scte-check") out.scteCheck = true;
    else if (arg === "--fail-on-diff") out.failOnDiff = true;
    else if (arg === "--fail-on") out.failOn = argv[++i] || "";
    else if (!arg.startsWith("-") && !out.input) out.input = arg;
    else throw new Error("unknown argument " + arg);
  }
  return out;
}

function pcmSamples(buffer) {
  const out = new Float32Array(buffer.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

function extractThumbs(path, iFrames, count) {
  if (!count) return [];
  const picks = iFrames.length <= count
    ? iFrames.map((row) => row.t)
    : Array.from({ length: count }, (_, i) => iFrames[Math.round(i * (iFrames.length - 1) / (count - 1))].t);
  const out = [];
  // One short decode per still, each starting on its own I frame. A single
  // pass over the whole file would only ever reach the first few.
  for (let i = 0; i < picks.length; i++) {
    const name = path + ".still-" + i + ".jpg";
    const run = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(Math.max(0, picks[i])),
      "-i", path,
      "-map", "0:v:0", "-frames:v", "1",
      "-vf", "scale=320:-2", "-q:v", "6",
      name,
    ], { maxBuffer: 16 * 1024 * 1024 });
    if (run.error || run.status !== 0) continue;
    let jpeg = null;
    try { jpeg = readFileSync(name); } catch (err) { jpeg = null; }
    try { unlinkSync(name); } catch (err) { /* already gone */ }
    if (!jpeg || jpeg.length < 100 || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) continue;
    const slot = iFrames.find((row) => row.t === picks[i]) || iFrames[Math.min(i, iFrames.length - 1)];
    out.push({
      t: picks[i],
      packetIndex: slot ? slot.packetIndex : -1,
      w: 320,
      h: 180,
      jpeg: jpeg.toString("base64"),
    });
  }
  return out;
}

// Native ffmpeg reads the file itself, so the capture size has never been a
// limit here. One pass measures EBU R128 on the untouched stream and writes
// a metadata log; a second, small branch is resampled for the waveform shape.
// The dB readouts come from R128, never from the downsampled copy.
function decodeWindow(path, pid, rate, from, length, metaPath) {
  const graph = "[0:i:" + pid + "]asplit=2[lv][wf];"
    + "[lv]ebur128=peak=true:metadata=1,ametadata=print:file=" + metaPath + ",anullsink;"
    + "[wf]aresample=" + rate + ",aformat=sample_fmts=flt:channel_layouts=mono[pcm]";
  const args = ["-hide_banner", "-loglevel", "error"];
  if (from > 0) args.push("-ss", String(from));
  args.push("-i", path, "-filter_complex", graph, "-map", "[pcm]", "-f", "f32le", "pipe:1");
  if (length > 0) args.push("-t", String(length));
  args.push("-f", "null", "-");
  const run = spawnSync("ffmpeg", args, { maxBuffer: LEVEL_BUDGET + 8 * 1024 * 1024 });
  let meta = "";
  try { meta = readFileSync(metaPath, "utf8"); } catch (err) { meta = ""; }
  try { unlinkSync(metaPath); } catch (err) { /* already gone */ }
  const blocks = parseLoudnessLog(meta);
  const pcm = run.stdout && run.stdout.length ? pcmSamples(run.stdout) : null;
  if (!pcm && !blocks.momentary.length) return null;
  return { pcm, blocks };
}

function decodeAudio(path, pid, durationS) {
  const plan = decodePlan(durationS, LEVEL_BUDGET);
  const envelopes = [];
  const loudness = [];
  const run = (from, length, index) => {
    const metaPath = path + ".r128-" + index + ".txt";
    const one = decodeWindow(path, pid, plan.rate, from, length, metaPath);
    if (!one) return false;
    if (one.pcm) envelopes.push(envelope(one.pcm, plan.rate));
    if (one.blocks.momentary.length) loudness.push(loudnessOf(one.blocks));
    return true;
  };
  if (!plan.chunkS || plan.chunkS >= plan.duration) {
    if (!run(0, 0, 0)) console.error("audio PID " + pid + ": ffmpeg produced no PCM");
  } else {
    let index = 0;
    for (let start = 0; start < plan.duration; start += plan.chunkS) {
      if (!run(start, plan.chunkS, index)) {
        console.error("audio PID " + pid + ": nothing for the window at " + start + " s");
      }
      index += 1;
    }
  }
  const merged = mergeEnvelopes(envelopes, plan.rate);
  const loud = mergeLoudness(loudness);
  if (!merged.peak.length && !loud) return null;
  console.error("audio PID " + pid + (loud
    ? ": I " + loud.integrated.toFixed(1) + " LUFS, LRA " + loud.lra.toFixed(1) + " LU"
      + (loud.truePeakDb !== null ? ", true peak " + loud.truePeakDb.toFixed(1) + " dBFS" : "")
    : ": peak " + merged.peakDb.toFixed(1) + " dBFS")
    + (plan.chunkS ? " in chunks" : ""));
  return {
    pid,
    hz: merged.hz,
    sampledRate: plan.rate,
    chunked: !!plan.chunkS && plan.chunkS < plan.duration,
    peakDb: merged.peakDb,
    rmsDb: merged.rmsDb,
    clipped: merged.clipped,
    sampleRate: plan.rate,
    durationS: merged.durationS,
    peak: merged.peak,
    rms: merged.rms,
    loudness: loud,
  };
}

// --- the bundled wasm tools ------------------------------------------------

// The same three modules the page uses, loaded from vendor/ into Node. The
// Emscripten glue is CommonJS-shaped, so it is evaluated with a require of its
// own and the factory it defines is returned.
function loadFactory(file, name) {
  if (!existsSync(file)) return null;
  const require = createRequire(import.meta.url);
  const text = readFileSync(file, "utf8");
  const build = new Function("require", "module", "exports", "__dirname", "__filename",
    text + "\nreturn " + name + ";");
  return build(require, { exports: {} }, {}, dirname(file), file);
}

async function openTools() {
  const out = {
    ccextractor: loadFactory(ROOT + "/vendor/ccextractor/ccextractor.js", "createModule"),
    telxcc: loadFactory(ROOT + "/vendor/telxcc/telxcc.js", "createTelx"),
    klscte35: loadFactory(ROOT + "/vendor/libklscte35/libklscte35.js", "createKl"),
  };
  if (!out.ccextractor && !out.telxcc && !out.klscte35) {
    throw new Error("The wasm tools are not built. Run: python3 scripts/build_wasm.py");
  }
  return out;
}

// The capture is mounted with NODEFS, so the tools read it in place and never
// load it into memory here.
function mount(mod, path, point) {
  // NODEFS needs an absolute host path, and the CLI may be given a relative one.
  // klMountNode creates the mount point, so it must not exist yet; a fresh
  // module instance per job guarantees that.
  const full = resolve(path);
  mod.klMountNode(mod.FS, dirname(full), point);
  return point + "/" + basename(full);
}

async function captionsOf(tools, path) {
  if (!tools.ccextractor) throw new Error("ccextractor.wasm is not built");
  const mod = await tools.ccextractor({
    print: () => {},
    printErr: () => {},
    locateFile: (name) => ROOT + "/vendor/ccextractor/" + name,
  });
  const input = mount(mod, path, "/captions");
  const out = "/ccx.srt";
  try { mod.FS.unlink(out); } catch (err) { /* first run */ }
  const code = mod.callMain(["-quiet", "-out=srt", "-o", out, input]);
  let srt = "";
  try { srt = mod.FS.readFile(out, { encoding: "utf8" }); } catch (err) { /* nothing written */ }
  return { srt, cues: parseSrt(srt), exitCode: code };
}

async function teletextOf(tools, path, jobs) {
  if (!tools.telxcc) throw new Error("telxcc.wasm is not built");
  const out = [];
  for (const job of jobs) {
    // A fresh instance per page: telxcc keeps its timestamps in static state,
    // and a second run in the same instance would carry the first page's clock.
    const mod = await tools.telxcc({
      print: () => {},
      printErr: () => {},
      locateFile: (name) => ROOT + "/vendor/telxcc/" + name,
    });
    const input = mount(mod, path, "/teletext");
    const name = "/telx-" + job.pid + "-" + job.page + ".srt";
    try { mod.FS.unlink(name); } catch (err) { /* first run */ }
    const code = mod.callMain(["-i", input, "-o", name, "-n",
      "-t", String(job.pid), "-p", String(job.page)]);
    let srt = "";
    try { srt = mod.FS.readFile(name, { encoding: "utf8" }); } catch (err) { /* nothing written */ }
    out.push({ pid: job.pid, page: job.page, exitCode: code, srt, cues: parseSrt(srt) });
  }
  return out;
}

async function scteOf(tools, events) {
  if (!tools.klscte35) throw new Error("libklscte35.wasm is not built");
  const mod = await tools.klscte35({});
  const rows = [];
  for (const event of events) {
    if (!event.section) continue;
    const bytes = Uint8Array.from(event.section.match(/../g), (h) => parseInt(h, 16));
    const ptr = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, ptr);
    let text = "";
    try {
      text = mod.UTF8ToString(mod._kl_parse(ptr, bytes.length));
    } finally {
      mod._free(ptr);
    }
    let theirs = null;
    try { theirs = JSON.parse(text); } catch (err) { theirs = { ok: false, error: "unreadable JSON" }; }
    rows.push({
      packetIndex: event.packetIndex,
      ok: theirs.ok,
      diff: theirs.ok ? compareScte(event, theirs) : [{ field: "parse", ours: "ok", theirs: theirs.error }],
    });
  }
  return rows;
}

// Teletext subtitle pages come from the PMT descriptor, which the inspector
// already reads; there is no autodetect pass here.
function teletextJobs(report) {
  const jobs = [];
  for (const pmt of (report.psi && report.psi.pmts) || []) {
    for (const stream of pmt.streams || []) {
      if (!stream.teletext || !stream.info) continue;
      for (const item of stream.info) {
        for (const page of item.pages || []) {
          jobs.push({ pid: stream.pid, page: page.page !== undefined ? page.page : page });
        }
      }
    }
  }
  const seen = new Set();
  return jobs.filter((job) => {
    const key = job.pid + ":" + job.page;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function analyse(path) {
  const info = await stat(path);
  const inspector = createInspector({ fileSize: info.size });
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  let got = 0;
  let shown = 0;
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    got += bytes.length;
    inspector.push(bytes);
    if (got - shown >= 8 * 1024 * 1024) {
      shown = got;
      console.error(inspector.packetCount().toLocaleString() + " packets");
    }
  }
  const report = inspector.finish();
  report.fileName = basename(path);
  return { report, bytes: info.size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    help();
    process.exit(args.help ? 0 : 2);
  }
  const { report, bytes } = await analyse(args.input);
  // Native ffmpeg reads the file itself and does its own demuxing, so the
  // size of the capture has never been a limit here.
  if (args.audio) {
    report.audio = [];
    const durationS = (report.summary && report.summary.durationS) || 0;
    for (const row of (report.timeline && report.timeline.audio) || []) {
      const wave = decodeAudio(args.input, row.pid, durationS);
      if (wave && wave.peak.length) report.audio.push(wave);
    }
  }
  if (args.thumbs) {
    report.thumbnails = extractThumbs(args.input, (report.timeline && report.timeline.iFrames) || [], args.thumbs);
  }
  let scteRows = null;
  if (args.captions || args.teletextDir || args.scteCheck || args.failOnDiff) {
    const tools = await openTools();
    if (args.captions) {
      const result = await captionsOf(tools, args.input);
      report.captions = { cues: result.cues, exitCode: result.exitCode, srt: result.srt };
      console.error("captions: " + result.cues.length + " cue" + (result.cues.length === 1 ? "" : "s"));
    }
    if (args.teletextDir) {
      const jobs = teletextJobs(report);
      if (!jobs.length) console.error("teletext: no subtitle page is declared in the PMT");
      const done = await teletextOf(tools, args.input, jobs);
      mkdirSync(args.teletextDir, { recursive: true });
      const base = basename(args.input).replace(/\.[^.]+$/, "");
      const rows = [];
      for (const row of done) {
        const file = args.teletextDir + "/" + base + ".page" + row.page + ".srt";
        // telxcc's times are already relative to its first PTS, which is what
        // the rest of the report counts from too, so the file is written as it
        // comes out of the tool.
        if (row.srt) await writeFile(file, row.srt);
        console.error("teletext page " + row.page + " on PID " + row.pid + ": "
          + row.cues.length + " cue" + (row.cues.length === 1 ? "" : "s") + " -> " + file);
        rows.push({ pid: row.pid, page: row.page, exitCode: row.exitCode, cues: row.cues });
      }
      report.teletextSrt = rows;
    }
    if (args.scteCheck || args.failOnDiff) {
      const events = (report.scte35 || []).filter((event) => event.section);
      scteRows = await scteOf(tools, events);
      report.scteCheck = scteRows;
      const differ = scteRows.filter((row) => row.diff.length);
      console.error("scte-35: " + events.length + " section" + (events.length === 1 ? "" : "s")
        + ", " + differ.length + " differ from libklscte35");
      for (const row of differ) {
        for (const d of row.diff) console.error("  packet " + row.packetIndex + " " + d.field + ": "
          + d.ours + " here, " + d.theirs + " in libklscte35");
      }
    }
  }
  const envelope = wrapReport(report, { name: basename(args.input), bytes });
  const json = JSON.stringify(envelope);
  if (args.output) await writeFile(args.output, json);
  else process.stdout.write(json + "\n");
  const compliance = report.compliance || { pass: 0, fail: 0, na: 0, rows: [] };
  if (args.summary) {
    console.error(compliance.pass + " pass, " + compliance.fail + " fail, " + compliance.na + " not measured");
    for (const row of compliance.rows || []) {
      if (row.state === "fail") console.error("fail " + row.name + " " + row.count);
    }
  }
  if (args.failOn === "fail" && compliance.fail > 0) process.exit(1);
  if (args.failOnDiff && scteRows && scteRows.some((row) => row.diff.length)) process.exit(1);
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : JSON.stringify(err)));
  process.exit(2);
});
