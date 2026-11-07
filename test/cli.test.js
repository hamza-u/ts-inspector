import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { inspectBytes } from "../src/worker/inspect.js";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, ["bin/ts-inspector.js", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

test("the command writes the same HRD and compliance result as the page", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-inspector-"));
  const out = join(dir, "hrd.json");
  const cli = run(["test/fixtures/hrd_ok.ts", "-o", out, "--summary"]);
  assert.equal(cli.status, 0, cli.stderr);
  const envelope = JSON.parse(readFileSync(out, "utf8"));
  const direct = inspectBytes(readFileSync(root + "/test/fixtures/hrd_ok.ts"));
  assert.equal(envelope.schema, "ts-inspector-report");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.file.name, "hrd_ok.ts");
  assert.deepEqual(envelope.report.hrd.counts, direct.hrd.counts);
  assert.deepEqual(envelope.report.compliance, direct.compliance);
  assert.deepEqual(envelope.report.timeline.frames.map((row) => row.frame), direct.timeline.frames.map((row) => row.frame));
  assert.match(cli.stderr, /pass/);
});

test("thumbs writes JPEG stills at the I-frame times", { timeout: 60000 }, () => {
  const ff = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  if (ff.error || ff.status !== 0) return;
  const dir = mkdtempSync(join(tmpdir(), "ts-inspector-thumbs-"));
  const src = join(dir, "src.ts");
  const enc = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25", "-t", "3",
    "-c:v", "libx264", "-g", "25", "-b:v", "400k", "-f", "mpegts", src,
  ], { encoding: "utf8" });
  if (enc.status !== 0) return;
  const out = join(dir, "thumbs.json");
  const cli = run([src, "--thumbs", "3", "-o", out]);
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(readFileSync(out, "utf8")).report;
  assert.equal(report.thumbnails.length, 3);
  for (const thumb of report.thumbnails) {
    const jpeg = Buffer.from(thumb.jpeg, "base64");
    assert.equal(jpeg[0], 0xFF);
    assert.equal(jpeg[1], 0xD8);
    assert.equal(jpeg[jpeg.length - 2], 0xFF);
    assert.equal(jpeg[jpeg.length - 1], 0xD9);
    assert.ok(thumb.t >= 0);
    assert.ok(thumb.packetIndex >= 0);
  }
});

test("audio writes R128 loudness, loudness range and true peak for an audio PID", { timeout: 60000 }, () => {
  const ff = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  if (ff.error || ff.status !== 0) return;
  const dir = mkdtempSync(join(tmpdir(), "ts-inspector-audio-"));
  const src = join(dir, "src.ts");
  // A steady 1 kHz tone at a known level, so the loudness number is checkable.
  const enc = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=4",
    "-af", "volume=-6dB",
    "-c:a", "mp2", "-b:a", "192k", "-f", "mpegts", src,
  ], { encoding: "utf8" });
  if (enc.status !== 0) return;
  const out = join(dir, "audio.json");
  const cli = run([src, "--audio", "-o", out]);
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(readFileSync(out, "utf8")).report;
  assert.ok(report.audio.length > 0, "no audio entry");
  const wave = report.audio[0];
  assert.ok(wave.peak.length > 0, "no waveform points");
  assert.ok(Number.isFinite(wave.peakDb));
  const loud = wave.loudness;
  assert.ok(loud, "no loudness measurement");
  assert.ok(Number.isFinite(loud.integrated), "integrated loudness is not a number");
  // ffmpeg's sine source has an amplitude of 1/8, so a -6 dB trim lands near
  // -24 dBFS. The assertion is about a real level, not about the exact trim.
  assert.ok(loud.truePeakDb > -26 && loud.truePeakDb < -22, "true peak " + loud.truePeakDb);
  // A steady tone is a narrow loudness range.
  assert.ok(loud.lra >= 0 && loud.lra < 3, "LRA " + loud.lra);
  assert.ok(loud.momentary.length > 0);
  assert.ok(loud.shortTerm.length > 0);
  // The measurement has to agree with FFmpeg's own summary, which is the
  // whole point of using the ebur128 filter rather than a peak count.
  const native = spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", src, "-map", "0:a:0",
    "-af", "ebur128=peak=true", "-f", "null", "-",
  ], { encoding: "utf8" });
  const summary = /Integrated loudness:[\s\S]*?I:\s+(-?\d+\.\d) LUFS/.exec(native.stderr || "");
  if (summary) {
    assert.ok(Math.abs(loud.integrated - Number(summary[1])) <= 0.3,
      "integrated " + loud.integrated + " vs ffmpeg " + summary[1]);
  }
});

test("fail-on exits 1 when a buffer check failed and 0 when the file is clean", () => {
  const bad = run(["test/fixtures/tstd_eb_underflow.ts", "--fail-on", "fail"]);
  assert.equal(bad.status, 1, bad.stderr);
  const good = run(["test/fixtures/ok.ts", "--fail-on", "fail"]);
  assert.equal(good.status, 0, good.stderr);
});
