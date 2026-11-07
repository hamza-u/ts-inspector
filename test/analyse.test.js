import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createBits, stripEpb } from "../src/worker/bits.js";
import { parseSei, parseSps, splitAnnexB } from "../src/worker/h264.js";
import { scheduleAus } from "../src/worker/hrd.js";
import { inspectBytes } from "../src/worker/inspect.js";
import { hamming84, oddParityChar } from "../src/worker/teletext.js";
import { simulateTstd, tstdLimits } from "../src/worker/tstd.js";
import { decodeDvbText } from "../src/worker/dvbtext.js";
import { pcrAccuracy } from "../src/worker/pcrac.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("bit reader ue, se and rbsp trailing", () => {
  const br = createBits(Uint8Array.from([0b10000000]));
  assert.equal(br.ue(), 0);
  assert.equal(br.moreRbspData(), false);
  const se = createBits(Uint8Array.from([0b01000000]));
  assert.equal(se.ue(), 1);
  const neg = createBits(Uint8Array.from([0b01100000]));
  assert.equal(neg.se(), -1);
  assert.deepEqual(Array.from(stripEpb(Uint8Array.from([0, 0, 3, 1, 2]))), [0, 0, 1, 2]);
});

test("SPS keeps the HRD after a scaling list", () => {
  const run = spawnSync("python3", ["-c", [
    "import sys",
    "sys.path.insert(0, 'scripts')",
    "from make_fixtures import sps_rbsp",
    "sys.stdout.buffer.write(sps_rbsp(profile=100, level=40, bitrate=400000, cpb=200000))",
  ].join("\n")], { cwd: root });
  assert.equal(run.status, 0, run.stderr && run.stderr.toString());
  const sps = parseSps(new Uint8Array(run.stdout));
  assert.ok(sps);
  assert.equal(sps.profile, 100);
  assert.equal(sps.level, 40);
  assert.equal(sps.bitRate, 400000);
  assert.equal(sps.cpbSize, 200000);
  assert.equal(sps.whichHrd, "nal");
  assert.equal(sps.cbrFlag, 1);
  assert.equal(sps.timing.tc, 0.04);
});

test("buffering period uses the SPS field length", () => {
  const run = spawnSync("python3", ["-c", [
    "import sys",
    "sys.path.insert(0, 'scripts')",
    "from make_fixtures import access_unit",
    "sys.stdout.buffer.write(access_unit(36000, 0, idr=True, filler=8))",
  ].join("\n")], { cwd: root });
  assert.equal(run.status, 0, run.stderr && run.stderr.toString());
  const es = new Uint8Array(run.stdout);
  const types = splitAnnexB(es).map((n) => n.type);
  assert.ok(types.includes(7));
  assert.ok(types.includes(6));
  assert.ok(types.includes(5));
  const sps = parseSps(splitAnnexB(es).find((n) => n.type === 7).rbsp);
  const sei = parseSei(splitAnnexB(es).find((n) => n.type === 6).rbsp, new Map([[0, sps]]), sps);
  assert.equal(sei.bp.delay, 36000);
  assert.equal(sei.pt.cpbRemovalDelay, 0);
});

test("Annex C CBR chain matches a declared second buffering period", () => {
  const rate = 400000;
  const cpb = 200000;
  const tc = 0.04;
  const sps = {
    hrd: { scheds: [{ bitRate: rate, cpbSize: cpb, cbrFlag: 1 }] },
    timing: { tc },
    lowDelayHrdFlag: 0,
    whichHrd: "nal",
    bitRate: rate,
    cpbSize: cpb,
    cbrFlag: 1,
  };
  const sizes = [1000, 1000, 1000];
  let tr = 1;
  let tai = tr - 36000 / 90000;
  let taf = tai + sizes[0] * 8 / rate;
  for (let i = 1; i < sizes.length - 1; i++) {
    tr = 1 + i * tc;
    tai = taf;
    taf = tai + sizes[i] * 8 / rate;
  }
  const declared = Math.round(90000 * ((1 + 2 * tc) - taf));
  const aus = sizes.map((sizeB, i) => ({
    idx: i,
    sizeB,
    dts: 1 + i * tc,
    bp: i === 0 || i === 2 ? { delay: i === 0 ? 36000 : declared, offset: 0 } : null,
    cpbRemovalDelay: i,
    sps,
    discont: 0,
    newSps: 0,
    firstPacket: i,
    idr: i === 0 ? 1 : 0,
    frame: i === 0 ? "I" : "P",
    wireFirstS: null,
  }));
  const { bps } = scheduleAus(aus);
  assert.equal(bps[0].class, "anchor");
  assert.equal(bps[1].class, "agree");
  assert.equal(aus[1].underflowPlan, 0);
  assert.equal(aus[0].overflowPlan, 0);
  assert.ok(Math.abs(aus[0].planFirstLeadMs - 400) < 0.01);
});

