import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { allLaneKeys, cueMarkers, drawMediaTimeline, timelineLanes } from "../src/ui/media-timeline.js";
import { mount } from "../src/ui/app.js";
import { inspectBytes } from "../src/worker/inspect.js";
import { applyTheme, nextTheme, readTheme, THEME_KEY } from "../src/ui/theme.js";

const root = fileURLToPath(new URL("..", import.meta.url));

const IDS = [
  "file", "drop", "out", "progress", "bar", "plabel", "cancel", "json", "csv", "html",
  "summary", "overview", "pids", "psi", "siTree", "epg", "rate", "legend", "checks",
  "errTimeline", "events", "pcr", "pts", "pcrNote", "pcrHist", "esTree", "esFrames",
  "esGops", "hrdNote", "hrdFull", "hrdLead", "hrdJoins", "tstdNote", "tstdChart",
  "tstdEvents", "subList", "subText", "subCanvas", "subNote", "pktIndex", "pktSum", "hex", "pktGo",
  "reportTable", "timelineBar", "timelineChips", "mediaTimeline", "timelineDetail",
  "timelineSub", "thumbCount", "thumbLoad", "zoomReset", "zoomIn", "zoomOut", "zoomSpan",
  "timelineSpan", "timelineGrip", "cueLegend", "theme", "tabs",
  "ccNote", "ccRun", "ccSave", "ccList", "ttRun", "ttSave", "ttList", "scteCheck", "scteNote",
];

function stubPage() {
  const calls = [];
  function makeCtx(id) {
    const state = { id };
    return new Proxy(state, {
      get(target, key) {
        if (key === "measureText") return () => ({ width: 10 });
        if (key === "canvas") return { width: 800, height: 150 };
        if (typeof key === "string" && !(key in target)) {
          return (...args) => { calls.push({ op: key, canvas: target.id, args }); };
        }
        return target[key];
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    });
  }
  function node(tag) {
    const classes = new Set();
    const n = {
      tag,
      id: "",
      hidden: false,
      _html: "",
      textContent: "",
      value: "12",
      style: {},
      dataset: {},
      children: [],
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); return classes.has(c); },
        contains: (c) => classes.has(c),
      },
      classes,
      appendChild(child) { this.children.push(child); },
      addEventListener() {},
      querySelectorAll: () => [],
      setAttribute() {},
      getAttribute() { return "auto"; },
      getContext() { return makeCtx(this.id); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 150 }),
      clientWidth: 900,
    };
    Object.defineProperty(n, "innerHTML", {
      get() { return this._html; },
      set(value) {
        this._html = value;
        this.children.length = 0;
      },
    });
    return n;
  }
  const els = new Map();
  for (const id of IDS) {
    const e = node("div");
    e.id = id;
    // A canvas keeps a backing store; the subtitle preview is checked by its
    // size, so a stub that never resized would hide a stale picture.
    if (id === "subCanvas" || id === "timelineSub") {
      e.width = 720;
      e.height = 240;
      e.getContext = () => ({
        fillStyle: "",
        fillRect() {},
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
        clearRect() {},
      });
    }
    if (id === "file") {
      e.files = [{
        name: "hrd_ok.ts",
        size: 3008,
        slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(188)) }),
      }];
      e.onchange = null;
      e.addEventListener = (type, fn) => { if (type === "change") e.onchange = fn; };
    }
    els.set(id, e);
  }
  const doc = {
    documentElement: { setAttribute() {}, getAttribute() { return "auto"; } },
    getElementById: (id) => els.get(id) || null,
    querySelectorAll: () => [],
    createElement: (tag) => node(tag),
    body: { addEventListener() {} },
  };
  return { doc, els, calls };
}

function stubWindow(doc) {
  global.window = {
    devicePixelRatio: 1,
    addEventListener() {},
  };
  global.document = doc || {
    documentElement: { setAttribute() {}, getAttribute() { return "auto"; } },
  };
  global.getComputedStyle = () => ({ getPropertyValue: () => "#222" });
  global.localStorage = { getItem: () => "auto", setItem() {} };
  global.Image = class { constructor() { this.complete = false; } };
}

test("the page has one timeline element and no duplicate ids", () => {
  const html = readFileSync(root + "/src/ui/index.html", "utf8");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert.deepEqual(dup, []);
  assert.ok(ids.includes("mediaTimeline"));
  assert.ok(ids.includes("errTimeline"));
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.equal((html.match(/id="timeline"/g) || []).length, 0);
});

