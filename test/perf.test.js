import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createInspector } from "../src/worker/inspect.js";

const root = fileURLToPath(new URL("..", import.meta.url));

test("a 1 GB null stream stays under 30 s", { timeout: 120000 }, () => {
  const packet = new Uint8Array(188);
  packet[0] = 0x47;
  packet[1] = 0x1F;
  packet[2] = 0xFF;
  packet[3] = 0x10;
  const chunkPackets = 512;
  const chunk = new Uint8Array(188 * chunkPackets);
  for (let i = 0; i < chunkPackets; i++) chunk.set(packet, i * 188);
  const packets = Math.floor(1e9 / 188);
  const chunks = Math.floor(packets / chunkPackets);
  const inspector = createInspector({
    fileSize: packets * 188,
    expectedPackets: packets,
  });
  const started = Date.now();
  for (let i = 0; i < chunks; i++) inspector.push(chunk);
  const report = inspector.finish();
  const elapsed = Date.now() - started;
  assert.ok(report.summary.packets >= packets - chunkPackets, "parsed " + report.summary.packets);
  assert.ok(elapsed < 30000, "took " + elapsed + " ms");
});

test("an H.264 PID of 200k packets stays under 15 s", { timeout: 30000 }, () => {
  const ok = readFileSync(root + "/test/fixtures/ok.ts");
  const video = new Uint8Array(188);
  video[0] = 0x47;
  video[1] = 0x41;
  video[2] = 0x01;
  video[3] = 0x10;
  const chunk = new Uint8Array(188 * 64);
  for (let i = 0; i < 64; i++) {
    video[3] = 0x10 | (i & 0xF);
    chunk.set(video, i * 188);
  }
  const packets = 200000;
  const inspector = createInspector({ fileSize: 188 * (packets + 2), expectedPackets: packets + 2 });
  inspector.push(ok.subarray(0, 188 * 2));
  const started = Date.now();
  for (let i = 0; i < packets / 64; i++) inspector.push(chunk);
  const report = inspector.finish();
  const elapsed = Date.now() - started;
  assert.ok(report.summary.packets >= packets, "parsed " + report.summary.packets);
  assert.equal(report.video.streams.some((s) => s.pid === 0x101), true);
  assert.ok(elapsed < 15000, "took " + elapsed + " ms");
});