test("T-STD limits use the H.222.0 1200 factor and a 512-byte TB", () => {
  const lim = tstdLimits(77, 10, 200000, 400000);
  assert.equal(lim.tbBytes, 512);
  assert.equal(lim.ebBytes, 25000);
  assert.equal(lim.rbxBps, 1200 * 64 / 8);
  assert.equal(lim.rxBps, 1.2 * 400000 / 8);
  const high = tstdLimits(100, 41, 0, 0);
  assert.equal(high.annexABitRate, 1500 * 50000);
  assert.equal(high.rbxBps, 1200 * 50000 / 8);
});

test("leak method underflows when the AU is not in EB at DTS", () => {
  const limits = tstdLimits(77, 10, 200000, 400000);
  const sim = simulateTstd({
    limits,
    method: "leak",
    muxBps: 10_000_000,
    packets: [
      { t: 10, drop: 12, hdr: 19, es: 157, packetIndex: 3 },
      { t: 10.01, drop: 12, hdr: 0, es: 176, packetIndex: 4 },
    ],
    aus: [{ dts: 10, sizeB: 333, tAi: null, tAf: null, bitRate: 400000, wireFirstS: 10, firstPacket: 3 }],
  });
  assert.ok(sim.counts.eb_underflow >= 1);
  assert.equal(sim.counts.eb_overflow, 0);
});

test("PCR_AC flags a one-microsecond spike and ignores a discontinuity", () => {
  const samples = [];
  for (let i = 0; i < 10; i++) samples.push({ index: i, pcr: i * 270000, t: i * 0.01, packetIndex: i });
  samples[5].pcr += 40;
  const clean = pcrAccuracy(samples);
  assert.equal(clean.overLimit, 1);
  const jump = [];
  for (let i = 0; i < 6; i++) jump.push({ index: i, pcr: i * 270000, t: i * 0.01, packetIndex: i });
  for (let i = 6; i < 10; i++) jump.push({ index: i, pcr: i * 270000 + 27000 * 200, t: i * 0.01, packetIndex: i });
  assert.equal(pcrAccuracy(jump).overLimit, 0);
});

test("teletext hamming and DVB text", () => {
  assert.equal(hamming84(0x15), 0);
  assert.equal(hamming84(0x15 ^ 0x01), 0);
  assert.equal(oddParityChar(0xC8), "H");
  assert.equal(decodeDvbText(Uint8Array.from([0x43, 0x61, 0x66, 0xC2, 0x65])), "Café");
});

