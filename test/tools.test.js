import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { compareScte, parseSrt } from "../src/ui/tools.js";
import { decodeScte35 } from "../src/worker/scte35.js";
import { inspectBytes } from "../src/worker/inspect.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// The vendor modules are built by scripts/build_wasm.py and are not committed
// to every checkout, so the end-to-end tests step aside when they are absent.
const HAVE = ["ccextractor", "telxcc", "libklscte35"].every((name) =>
  existsSync(root + "/vendor/" + name + "/" + name + ".js") &&
  existsSync(root + "/vendor/" + name + "/" + name + ".wasm"));

// A local capture with CEA-608 captions. Real captures stay out of the
// repository; point CAPTION_TS at one to run the test.
const CAPTION_TS = process.env.CAPTION_TS || "";

// Loads one Emscripten factory out of a CommonJS-style glue file, the way the
// worker loads it from the concatenated source.
function factory(file, name) {
  const text = readFileSync(file, "utf8");
  const dir = file.slice(0, file.lastIndexOf("/"));
  const build = new Function("require", "module", "exports", "__dirname", "__filename",
    text + "\nreturn " + name + ";");
  return build(createRequire(import.meta.url), { exports: {} }, {}, dir, file);
}

async function ccextractor(file, args) {
  const create = factory(root + "/vendor/ccextractor/ccextractor.js", "createModule");
  const mod = await create({ print: () => {}, printErr: () => {} });
  mod.FS.writeFile("/in.ts", readFileSync(file));
  const code = mod.callMain(args || ["-quiet", "-out=srt", "-o", "/out.srt", "/in.ts"]);
  let srt = "";
  try { srt = mod.FS.readFile("/out.srt", { encoding: "utf8" }); } catch (err) { /* nothing written */ }
  return { code, srt };
}

async function libklscte35(hex) {
  const create = factory(root + "/vendor/libklscte35/libklscte35.js", "createKl");
  const mod = await create({});
  const bytes = Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  const ptr = mod._malloc(bytes.length);
  mod.HEAPU8.set(bytes, ptr);
  const text = mod.UTF8ToString(mod._kl_parse(ptr, bytes.length));
  mod._free(ptr);
  return JSON.parse(text);
}

test("SubRip cues are read with their times and text", () => {
  const srt = "\uFEFF1\r\n00:00:02,335 --> 00:00:07,506\r\nMISTAKES, THE THINGS\r\nKEEP DOING WELL.\r\n\r\n"
    + "2\n00:00:09,000 --> 00:00:10,250\n<font color=\"#fff\">Second line</font>\n";
  const cues = parseSrt(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].t0, 2.335);
  assert.equal(cues[0].t1, 7.506);
  assert.equal(cues[0].text, "MISTAKES, THE THINGS KEEP DOING WELL.");
  assert.equal(cues[1].text, "Second line");
  assert.deepEqual(parseSrt(""), []);
  assert.deepEqual(parseSrt("not a subtitle"), []);
});

test("the caption SEI detector counts GA94 messages and their type", () => {
  const file = readFileSync(root + "/test/fixtures/cc608.ts");
  const report = inspectBytes(file);
  const stream = report.video.streams[0];
  assert.ok(stream.captions, "no caption SEI was detected");
  assert.ok(stream.captions.messages > 10);
  assert.equal(stream.captions.cea608, true);
  assert.equal(stream.captions.cea708, false);
  // A file with no SEI captions must not claim any.
  const quiet = inspectBytes(readFileSync(root + "/test/fixtures/ok.ts"));
  assert.equal((quiet.video.streams[0] || {}).captions, null);
});

test("the SCTE-35 events keep the exact section bytes for a second parse", () => {
  const file = readFileSync(root + "/test/fixtures/cue_pair.ts");
  const report = inspectBytes(file);
  assert.ok(report.scte35.length >= 2);
  for (const event of report.scte35) {
    assert.match(event.section, /^fc/);
    const again = decodeScte35(Uint8Array.from(event.section.match(/../g), (h) => parseInt(h, 16)));
    assert.equal(again.command.eventId, event.command.eventId);
  }
});

test("the comparison only reports fields where both parsers differ", () => {
  const base = {
    command: { name: "splice_insert", eventId: 48, outOfNetwork: true, breakDuration: 2700000 },
    descriptors: [{ segmentation: { typeId: 0x30, duration: 900000, eventId: 32, upid: "AD1" } }],
  };
  const theirs = {
    command: "0x05", spliceEventId: 48, outOfNetwork: true, breakDuration: 2700000,
    segmentation: [{ typeId: 0x30, duration: 900000, eventId: 32, upid: "414431" }],
  };
  assert.deepEqual(compareScte(base, theirs), []);
  const changed = { ...theirs, spliceEventId: 49 };
  const diffs = compareScte(base, changed);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, "event id");
  assert.equal(diffs[0].theirs, 49);
});

