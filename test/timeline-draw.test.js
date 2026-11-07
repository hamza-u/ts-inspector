import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { drawMediaTimeline, timelineHeight, hitTimeline, timelineLanes } from "../src/ui/media-timeline.js";
import { inspectBytes } from "../src/worker/inspect.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// Records every text and fill the renderer emits, so a headless test can
// assert what the bar would show without a real canvas.
function recordingCanvas(width, height) {
  const ops = [];
  const state = { ops, fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "", textAlign: "" };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "createImageData") return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (key in target) return target[key];
      return (...args) => { ops.push({ op: key, args: args.slice(0, 6), fill: target.fillStyle, stroke: target.strokeStyle }); };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    ops,
  };
}

function installDom() {
  global.window = { devicePixelRatio: 2, innerHeight: 900, addEventListener() {} };
  global.document = { documentElement: { setAttribute() {}, getAttribute: () => "light" } };
  global.getComputedStyle = () => ({
    getPropertyValue: (name) => ({
      "--ink2": "#666666",
      "--grid": "#dddddd",
      "--ink": "#111111",
      "--edge": "#cccccc",
      "--panel": "#ffffff",
    }[name] || "#000000"),
  });
  global.Image = class {
    constructor() { this.complete = false; }
  };
}

// A report with a real loudness measurement attached, in the shape the FFmpeg
// worker produces.
function reportWithLevels() {
  const report = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  const blocks = 600;
  const momentary = [];
  const shortTerm = [];
  const truePeak = [];
  for (let i = 0; i < blocks; i++) {
    const v = -26 + 6 * Math.sin(i / 40);
    momentary.push(v);
    shortTerm.push(v - 1);
    truePeak.push(0.5);
  }
  const peak = [];
  const rms = [];
  for (let i = 0; i < blocks * 10; i++) {
    const v = 0.05 + 0.4 * Math.abs(Math.sin(i / 30));
    peak.push(v);
    rms.push(v * 0.7);
  }
  report.audio = [{
    pid: 0x102,
    hz: 100,
    peak,
    rms,
    peakDb: -5.2,
    rmsDb: -12.4,
    clipped: 0,
    sampleRate: 44100,
    durationS: 6,
    loudness: {
      measured: true,
      hz: 10,
      stride: 1,
      blocks,
      target: -23,
      integrated: -23.1,
      lra: 2.2,
      truePeakDb: -6,
      momentary,
      shortTerm,
      truePeakCurve: truePeak,
    },
  }];
  return report;
}

test("the audio lane draws a LUFS scale, the R128 curves and the summary", () => {
  installDom();
  const report = reportWithLevels();
  const lanes = timelineLanes(report, new Set());
  const audio = lanes.find((lane) => lane.kind === "audio");
  assert.ok(audio, "no audio lane");
  assert.ok(audio.wave.loudness, "loudness did not reach the lane");

  const height = timelineHeight(report, new Set());
  const canvas = recordingCanvas(1000, height);
  drawMediaTimeline(canvas, report, { t0: 0, t1: report.summary.durationS || 1, hidden: new Set() });

  const labels = canvas.ops.filter((op) => op.op === "fillText").map((op) => String(op.args[0]));
  const joined = labels.join(" | ");
  // The scale is labelled in LUFS, not dBFS.
  assert.ok(labels.includes("-20"), "no -20 mark on the scale: " + joined);
  assert.ok(labels.includes("M"), "momentary curve is not in the legend: " + joined);
  assert.ok(labels.includes("S"), "short-term curve is not in the legend: " + joined);
  // The summary line carries the integrated value, the range and true peak.
  const summary = labels.find((text) => text.includes("I ") && text.includes("LUFS"));
  assert.ok(summary, "no integrated loudness line: " + joined);
  assert.match(summary, /I -23\.1 LUFS/);
  assert.match(summary, /LRA 2\.2 LU/);
  assert.match(summary, /true peak -6\.0 dBFS/);
  assert.match(summary, /target -23 LUFS/);
});

test("the lane says it is not decoded yet rather than showing an empty box", () => {
  installDom();
  const report = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  report.audio = [];
  const canvas = recordingCanvas(900, 220);
  drawMediaTimeline(canvas, report, { t0: 0, t1: report.summary.durationS || 1, hidden: new Set() });
  const labels = canvas.ops.filter((op) => op.op === "fillText").map((op) => String(op.args[0]));
  assert.ok(labels.some((text) => /not decoded yet/.test(text)), labels.join(" | "));
});

test("hovering the audio lane reads the level at that time", () => {
  installDom();
  const report = reportWithLevels();
  const height = timelineHeight(report, new Set());
  const canvas = recordingCanvas(1000, height);
  drawMediaTimeline(canvas, report, { t0: 0, t1: report.summary.durationS || 1, hidden: new Set() });
  const layout = canvas._layout;
  const audioRow = canvas._rows.find((row) => row.lane.kind === "audio");
  assert.ok(audioRow, "no audio row");
  const x = layout.ml + layout.plotW / 2;
  const y = audioRow.top + audioRow.height / 2;
  const hit = hitTimeline(canvas, { clientX: x, clientY: y });
  assert.ok(hit);
  assert.equal(hit.lane.kind, "audio");
  assert.ok(hit.t > 0);

  // With the pointer drawn, the lane prints M, S and peak at that point.
  drawMediaTimeline(canvas, report, {
    t0: 0, t1: report.summary.durationS || 1, hidden: new Set(), hoverX: x,
  });
  const labels = canvas.ops.filter((op) => op.op === "fillText").map((op) => String(op.args[0]));
  const readout = labels.find((text) => text.includes("M ") && text.includes("peak"));
  assert.ok(readout, "no per-point readout: " + labels.join(" | "));
  assert.match(readout, /M -?\d+\.\d LUFS/);
  assert.match(readout, /mono peak -?\d+\.\d dBFS/);
});

test("a taller bar gives every lane more room", () => {
  installDom();
  const report = reportWithLevels();
  const shortCanvas = recordingCanvas(1000, 280);
  drawMediaTimeline(shortCanvas, report, { t0: 0, t1: 4, hidden: new Set(), height: 280 });
  const tallCanvas = recordingCanvas(1000, 520);
  drawMediaTimeline(tallCanvas, report, { t0: 0, t1: 4, hidden: new Set(), height: 520 });
  const shortAudio = shortCanvas._rows.find((row) => row.lane.kind === "audio");
  const tallAudio = tallCanvas._rows.find((row) => row.lane.kind === "audio");
  assert.ok(tallAudio.height > shortAudio.height, "the audio lane did not grow");
  // The backing store follows the device pixel ratio (2 in this stub).
  assert.equal(shortCanvas.height, 560, "the backing store should follow the device pixel ratio");
});

test("zoom narrows the window and a click maps to the right time", () => {
  installDom();
  const report = reportWithLevels();
  const canvas = recordingCanvas(1000, 320);
  drawMediaTimeline(canvas, report, { t0: 0, t1: 4, hidden: new Set() });
  const row = canvas._rows[canvas._rows.length - 1];
  const y = row.top + row.height / 2;
  const left = hitTimeline(canvas, { clientX: 104, clientY: y });
  const right = hitTimeline(canvas, { clientX: 984, clientY: y });
  assert.ok(left && right);
  assert.ok(Math.abs(left.t - 0) < 0.02, "left edge is " + left.t);
  assert.ok(Math.abs(right.t - 4) < 0.05, "right edge is " + right.t);
});
