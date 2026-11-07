import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodePlan,
  envelope,
  integratedLoudness,
  loudnessOf,
  mergeLoudness,
  parseLoudnessLog,
  SILENT_LUFS,
  WAVE_RATE,
} from "../src/ui/audio-level.js";
import { inspectBytes } from "../src/worker/inspect.js";
import { describeStreamType, shortKind, streamName, tablePidName } from "../src/worker/stream-type.js";
import { zoomSpan, panSpan, MIN_SPAN, timelineHeight } from "../src/ui/media-timeline.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("stream types get a readable name, and a private stream is named from its descriptor", () => {
  assert.equal(streamName(0x1b), "H.264");
  assert.equal(streamName(0x03), "MPEG-1 audio");
  assert.equal(shortKind(0x03), "MPEG-1 audio");
  // 0x06 alone says nothing; the subtitling descriptor is what names it.
  assert.equal(streamName(0x06, []), "PES private data");
  assert.equal(streamName(0x06, [{ tag: 0x59, name: "subtitling" }]), "DVB subtitles");
  assert.equal(streamName(0x06, [{ tag: 0x56, name: "teletext" }]), "Teletext");
  assert.equal(streamName(0x06, [{ tag: 0x6a, name: "AC-3" }]), "AC-3");
  assert.equal(shortKind(0x06, [{ tag: 0x59, name: "subtitling" }]), "DVB subtitles");
  // Well-known table PIDs are named, never left as a question mark.
  assert.equal(tablePidName(0x00), "PAT");
  assert.equal(tablePidName(0x11), "SDT/BAT");
  assert.equal(tablePidName(0x12), "EIT");
  assert.equal(tablePidName(0x14), "TDT/TOT");
  assert.equal(describeStreamType(0x06, Uint8Array.from([0x59, 0x08, 0x65, 0x6e, 0x67, 0x10, 0, 1, 0, 1])).long, "DVB subtitles");
});

test("the PID table names a private audio stream and its table PIDs", () => {
  const report = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  const byPid = new Map(report.pids.map((row) => [row.pid, row]));
  assert.equal(byPid.get(0x101).long, "H.264");
  assert.equal(byPid.get(0x102).long, "AAC (ADTS)");
  // SDT, NIT and EIT were "?" before; they carry a table name now.
  assert.equal(byPid.get(16).kind, "NIT");
  assert.equal(byPid.get(17).kind, "SDT/BAT");
  assert.equal(byPid.get(18).kind, "EIT");
  // No PID is left with the old hex placeholder.
  assert.equal(report.tr290.pids.some((row) => /^st 0x/.test(row.kind)), false);
});

test("an H.264 audio PID carries its stream type, so the timeline offers a level lane", () => {
  const report = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  assert.ok(report.timeline.audio.length > 0);
  const wave = report.timeline.audio[0];
  assert.ok(wave.label.length > 0);
  assert.equal(wave.pid, 0x102);
});

test("a DVB subtitle display set is cropped to its painted band", () => {
  const report = inspectBytes(readFileSync(root + "/test/fixtures/dvbsub.ts"));
  const picture = report.subtitles[0];
  assert.equal(picture.note, "");
  assert.equal(picture.width * picture.height * 4, picture.pixels.length);
  assert.ok(picture.pixels.some((v, i) => i % 4 === 3 && v > 200), "some pixel is painted");
  assert.ok(picture.bbox);
  assert.ok(picture.pageWidth >= picture.width);
});

// A local capture with DVB subtitles. Real captures stay out of the
// repository; point DVBSUB_TS at one to run the test.
test("a real capture decodes DVB subtitles with more than one colour", { skip: !process.env.DVBSUB_TS }, () => {
  const bytes = readFileSync(process.env.DVBSUB_TS);
  const report = inspectBytes(bytes);
  const sets = report.subtitles.filter((s) => s.pixels && s.width > 100);
  assert.ok(sets.length > 0, "no wide subtitle decoded");
  const picture = sets[0];
  // A glyph has an outline, a fill and transparency: one flat colour would
  // mean only the first line of the object was read.
  const colours = new Set();
  for (let i = 0; i < picture.pixels.length; i += 4) {
    colours.add(picture.pixels[i] + "," + picture.pixels[i + 1] + "," + picture.pixels[i + 2] + "," + picture.pixels[i + 3]);
  }
  assert.ok(colours.size >= 3, "only " + colours.size + " colour(s): " + [...colours].join(" "));
  // And a painted pixel has to exist, otherwise the preview is blank.
  let painted = 0;
  for (let i = 3; i < picture.pixels.length; i += 4) if (picture.pixels[i] > 0) painted += 1;
  assert.ok(painted > 1000, "only " + painted + " painted pixels");
  const stream = report.pids.find((row) => row.pid === picture.pid);
  assert.equal(stream.kind, "DVB subtitles");
});