test("wasm CCExtractor extracts the caption from a real capture", { skip: !HAVE || !CAPTION_TS || !existsSync(CAPTION_TS) }, async () => {
  const wasm = await ccextractor(CAPTION_TS);
  assert.equal(wasm.code, 0);
  const cues = parseSrt(wasm.srt);
  assert.ok(cues.length > 0, "the wasm run produced no cue");
  // CAPTION_TEXT, when set, is a word the captions must contain.
  if (process.env.CAPTION_TEXT) assert.ok(wasm.srt.includes(process.env.CAPTION_TEXT));
  // The native build is the reference, but it is optional.
  const native = spawnSync("ccextractor", ["-quiet", "-out=srt", "-o", "/tmp/ccx-native.srt", CAPTION_TS]);
  if (native.status === 0) {
    const text = readFileSync("/tmp/ccx-native.srt", "utf8");
    assert.equal(text.replace(/\r/g, "").trim(), wasm.srt.replace(/\r/g, "").trim());
  }
});

test("wasm libklscte35 agrees with our parser on every fixture section", { skip: !HAVE }, async () => {
  for (const name of ["ok.ts", "cue_pair.ts"]) {
    const file = readFileSync(root + "/test/fixtures/" + name);
    const report = inspectBytes(file);
    assert.ok(report.scte35.length > 0, name + " has no SCTE section");
    for (const event of report.scte35) {
      const theirs = await libklscte35(event.section);
      assert.equal(theirs.ok, true, name + " section was rejected: " + JSON.stringify(theirs));
      assert.equal(theirs.command, "0x0" + (event.command && event.command.name === "splice_insert" ? 5 : 6));
      assert.deepEqual(compareScte(event, theirs), [], name + " packet " + event.packetIndex);    }
  }
});

test("wasm telxcc reads each page on its own clock", { skip: !HAVE }, async () => {
  const create = factory(root + "/vendor/telxcc/telxcc.js", "createTelx");
  const run = async (page) => {
    // A fresh module per page, as tools-worker.js does: telxcc keeps its
    // timestamps in static state and would otherwise carry them over.
    const mod = await create({ print: () => {}, printErr: () => {} });
    mod.FS.writeFile("/in.ts", readFileSync(root + "/test/fixtures/teletext.ts"));
    const code = mod.callMain(["-i", "/in.ts", "-o", "/out.srt", "-n", "-p", String(page)]);
    return { code, srt: mod.FS.readFile("/out.srt", { encoding: "utf8" }) };
  };
  const first = await run(100);
  assert.equal(first.code, 0);
  // The fixture carries one header and one row, which is not enough for a cue.
  assert.deepEqual(parseSrt(first.srt), []);
  const again = await run(100);
  assert.deepEqual(parseSrt(again.srt), []);
});

test("the teletext descriptor reads its page number as BCD", () => {
  // 0x91 in teletext_page_number is page 91, and magazine 8 is magazine 0.
  const report = inspectBytes(readFileSync(root + "/test/fixtures/teletext.ts"));
  const pmt = report.psi.pmts[0];
  const stream = pmt.streams.find((s) => s.teletext);
  assert.ok(stream, "no teletext stream in the fixture");
  const item = stream.info.find((d) => d.name === "teletext");
  assert.ok(item && item.pages && item.pages.length, "the descriptor lost its pages");
  assert.equal(item.pages[0].page, 100);
  // The fixture's 0x09 is a teletext_subtitle descriptor (type 1).
  assert.equal(item.pages[0].type, 1);
});

test("the page build leaves the tools out with --no-gpl and says MIT", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-inspector-build-"));
  const barePath = join(dir, "bare.html");
  execFileSync("python3", ["build.py", "--no-gpl", "--out", barePath], { cwd: root });
  const head = readFileSync(barePath, "utf8").slice(0, 4000);
  assert.match(head, /^<!doctype html>\n<!--\nTS Inspector\n\nMIT License/);
  assert.equal(head.includes("General Public License"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("the page build carries the tools when they are built and not otherwise", { skip: !HAVE }, () => {
  // Each build goes to its own file: tests run in parallel and must not race
  // on dist/ts-inspector.html.
  const dir = mkdtempSync(join(tmpdir(), "ts-inspector-build-"));
  const barePath = join(dir, "bare.html");
  const fullPath = join(dir, "full.html");
  execFileSync("python3", ["build.py", "--no-gpl", "--out", barePath], { cwd: root });
  const bareHtml = readFileSync(barePath, "utf8");
  assert.match(bareHtml, /createTools\(\) \{ return null; \}/);
  assert.equal(bareHtml.includes("ccextractor\": \""), false);
  assert.ok(bareHtml.length < 5_000_000, "the MIT-only build should stay small");

  execFileSync("python3", ["build.py", "--out", fullPath], { cwd: root });
  const full = readFileSync(fullPath, "utf8");
  assert.match(full, /createTools\(\{/);
  for (const name of ["ccextractor", "telxcc", "libklscte35"]) {
    assert.ok(full.includes(name + "\": \""), name + " was not embedded");
  }
  const notice = full.slice(0, 4000);
  assert.match(notice, /ccextractor, GPL-2\.0-only/);
  assert.match(notice, /distributed under the GNU General Public License, version 2/);
  rmSync(dir, { recursive: true, force: true });
});
