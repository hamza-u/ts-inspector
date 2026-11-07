#!/usr/bin/env node
// Screenshot the built page with the sample stream loaded, for the README.
//
//   python3 build.py --no-gpl
//   node scripts/screenshot.mjs docs/screenshot.png [width] [height] [scale]
//
// Drives headless Chrome over the DevTools protocol, so it can wait for the
// report before it captures. Set CHROME to the browser binary if it is not
// in the default macOS location.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [out = "docs/screenshot.png", w = "1440", h = "1000", scale = "1"] = process.argv.slice(2);
const page = pathToFileURL(resolve("dist/ts-inspector.html")).href + "#sample";
const chromePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
const profile = mkdtempSync(tmpdir() + "/ts-inspector-shot-");
const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=" + port,
  "--user-data-dir=" + profile, "--window-size=" + w + "," + h, "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

try {
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch("http://127.0.0.1:" + port + "/json")).json();
      target = list.find((t) => t.type === "page");
    } catch (err) { /* not up yet */ }
  }
  if (!target) throw new Error("Chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => ws.addEventListener("open", done));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((done) => {
    const n = ++id;
    pending.set(n, done);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: +scale, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.navigate", { url: page });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    await sleep(200);
    ready = await evaluate("!document.getElementById('out').hidden");
  }
  if (!ready) throw new Error("the sample did not finish loading");
  await sleep(800);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("wrote " + out);
  ws.close();
} finally {
  const exited = new Promise((done) => chrome.once("exit", done));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