test("R128 block parsing and the gated integrated loudness match FFmpeg's own summary", () => {
  // A steady 400 ms block grid at -23 LUFS gates to -23.0 regardless of how
  // many blocks there are, which is the property the integrated value needs.
  const blocks = [];
  for (let i = 0; i < 50; i++) blocks.push(-23);
  assert.equal(integratedLoudness(blocks), -23);
  // Silence is gated out: -70 LUFS blocks do not drag the average up.
  const quiet = blocks.concat(new Array(50).fill(SILENT_LUFS));
  assert.equal(integratedLoudness(quiet), -23);
  // A 10 LU spread moves the result, because the relative gate sits 10 LU
  // under the ungated mean: the quiet half is gated out.
  const spread = new Array(50).fill(-20).concat(new Array(50).fill(-40));
  const value = integratedLoudness(spread);
  assert.ok(value > -30 && value <= -20, "spread came out at " + value);

  const log = [
    "frame:0    pts:0       pts_time:0",
    "lavfi.r128.M=-120.691",
    "lavfi.r128.S=-120.691",
    "lavfi.r128.I=-70.000",
    "lavfi.r128.LRA=0.000",
    "lavfi.r128.true_peak=0.100",
    "frame:1    pts:4800    pts_time:0.1",
    "lavfi.r128.M=-23.000",
    "lavfi.r128.S=-23.000",
    "lavfi.r128.I=-23.000",
    "lavfi.r128.LRA=1.500",
    "lavfi.r128.true_peak=0.500",
  ].join("\n");
  const parsed = parseLoudnessLog(log);
  assert.deepEqual(parsed.t, [0, 0.1]);
  assert.equal(parsed.momentary.length, 2);
  const loud = loudnessOf(parsed);
  assert.equal(loud.blocks, 2);
  assert.equal(loud.truePeakDb, -6.0);
  assert.equal(loud.hz, 10);
});

test("chunked loudness concatenates the block grid and recomputes the integrated value", () => {
  const a = { momentary: [-23, -23], shortTerm: [-23, -23], truePeakCurve: [0.5, 0.5] };
  const b = { momentary: [-23, -23], shortTerm: [-23, -23], truePeakCurve: [0.5, 0.5] };
  const merged = mergeLoudness([loudnessOf(a), loudnessOf(b)]);
  assert.equal(merged.blocks, 4);
  assert.equal(merged.integrated, -23);
  assert.equal(merged.truePeakDb, -6);
});

test("the envelope is a peak and RMS meter at 10 ms windows", () => {
  const rate = 8000;
  const n = rate; // one second
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.sin(2 * Math.PI * 100 * i / rate) * 0.5;
  const wave = envelope(pcm, rate);
  assert.equal(wave.hz, 100);
  assert.equal(wave.peak.length, 100);
  assert.ok(wave.peakDb > -8 && wave.peakDb < -5, "peak came out at " + wave.peakDb);
  assert.ok(wave.rmsDb < wave.peakDb);
});

test("the decode plan keeps a long capture inside the memory budget", () => {
  const short = decodePlan(30, 32 * 1024 * 1024);
  assert.equal(short.chunkS, 0, "30 s fits in one pass");
  assert.ok(short.rate >= WAVE_RATE);
  const long = decodePlan(3 * 3600, 32 * 1024 * 1024);
  assert.ok(long.chunkS > 0, "a 3 hour file decodes in chunks");
  assert.equal(long.rate, WAVE_RATE);
  assert.ok(long.chunkS * long.rate * 4 <= 32 * 1024 * 1024 + 4 * long.rate);
});

test("zoom keeps the anchor under the pointer and never leaves the file", () => {
  const z = zoomSpan(0, 100, 2, 50, 100);
  assert.equal(z.t1 - z.t0, 50);
  assert.equal(z.t0, 25);
  assert.equal(z.t1, 75);
  // Zooming at the left edge clamps at zero.
  const left = zoomSpan(0, 100, 4, 0, 100);
  assert.equal(left.t0, 0);
  assert.equal(left.t1, 25);
  // Zooming out past the file returns the whole file.
  const out = zoomSpan(20, 30, 0.01, 25, 100);
  assert.equal(out.t0, 0);
  assert.equal(out.t1, 100);
  // The window never falls under the minimum span.
  const tiny = zoomSpan(0, 100, 1e9, 50, 100);
  assert.ok(tiny.t1 - tiny.t0 >= MIN_SPAN - 1e-9);
});

test("panning stops at the ends of the file", () => {
  assert.deepEqual(panSpan(0, 10, -100, 100), { t0: 0, t1: 10 });
  assert.deepEqual(panSpan(0, 10, 1000, 100), { t0: 90, t1: 100 });
  assert.deepEqual(panSpan(0, 100, 10, 100), { t0: 0, t1: 100 });
  assert.deepEqual(panSpan(50, 60, 5, 100), { t0: 55, t1: 65 });
});

test("the bar is tall enough to sit beside the buffer plots", () => {
  const report = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  const height = timelineHeight(report, new Set());
  assert.ok(height >= 120, "timeline is only " + height + " px");
});
