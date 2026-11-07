import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openReport, wrapReport } from "../src/report.js";
import { inspectBytes } from "../src/worker/inspect.js";
import { cueOf, thinFrames } from "../src/worker/timeline.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("timeline marks SCTE, pictures, and teletext on one clock", () => {
  const ok = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  assert.ok(ok.timeline.scte.length > 0);
  assert.ok(ok.timeline.scte[0].t >= 0);
  assert.ok(/CUE-(OUT|IN)/.test(ok.timeline.scte[0].label));
  assert.equal(ok.timeline.scte[0].packetIndex >= 0, true);

  const hrd = inspectBytes(readFileSync(root + "/test/fixtures/hrd_ok.ts"));
  const kinds = new Set(hrd.timeline.frames.map((row) => row.frame));
  assert.ok(kinds.has("I"));
  assert.ok(kinds.has("P"));
  assert.ok(hrd.timeline.frames.every((row) => row.t >= 0));

  const text = inspectBytes(readFileSync(root + "/test/fixtures/teletext.ts"));
  const page = text.timeline.subs.find((row) => row.kind === "teletext");
  assert.ok(page);
  assert.ok(page.text.includes("HELLO"));
  assert.ok(page.packetIndex >= 0);
});

test("segmentation type ids map to CUE-OUT, CUE-IN, or neither", () => {
  assert.equal(cueOf(0x22), "out");
  assert.equal(cueOf(0x30), "out");
  assert.equal(cueOf(0x34), "out");
  assert.equal(cueOf(0x11), "out");
  assert.equal(cueOf(0x23), "in");
  assert.equal(cueOf(0x31), "in");
  assert.equal(cueOf(0x35), "in");
  assert.equal(cueOf(0x10), "in");
  assert.equal(cueOf(0x20), null);
  assert.equal(cueOf(null), null);
});

test("a cue pair yields one CUE-OUT and one CUE-IN on the bar", () => {
  const pair = inspectBytes(readFileSync(root + "/test/fixtures/cue_pair.ts"));
  const cues = pair.timeline.scte;
  assert.equal(cues.length, 2);
  assert.equal(cues[0].cue, "out");
  assert.equal(cues[1].cue, "in");
  assert.match(cues[0].label, /CUE-OUT/);
  assert.match(cues[1].label, /CUE-IN/);
  assert.ok(cues[1].t > cues[0].t);
  assert.equal(cues[0].breakMs, 30000);
});

test("I-frame list is available for the filmstrip", () => {
  const ok = inspectBytes(readFileSync(root + "/test/fixtures/hrd_ok.ts"));
  assert.ok(ok.timeline.iFrames.length >= 1);
  assert.ok(ok.timeline.iFrames.every((row) => row.frame === "I" || row.idr === 1));
  assert.ok(ok.timeline.iFrames.every((row) => row.packetIndex >= 0));
});

test("picture ticks keep every I frame when the list is capped", () => {
  const rows = [];
  for (let i = 0; i < 60000; i++) {
    rows.push({ t: i, packetIndex: i, frame: i % 25 === 0 ? "I" : "P", idr: i % 25 === 0 ? 1 : 0 });
  }
  const thin = thinFrames(rows);
  assert.ok(thin.length <= 50000);
  assert.equal(thin.filter((row) => row.frame === "I").length, 2400);
});

test("slice data that looks like a splice section is not reported as SCTE-35", () => {
  const r = inspectBytes(readFileSync(root + "/test/fixtures/video_fc_noise.ts"));
  assert.equal(r.scte35.length, 0);
  assert.equal(r.timeline.scte.length, 0);
  assert.equal(r.psi.pmts[0].streams.length, 1);
  assert.equal(r.psi.pmts[0].streams[0].type, 0x1B);
});

test("a real splice section still reaches the SCTE list", () => {
  const ok = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  assert.ok(ok.scte35.length > 0);
  assert.ok(ok.scte35.every((e) => e.crcOk === true));
  assert.ok(ok.timeline.scte.length > 0);
  assert.ok(ok.timeline.scte.every((row) => row.t >= 0));
});

test("report envelope accepts version 1 and rejects anything else", () => {
  const report = { summary: { durationS: 1 }, tr290: { checks: {} } };
  const wrapped = wrapReport(report, { name: "a.ts", bytes: 10 });
  assert.equal(wrapped.schema, "ts-inspector-report");
  assert.equal(wrapped.version, 1);
  assert.equal(openReport(wrapped).report, report);
  assert.equal(openReport(report).report, report);
  assert.throws(() => openReport({ schema: "ts-inspector-report", version: 2, report }), /unsupported/);
  assert.throws(() => openReport({ hello: 1 }), /not a TS Inspector report/);
});
