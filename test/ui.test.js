import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { bitrateCsv, reportHtml } from "../src/ui/export.js";
import { decodePacket, packetSummary } from "../src/ui/hex.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("hex view reads PCR and PTS from a built packet", () => {
  const run = spawnSync("python3", ["-c", [
    "import sys",
    "sys.path.insert(0, 'scripts')",
    "from make_fixtures import pes, ts_packet",
    "pkt = ts_packet(0x101, 3, pusi=True, pcr=27000000, payload=pes(0xE0, 90000))",
    "sys.stdout.buffer.write(pkt)",
  ].join("\n")], { cwd: root });
  assert.equal(run.status, 0, run.stderr && run.stderr.toString());
  const info = decodePacket(new Uint8Array(run.stdout));
  assert.equal(info.pid, 0x101);
  assert.equal(info.cc, 3);
  assert.equal(info.pusi, true);
  assert.equal(info.adaptation.pcr, 27000000);
  assert.equal(info.pes.pts, 90000);
  assert.match(packetSummary(info), /PTS 90000/);
});

test("CSV covers the visible bitrate window", () => {
  const bitrate = {
    steps: 4,
    dur: 4,
    series: [
      { label: "257", v: [1, 2, 3, 4] },
      { label: "258", v: [0.5, 0.5, 0.5, 0.5] },
    ],
  };
  const csv = bitrateCsv(bitrate, 1, 3);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("bin,t_s,257,258"));
  assert.ok(lines[1].startsWith("1,"));
});

test("the HTML report carries the loudness table when a measurement is present", () => {
  const report = {
    compliance: { rows: [], pass: 1, fail: 0, na: 0 },
    hrd: { modelled: false },
    audio: [{
      pid: 257,
      loudness: { measured: true, integrated: -23.1, lra: 2.2, truePeakDb: -7.6, blocks: 1798 },
    }],
  };
  const html = reportHtml(report);
  assert.ok(html.includes("EBU R 128"));
  assert.ok(html.includes("-23.1 LUFS"));
  assert.ok(html.includes("2.2 LU"));
  assert.ok(html.includes("-7.6 dBFS"));
  assert.equal(html.includes("<script"), false);
});

test("the built HTML file does not call the network", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-inspector-ui-"));
  const out = join(dir, "page.html");
  const built = spawnSync("python3", ["build.py", "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const html = readFileSync(out, "utf8");
  // Base64 payloads (the media core and the sample stream) are not authored
  // text; the checks below stop where the first one starts.
  const marks = [html.indexOf("wasmB64: \""), html.indexOf("sample: { name:")].filter((i) => i !== -1);
  const payload = marks.length ? Math.min(...marks) : -1;
  const authored = payload === -1 ? html : html.slice(0, payload);
  assert.equal(authored.includes("fonts.googleapis"), false);
  assert.equal(authored.includes("http://"), false);
  assert.equal(authored.includes("https://"), false);
  // Names that must never ship are kept out of the repository. Pass them as
  // TS_INSPECTOR_DENYLIST="name1,name2" when you run the tests.
  const denied = (process.env.TS_INSPECTOR_DENYLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of denied) {
    assert.equal(authored.toLowerCase().includes(name.toLowerCase()), false, "denylisted name in the page");
  }
  if (html.includes("wasmB64: \"")) assert.ok(html.length > 5_000_000);
  assert.ok(html.includes("TS Inspector"));
  assert.ok(html.includes("WORKER_SRC"));
  assert.equal(html.includes("type=\"module\""), false);
  rmSync(dir, { recursive: true, force: true });
});
