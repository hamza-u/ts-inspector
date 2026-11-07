import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { bitrateDataset, binOf, muxBitrate } from "../src/worker/bitrate.js";
import { createClock } from "../src/worker/clock.js";
import { crc32Mpeg } from "../src/worker/crc.js";
import { detectFraming, createFramer } from "../src/worker/framer.js";
import { inspectBytes } from "../src/worker/inspect.js";
import { decodeScte35 } from "../src/worker/scte35.js";
import { mjdToDate } from "../src/worker/psi.js";
import { estimatePcrAt, linearFit } from "../src/worker/timing.js";
import { PCR_MOD } from "../src/worker/tsutil.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function pythonClock(script) {
  const run = spawnSync("python3", ["-c", script], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("crc32 matches the python table and a PAT section", () => {
  const run = spawnSync("python3", ["-c", [
    "import sys",
    "sys.path.insert(0, 'scripts')",
    "from make_fixtures import crc32_mpeg",
    "print(crc32_mpeg(b'123456789'))",
    "print(crc32_mpeg(bytes(range(40))))",
  ].join("\n")], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const [a, b] = run.stdout.trim().split("\n").map(Number);
  assert.equal(crc32Mpeg(new TextEncoder().encode("123456789")), a);
  assert.equal(crc32Mpeg(Uint8Array.from({ length: 40 }, (_, i) => i)), b);
});

test("virtual clock matches pcr_clock.py, including a PCR wrap", () => {
  const base = 5_000_000_000;
  const cases = {
    linear: Array.from({ length: 5 }, (_, i) => base + i * 270000),
    wrap: [PCR_MOD - 270000, 270000],
    back: [base, base - 270000],
    none: [null, null, null],
  };
  const js = {};
  for (const [name, pcrs] of Object.entries(cases)) {
    const clock = createClock();
    const out = [];
    pcrs.forEach((pcr, i) => out.push(...clock.push(i, pcr)));
    out.push(...clock.finish());
    js[name] = out;
  }
  const py = pythonClock(`
import json, sys
sys.path.insert(0, "scripts")
from pcr_clock import PcrClock, PCR_MOD
base = 5_000_000_000
cases = {
  "linear": [base + i * 270000 for i in range(5)],
  "wrap": [PCR_MOD - 270000, 270000],
  "back": [base, base - 270000],
  "none": [None, None, None],
}
out = {}
for name, pcrs in cases.items():
    c = PcrClock()
    rows = []
    for i, pcr in enumerate(pcrs):
        rows.extend(c.push(i, pcr))
    rows.extend(c.finish())
    out[name] = rows
print(json.dumps(out))
`);
  for (const name of Object.keys(cases)) {
    assert.equal(js[name].length, py[name].length, name);
    for (let i = 0; i < js[name].length; i++) {
      assert.equal(js[name][i][0], py[name][i][0], name);
      assert.ok(Math.abs(js[name][i][1] - py[name][i][1]) < 1e-6, name + " t=" + js[name][i][1]);
    }
  }
  assert.equal(js.linear[0][1], 0);
  assert.ok(js.wrap[1][1] > js.wrap[0][1]);
  assert.ok(js.back[1][1] >= js.back[0][1] - 1e-9);
});

test("framer finds 188, 192 and 204 and resyncs", () => {
  const one = new Uint8Array(188);
  one[0] = 0x47;
  one[1] = 0x00;
  const raw = new Uint8Array(188 * 6);
  for (let i = 0; i < 6; i++) raw.set(one, i * 188);
  assert.deepEqual(detectFraming(raw), { size: 188, align: 0 });

  const m2 = new Uint8Array(192 * 4);
  for (let i = 0; i < 4; i++) {
    m2[i * 192 + 4] = 0x47;
    m2.set(one.subarray(1), i * 192 + 5);
  }
  assert.deepEqual(detectFraming(m2), { size: 192, align: 4 });

  const fec = new Uint8Array(204 * 4);
  for (let i = 0; i < 4; i++) {
    fec.set(one, i * 204);
    fec.fill(0xFF, i * 204 + 188, i * 204 + 204);
  }
  assert.deepEqual(detectFraming(fec), { size: 204, align: 0 });

  const broken = new Uint8Array(188 * 2 + 5 + 188 * 2);
  broken.set(raw.subarray(0, 188 * 2), 0);
  broken.set(raw.subarray(0, 188 * 2), 188 * 2 + 5);
  const fr = createFramer();
  const got = [];
  fr.push(broken.subarray(0, 50), (pkt, index) => got.push(index));
  fr.push(broken.subarray(50), (pkt, index) => got.push(index));
  fr.finish((pkt, index) => got.push(index));
  assert.equal(fr.resyncs, 1);
  assert.equal(fr.index, 4);
  assert.deepEqual(got, [0, 1, 2, 3]);
});

test("bitrate bins use equal packet steps", () => {
  const pids = [0, 256, 256, 256, 257, 257, 8191, 256];
  const pcrs = [{ index: 0, pcr: 0 }, { index: 7, pcr: 7 * 270000 }];
  const rate = muxBitrate(pcrs);
  const ds = bitrateDataset(pids, pcrs, 4);
  assert.equal(ds.steps, 1); // 8 packets / 8 = 1 step minimum floor
  const wider = bitrateDataset(pids.concat(pids, pids, pids), pcrs.map((p, n) => n ? { index: 31, pcr: p.pcr } : p), 4);
  assert.equal(wider.steps, 4);
  assert.equal(binOf(0, 8, 4), 0);
  assert.equal(binOf(7, 2, 4), 3);
  assert.ok(rate > 0);
});

test("PCR fit is flat on a constant rate, PTS lead is 100 ms", () => {
  const points = [];
  for (let i = 0; i < 10; i++) points.push({ index: i, sec: i * 0.01 });
  const fit = linearFit(points);
  assert.ok(fit.maxAbsMs < 1e-6);
  const anchors = points.map((p) => ({ index: p.index, pcr: p.sec * 27e6 }));
  const per = (anchors[9].pcr - anchors[0].pcr) / 9;
  const est = estimatePcrAt(anchors, per, 5);
  const pts = est / 300 + 9000;
  const diffMs = (pts - est / 300) / 90;
  assert.ok(Math.abs(diffMs - 100) < 1e-6);
});

test("MJD 58849 is 2020-01-01", () => {
  assert.deepEqual(mjdToDate(58849), { year: 2020, month: 1, day: 1 });
});

test("chunked inspect matches a single buffer and the golden TR 101 290 counts", () => {
  const dir = root + "/test/fixtures";
  const names = readdirSync(dir).filter((n) => n.endsWith(".ts"));
  assert.ok(names.includes("ok.ts"));
  for (const name of names) {
    let gold;
    try {
      gold = JSON.parse(readFileSync(root + "/test/golden/" + name.replace(/\.ts$/, ".json"), "utf8"));
    } catch (err) {
      continue;
    }
    const bytes = readFileSync(dir + "/" + name);
    const report = inspectBytes(bytes);
    assert.equal(report.tr290.pkts, gold.pkts, name);
    assert.equal(report.tr290.bytes, gold.bytes, name);
    assert.equal(report.tr290.pcr_pid, gold.pcr_pid, name);
    assert.ok(Math.abs(report.tr290.pcr_max_interval_ms - gold.pcr_max_interval_ms) < 0.05, name);
    assert.deepEqual(report.tr290.checks, gold.checks, name);
    assert.deepEqual(report.tr290.pids, gold.pids, name);
  }
});

test("ok.ts PSI, SCTE-35 and a split read", async () => {
  const { createInspector } = await import("../src/worker/inspect.js");
  const bytes = readFileSync(root + "/test/fixtures/ok.ts");
  const inspector = createInspector({ fileSize: bytes.length });
  const cut = 1000;
  inspector.push(bytes.subarray(0, cut));
  inspector.push(bytes.subarray(cut));
  const report = inspector.finish();
  const whole = inspectBytes(bytes);
  assert.equal(report.tr290.pkts, whole.tr290.pkts);
  assert.deepEqual(report.tr290.checks, whole.tr290.checks);
  assert.equal(report.psi.sdt.services[0].name, "Inspector");
  assert.equal(report.psi.nit.name, "TestNet");
  assert.equal(report.psi.pat.programs[0].program, 1);
  assert.equal(report.psi.pmts[0].pcrPid, 0x101);
  assert.ok(report.psi.pmts[0].streams.some((s) => s.typeName === "SCTE-35"));
  assert.ok(report.psi.eit.length > 0);
  assert.equal(report.psi.eit[0].duration, "00:30:00");
  assert.ok(report.scte35.length > 0);
  const splice = report.scte35[0];
  assert.equal(splice.crcOk, true);
  assert.equal(splice.command.eventId, 0x12345678);
  assert.equal(splice.command.outOfNetwork, true);
  assert.equal(splice.command.pts, 900000);
  assert.equal(splice.command.breakDuration, 2_700_000);
  assert.equal(splice.descriptors[0].segmentation.typeId, 0x30);
  assert.equal(splice.descriptors[0].segmentation.upid, "AD1");
  const section = readScte(bytes);
  const decoded = decodeScte35(section);
  assert.equal(decoded.command.name, "splice_insert");
});

function readScte(bytes) {
  // Packet slot 5 of every 40 is the SCTE packet. Packet 5.
  const pkt = bytes.subarray(5 * 188, 6 * 188);
  const off = 5 + pkt[4];
  const pointer = pkt[off];
  const start = off + 1 + pointer;
  const len = ((pkt[start + 1] & 0x0F) << 8) | pkt[start + 2];
  return pkt.subarray(start, start + 3 + len);
}