test("synthetic streams: HRD chain, join debt, T-STD, PCR, P3, SI, subtitles", () => {
  // Regenerate into a temporary folder: other tests read test/fixtures in
  // parallel, and rewriting it under them makes those reads flaky.
  const out = mkdtempSync(tmpdir() + "/ts-inspector-fixtures-");  // `join` is shadowed below
  const made = spawnSync("python3", ["scripts/make_fixtures.py", "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const load = (name) => readFileSync(out + "/" + name);
  // The committed fixtures must match what the generator writes now.
  for (const name of readdirSync(out)) {
    assert.ok(load(name).equals(readFileSync(root + "/test/fixtures/" + name)), name + " is stale: run scripts/make_fixtures.py");
  }

  const ok = inspectBytes(load("hrd_ok.ts"));
  assert.equal(ok.hrd.modelled, true);
  assert.equal(ok.hrd.sps[0].bitRate, 400000);
  assert.equal(ok.hrd.counts.bps.anchor, 1);
  assert.equal(ok.hrd.counts.bps.agree, 1);
  assert.equal(ok.hrd.counts.joins, 0);
  assert.equal(ok.hrd.counts.underflowPlan, 0);
  assert.equal(ok.hrd.counts.overflowPlan, 0);
  assert.equal(ok.tstd.modelled, true);
  assert.equal(ok.tstd.method, "leak");
  assert.ok(ok.video.streams[0].gops.length >= 1);

  const join = inspectBytes(load("hrd_join.ts"));
  assert.equal(join.hrd.counts.joins, 1);
  assert.ok(join.hrd.joins[0].debtMs > 0);
  assert.ok(join.hrd.joins[0].extraBits > 0);
  assert.ok(join.hrd.joins[0].reasons.includes("discont"));

  const under = inspectBytes(load("tstd_eb_underflow.ts"));
  assert.ok(under.tstd.counts.eb_underflow >= 1);
  assert.ok(under.tr290.checks.Empty_buffer_error >= 1);
  assert.equal(under.hrd.counts.underflowPlan, 0);

  const over = inspectBytes(load("tstd_eb_overflow.ts"));
  assert.equal(over.tstd.method, "hrd");
  assert.ok(over.tstd.counts.eb_overflow >= 1);
  assert.ok(over.hrd.counts.overflowPlan >= 1);
  assert.ok(over.tr290.checks.Buffer_error >= 1);

  const ac = inspectBytes(load("pcr_ac.ts"));
  assert.ok(ac.pcrAccuracy.overLimit >= 1);
  assert.ok(ac.tr290.checks.PCR_accuracy_error >= 1);
  assert.equal(ac.tr290.checks.PCR_discontinuity_error, 0);
  assert.equal(ac.pcrAccuracy.oj, null);

  const p3 = inspectBytes(load("p3_gaps.ts"));
  assert.ok(p3.tr290.checks.NIT_error >= 1);
  assert.ok(p3.tr290.checks.SDT_error >= 1);
  assert.ok(p3.tr290.checks.EIT_error >= 1);
  assert.equal(p3.tr290.checks.TDT_error, 0);
  assert.ok(p3.tr290.checks.Unreferenced_PID >= 1);

  const si = inspectBytes(load("si_full.ts"));
  assert.equal(si.psi.tdt.time.startsWith("2024-06-01"), true);
  assert.equal(si.psi.eit[0].name, "Café");
  assert.ok(si.psi.nit.descriptors.some((d) => d.name === "logical_channel" && d.text.includes("1:7")));
  const h264 = si.psi.pmts[0].streams.find((s) => s.type === 0x1B);
  assert.equal(h264.hrdManagementValid, 0);
  assert.ok(h264.info.some((d) => d.name === "AVC_video"));
  assert.equal(si.psi.pmts[0].streams.some((s) => s.teletext), true);
  assert.equal(si.psi.pmts[0].streams.some((s) => s.subtitle), true);

  const tt = inspectBytes(load("teletext.ts"));
  assert.equal(tt.teletext.length, 1);
  assert.equal(tt.teletext[0].number, 100);
  assert.ok(tt.teletext[0].text.includes("HELLO"));

  const sub = inspectBytes(load("dvbsub.ts"));
  assert.equal(sub.subtitles.length, 1);
  assert.equal(sub.subtitles[0].width, 8);
  assert.equal(sub.subtitles[0].height, 8);
  assert.equal(sub.subtitles[0].pixels.length, 8 * 8 * 4);
  assert.ok(sub.subtitles[0].pixels.some((v, i) => i % 4 === 3 && v > 200));
  rmSync(out, { recursive: true, force: true });
});

test("optional ffmpeg nal-hrd cross-check", { timeout: 30000 }, () => {
  const ff = spawnSync("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8" });
  if (ff.error || ff.status !== 0) return;
  const path = join(tmpdir(), "ts-inspector-hrd-cross.ts");
  const enc = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25", "-t", "1",
    "-c:v", "libx264", "-b:v", "400k", "-maxrate", "400k", "-bufsize", "400k",
    "-x264-params", "nal-hrd=cbr:force-cfr=1",
    "-f", "mpegts", path,
  ], { encoding: "utf8" });
  if (enc.status !== 0) return;
  try {
    const report = inspectBytes(readFileSync(path));
    assert.equal(report.hrd.modelled, true);
    assert.equal(report.hrd.sps[0].bitRate, 400000);
    assert.ok(report.hrd.counts.aus >= 20);
    assert.equal(report.hrd.counts.underflowPlan, 0);
    assert.equal(report.hrd.counts.overflowPlan, 0);
    assert.equal(report.hrd.counts.joins, 0);
    assert.equal(report.tstd.counts.eb_underflow, 0);
    assert.equal(report.tstd.counts.eb_overflow, 0);
  } finally {
    try { spawnSync("rm", ["-f", path]); } catch (err) { /* temp file */ }
  }
});
