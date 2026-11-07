import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectPid, findPsi, framingOf, miniTs } from "../src/ui/extract.js";
import { inspectBytes } from "../src/worker/inspect.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// A File-shaped object: .size, .name, and .slice(a, b).arrayBuffer().
function fileOf(bytes) {
  return {
    name: "fixture.ts",
    size: bytes.length,
    slice(a, b) {
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset + a, bytes.byteOffset + b) };
    },
  };
}

test("a mini stream carries only the PID asked for, plus the PAT and PMT", () => {
  const bytes = readFileSync(root + "/test/fixtures/ok.ts");
  const report = inspectBytes(bytes);
  const framing = framingOf(report);
  return (async () => {
    const psi = await findPsi(fileOf(bytes), framing, 20000);
    assert.ok(psi.patPkt, "PAT found");
    assert.ok(psi.pmtPkt, "PMT found");
    const total = Math.floor(bytes.length / framing.size);
    const audio = await collectPid(fileOf(bytes), framing, 0x102, 0, total);
    assert.ok(audio.length > 0);
    assert.ok(audio.every((p) => (((p[1] & 0x1F) << 8) | p[2]) === 0x102));
    const mini = await miniTs(fileOf(bytes), framing, psi, [audio]);
    const share = mini.length / bytes.length;
    assert.ok(share < 0.5, "mini is " + (share * 100).toFixed(0) + "% of the file");
    const again = inspectBytes(mini);
    assert.ok(again.pids.some((row) => row.pid === 0x102));
    assert.equal(again.pids.some((row) => row.pid === 0x101), false);
  })();
});

test("framing from a report keeps the packet step", () => {
  const framing = framingOf({ framing: { size: 192, align: 4 } });
  assert.deepEqual(framing, { size: 192, align: 4 });
  assert.deepEqual(framingOf(null), { size: 188, align: 0 });
});