test("cue markers carry a direction and lane keys stay stable", () => {
  const ok = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  const cues = cueMarkers(ok);
  assert.ok(cues.length > 0);
  assert.ok(cues.every((c) => c.cue === "out" || c.cue === "in"));
  assert.ok(allLaneKeys(ok).includes("scte:500"));
  const hidden = new Set(["scte:500"]);
  assert.equal(timelineLanes(ok, hidden).some((l) => l.pid === 500), false);
});

test("mounting a report draws lanes into the media canvas", async () => {
  const { doc, els, calls } = stubPage();
  stubWindow(doc);
  const report = inspectBytes(readFileSync(root + "/test/fixtures/hrd_ok.ts"));
  const worker = {
    onmessage: null,
    terminate() {},
    postMessage() {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: { type: "report", report } });
      }, 0);
    },
  };
  mount(doc, { createWorker: () => worker, createDecoder: () => null });
  els.get("file").onchange({ target: { files: els.get("file").files } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const drawn = calls.filter((c) => c.canvas === "mediaTimeline");
  assert.ok(drawn.length > 0, "media timeline was never drawn");
  assert.equal(els.get("timelineBar").hidden, false);
  assert.ok(els.get("mediaTimeline").width > 1, "canvas backing store was not sized");
  assert.ok(els.get("summary").innerHTML.includes("chip"));
});

test("a hidden lane removes it from the drawn set", () => {
  const ok = inspectBytes(readFileSync(root + "/test/fixtures/hrd_ok.ts"));
  const all = allLaneKeys(ok);
  const videoKey = all.find((k) => k.startsWith("video:"));
  assert.ok(videoKey);
  const lanes = timelineLanes(ok, new Set([videoKey]));
  assert.equal(lanes.some((l) => "video:" + l.pid === videoKey), false);
});

test("thumbnails become a lane when the report has stills", () => {
  const ok = inspectBytes(readFileSync(root + "/test/fixtures/hrd_ok.ts"));
  ok.thumbnails = [{ t: 0.02, packetIndex: 2, jpeg: "/9j/2Q==", w: 320, h: 180 }];
  const lanes = timelineLanes(ok, new Set());
  assert.equal(lanes[0].kind, "thumbs");
  assert.equal(lanes[0].rows.length, 1);
});

test("theme choice is stored and the icon flips between modes", () => {
  const store = new Map();
  const attrs = {};
  const button = {
    setAttribute(name, value) { attrs[name] = value; },
  };
  const doc = {
    documentElement: {
      getAttribute: (n) => (n === "data-theme" ? attrs["data-theme"] || null : null),
      setAttribute: (n, v) => { attrs[n] = v; },
    },
    defaultView: {
      localStorage: { setItem: (k, v) => store.set(k, v) },
      matchMedia: () => ({ matches: false }),
    },
    getElementById: (id) => (id === "theme" ? button : null),
  };
  assert.equal(readTheme(doc), "auto");
  assert.equal(applyTheme(doc, "dark"), "dark");
  assert.equal(attrs["data-theme"], "dark");
  assert.equal(store.get(THEME_KEY), "dark");
  assert.match(attrs.title, /light/);
  assert.equal(applyTheme(doc, "light"), "light");
  assert.match(attrs.title, /dark/);
  assert.equal(applyTheme(doc, "sideways"), "auto");
  assert.equal(nextTheme(doc), "dark");
  doc.defaultView.matchMedia = () => ({ matches: true });
  assert.equal(nextTheme(doc), "light");
});

test("the timeline bar is shown on Overview and its own tab only", async () => {
  const html = readFileSync(root + "/src/ui/index.html", "utf8");
  assert.ok(html.includes('data-tab="timeline"'), "no Timeline tab");
  assert.match(html, /#timelineBar\.page\s*\{[^}]*position:\s*static/);
  const { doc, els } = stubPage();
  stubWindow(doc);
  const report = inspectBytes(readFileSync(root + "/test/fixtures/hrd_ok.ts"));
  const buttons = ["overview", "timeline", "pids", "hrd"].map((name) => ({
    dataset: { tab: name },
    classList: { toggle() {} },
  }));
  doc.querySelectorAll = (selector) => (selector === "[data-tab]" ? buttons : []);
  const worker = {
    onmessage: null,
    terminate() {},
    postMessage() {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: { type: "report", report } });
      }, 0);
    },
  };
  mount(doc, { createWorker: () => worker, createDecoder: () => null, createTools: () => null });
  els.get("file").onchange({ target: { files: els.get("file").files } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const bar = els.get("timelineBar");
  // render() ends on Overview, so the bar belongs there and is not a page block.
  assert.equal(bar.hidden, false);
  assert.equal(bar.classList.contains("page"), false);

  // The tab strip has one delegated click handler; drive it directly.
  const click = (tab) => els.get("tabs").onclick({ target: { closest: () => ({ dataset: { tab } }) } });
  click("pids");
  assert.equal(bar.hidden, true, "the bar stayed on the PIDs tab");
  click("hrd");
  assert.equal(bar.hidden, true, "the bar stayed on the HRD tab");
  click("timeline");
  assert.equal(bar.hidden, false, "the bar is missing on its own tab");
  assert.equal(bar.classList.contains("page"), true);
  click("overview");
  assert.equal(bar.hidden, false);
  assert.equal(bar.classList.contains("page"), false);
});

