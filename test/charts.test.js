import assert from "node:assert/strict";
import { test } from "node:test";

import { drawLines } from "../src/ui/charts.js";

// Records every call the chart makes, and keeps the listeners it adds, so a
// headless test can move the pointer and read what the chart draws.
function recordingCanvas(width, height) {
  const ops = [];
  const listeners = {};
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "" };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key in target) return target[key];
      return (...args) => { ops.push({ op: key, args, fill: target.fillStyle, stroke: target.strokeStyle }); };
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
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener(type, fn) { listeners[type] = fn; },
    listeners,
    ops,
  };
}

function installDom() {
  global.window = { devicePixelRatio: 1 };
  global.document = { documentElement: {} };
  global.getComputedStyle = () => ({ getPropertyValue: () => "#000000" });
}

function texts(canvas) {
  return canvas.ops.filter((o) => o.op === "fillText").map((o) => String(o.args[0]));
}

function leadChart(canvas) {
  drawLines(canvas, {
    title: "First-byte lead (ms)",
    unit: "ms",
    series: [
      { name: "Plan (HRD schedule)", color: "#833ab4", pts: [[0, 100], [1, 200], [2, 300]] },
      { name: "Wire (TS arrival)", color: "#f77737", pts: [[0, 350], [1, 450], [2, 550]] },
    ],
  });
}

test("line chart draws a legend entry for each named series", () => {
  installDom();
  const canvas = recordingCanvas(800, 220);
  leadChart(canvas);
  const all = texts(canvas);
  assert.ok(all.includes("Plan (HRD schedule)"), "plan series is not in the legend: " + all.join(" | "));
  assert.ok(all.includes("Wire (TS arrival)"), "wire series is not in the legend: " + all.join(" | "));
});

test("line chart shows a crosshair and the nearest values under the pointer", () => {
  installDom();
  const canvas = recordingCanvas(800, 220);
  leadChart(canvas);
  assert.ok(canvas.listeners.pointermove, "chart does not listen for the pointer");
  // Plot spans x 56..788 for t 0..2, so x 422 is t = 1.
  canvas.ops.length = 0;
  canvas.listeners.pointermove({ clientX: 422, clientY: 100 });
  const all = texts(canvas);
  assert.ok(all.includes("t 1.000 s"), "tooltip has no time: " + all.join(" | "));
  assert.ok(all.includes("Plan (HRD schedule): 200.0 ms"), "tooltip has no plan value: " + all.join(" | "));
  assert.ok(all.includes("Wire (TS arrival): 450.0 ms"), "tooltip has no wire value: " + all.join(" | "));
  const moves = canvas.ops.filter((o) => o.op === "moveTo").map((o) => o.args.join(","));
  assert.ok(moves.includes("422,16"), "no vertical crosshair line at the pointer");
  assert.ok(moves.includes("56,100"), "no horizontal crosshair line at the pointer");
  canvas.ops.length = 0;
  canvas.listeners.pointerleave({});
  assert.ok(!texts(canvas).includes("t 1.000 s"), "tooltip stays after the pointer leaves");
});

test("line chart crosshair moves with the arrow keys", () => {
  installDom();
  const canvas = recordingCanvas(800, 220);
  leadChart(canvas);
  assert.equal(canvas.attrs.tabindex, "0");
  canvas.ops.length = 0;
  canvas.listeners.keydown({ key: "ArrowRight", preventDefault() {} });
  assert.ok(texts(canvas).some((t) => t.startsWith("t ")), "arrow key does not show the tooltip");
});