test("the brand mark is a magnifying glass and the tab icon matches", () => {
  const html = readFileSync(root + "/src/ui/index.html", "utf8");
  const mark = html.slice(html.indexOf('class="mark"'), html.indexOf('class="mark"') + 600);
  assert.match(mark, /<circle cx="10\.5" cy="10\.5" r="6\.5"\/>/);
  assert.match(mark, /M15\.5 15\.5 21 21/);
  assert.equal(mark.includes("<rect x=\"3\" y=\"6\""), false, "the camera icon is still there");
  assert.match(html, /rel="icon" href="data:image\/svg\+xml/);
});

test("a new file empties the DVB subtitle preview instead of keeping the last one", async () => {
  global.window = { devicePixelRatio: 1, addEventListener() {}, innerHeight: 900 };
  global.document = { documentElement: { setAttribute() {}, getAttribute() { return "auto"; } } };
  global.getComputedStyle = () => ({ getPropertyValue: () => "#222" });
  global.localStorage = { getItem: () => "auto", setItem() {} };
  global.Image = class { constructor() { this.complete = false; } };
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  const { doc, els } = stubPage();
  stubWindow(doc);
  const withSubs = inspectBytes(readFileSync(root + "/test/fixtures/dvbsub.ts"));
  const without = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  assert.ok((withSubs.subtitles || []).some((s) => s.pixels), "the fixture has no subtitle picture");

  // The worker answers with whichever report the test wants next.
  let next = withSubs;
  const worker = {
    onmessage: null,
    terminate() {},
    postMessage() {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: { type: "report", report: next } });
      }, 0);
    },
  };
  mount(doc, { createWorker: () => worker, createDecoder: () => null, createTools: () => null });
  const input = els.get("file");
  input.onchange({ target: { files: input.files } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const canvas = els.get("subCanvas");
  // The first file painted a real picture into the preview.
  assert.ok(canvas.width > 1 && canvas.height > 1, "the first subtitle was never painted");

  next = without;
  input.onchange({ target: { files: input.files } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The second file has no subtitle, so the backing store must be cleared and
  // the empty box hidden rather than left as a blank panel.
  assert.equal(canvas.width, 1, "the previous subtitle is still on the canvas");
  assert.equal(canvas.height, 1);
  assert.equal(canvas.hidden, true, "the empty preview box is still taking up space");
  assert.match(els.get("subNote").textContent, /No DVB subtitle picture/);

  // And a third file with a picture puts it back.
  next = withSubs;
  input.onchange({ target: { files: input.files } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(canvas.hidden, false);
  assert.ok(canvas.width > 1 && canvas.height > 1);
});

test("the theme button is a single icon, and light and dark both define the pink accent", () => {  const html = readFileSync(root + "/src/ui/index.html", "utf8");
  assert.equal((html.match(/id="theme"/g) || []).length, 1);
  assert.equal(html.includes("data-theme-choice"), false);
  assert.ok(html.includes("class=\"iconbtn\""));
  assert.ok((html.match(/--instagram:/g) || []).length >= 3);
  assert.ok(html.includes("--accent: #d6249f"));
  assert.ok(html.includes("--accent: #e1306c"));
  assert.match(html, /\.filebtn\s*\{[^}]*--instagram/);
});

test("a build without the media core disables the thumbnail control", () => {
  const { doc, els } = stubPage();
  stubWindow(doc);
  mount(doc, { createWorker: () => ({ postMessage() {}, terminate() {} }), createDecoder: () => null, hasMediaCore: false });
  assert.equal(els.get("thumbLoad").disabled, true);
  assert.equal(els.get("thumbCount").disabled, true);
  assert.match(els.get("thumbLoad").title, /full build/);
});

test("a build with the media core keeps stills and audio enabled", () => {
  const { doc, els } = stubPage();
  stubWindow(doc);
  mount(doc, { createWorker: () => ({ postMessage() {}, terminate() {} }), createDecoder: () => null });
  assert.equal(els.get("thumbLoad").disabled, false);
});
