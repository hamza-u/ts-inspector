// Runs the three WebAssembly tools. This file is a classic worker: build.py
// concatenates the Emscripten loaders ahead of it, so each factory is a plain
// function in scope. Nothing is fetched; the wasm bytes arrive with the init
// message and go to Module.wasmBinary, which is what makes the page work from
// file://.
//
// The dropped File is mounted with WORKERFS, never copied: the tools read the
// bytes they need straight out of the browser's file handle, so a 4 GB capture
// costs nothing in memory or time up front.

let modules = { ccextractor: null, telxcc: null, libklscte35: null };
let payload = {};
let busy = false;

function toBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

// --- module lifecycles ------------------------------------------------------

// These modules are built by a recent Emscripten that no longer reads
// Module.wasmBinary. It asks for an instantiateWasm hook instead, which is also
// the only way to supply the bytes when the page came from file:// and there is
// nothing to fetch.
function makeBoot(binary, base) {
  return {
    noInitialRun: true,
    print: () => {},
    printErr: () => {},
    locateFile: (name) => base + name,
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(binary, imports).then((result) => {
        done(result.instance, result.module);
      }, (err) => {
        post({ type: "error", id: -1, message: "wasm did not start: " + (err && err.message ? err.message : err) });
      });
      return {};
    },
  };
}

async function ccxModule() {
  if (!modules.ccextractor) {
    modules.ccextractor = await createModule(makeBoot(toBytes(payload.ccextractor), "/ccextractor/"));
  }
  return modules.ccextractor;
}

async function telxModule() {
  // One instance per job: telxcc keeps its clock in static state.
  return createTelx(makeBoot(toBytes(payload.telxcc), "/telxcc/"));
}

async function klModule() {
  if (!modules.libklscte35) {
    modules.libklscte35 = await createKl(makeBoot(toBytes(payload.libklscte35), "/libklscte35/"));
  }
  return modules.libklscte35;
}

// WORKERFS is a worker-only mount. It is mounted once per module and the file
// is given the same name every time, so a second job does not remount.
function mountFile(mod, file, mountPoint, name) {
  const FS = mod.FS;
  // The mount helper lives inside the module, where WORKERFS is in scope; a
  // classic worker has no access to it from here.
  try { FS.unmount(mountPoint); } catch (err) { /* nothing mounted */ }
  try { FS.rmdir(mountPoint); } catch (err) { /* not a directory any more */ }
  mod.klMountWorker(FS, file, mountPoint);
  const path = mountPoint + "/" + name;
  if (file.name !== name) {
    // WORKERFS names the file after the File object; the tools are given the
    // path we control, so a copy of the name is not needed if we pass the real
    // one. This branch only guards against a File without a name.
    try { FS.rename(mountPoint + "/" + file.name, path); } catch (err) { /* keep as is */ }
  }
  return path;
}

function readText(mod, name) {
  try {
    return mod.FS.readFile(name, { encoding: "utf8" });
  } catch (err) {
    return "";
  }
}

function dropFile(mod, name) {
  try { mod.FS.unlink(name); } catch (err) { /* not written */ }
}

// --- jobs -------------------------------------------------------------------

// CCExtractor writes SubRip. The flags mirror a plain `ccextractor -out=srt`:
// autodetect the stream, both 608 and 708, no colour markup.
function runCaptions(msg) {
  const mod = msg.module;
  const input = mountFile(mod, msg.file, "/captions", msg.file.name);
  const out = "/ccx.srt";
  dropFile(mod, out);
  const args = ["-quiet", "-out=srt", "-o", out];
  if (msg.service) args.push("-svc", String(msg.service));
  args.push(input);
  let code = 0;
  try {
    code = mod.callMain(args);
  } catch (err) {
    code = -1;
  }
  const srt = readText(mod, out);
  dropFile(mod, out);
  return { type: "captions", srt, exitCode: code };
}

// telxcc writes SubRip for one teletext page. A fresh module instance is made
// for every page: the tool keeps its timestamps in static state, so a second
// run in the same instance would carry the first page's clock forward.
function runTeletext(msg) {
  const mod = msg.module;
  const input = mountFile(mod, msg.file, "/teletext", msg.file.name);
  const out = "/telx.srt";
  dropFile(mod, out);
  const args = ["-i", input, "-o", out, "-n"];
  if (msg.pid) args.push("-t", String(msg.pid));
  if (msg.page) args.push("-p", String(msg.page));
  let code = 0;
  try {
    code = mod.callMain(args);
  } catch (err) {
    code = -1;
  }
  const srt = readText(mod, out);
  dropFile(mod, out);
  return { type: "teletext", srt, pid: msg.pid, page: msg.page, exitCode: code };
}

// libklscte35 parses one splice_info_section and prints a JSON line. The
// sections come from our own demuxer, so the comparison is of two parsers on
// exactly the same bytes.
function runScte(msg) {
  const mod = msg.module;
  const items = [];
  for (const item of msg.sections || []) {
    const bytes = Uint8Array.from(item.hex.match(/../g) || [], (h) => parseInt(h, 16));
    if (!bytes.length) continue;
    const ptr = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, ptr);
    let text = "";
    try {
      text = mod.UTF8ToString(mod._kl_parse(ptr, bytes.length));
    } finally {
      mod._free(ptr);
    }
    items.push({ index: item.index, json: text });
  }
  return { type: "scte", items };
}

function handler(msg) {
  if (msg.job === "captions") return runCaptions(msg);
  if (msg.job === "teletext") return runTeletext(msg);
  if (msg.job === "scte") return runScte(msg);
  throw new Error("unknown job " + msg.job);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === "init") {
    payload = msg.wasm || {};
    modules = { ccextractor: null, telxcc: null, libklscte35: null };
    post({ type: "ready" });
    return;
  }
  if (msg.type !== "run") return;
  if (busy) {
    post({ type: "error", id: msg.id, message: "the tool worker is busy" });
    return;
  }
  busy = true;
  try {
    if (msg.job === "captions") msg.module = await ccxModule(msg);
    else if (msg.job === "teletext") msg.module = await telxModule(msg);
    else if (msg.job === "scte") msg.module = await klModule(msg);
    const result = handler(msg);
    result.id = msg.id;
    post(result);
  } catch (err) {
    post({ type: "error", id: msg.id, message: err && err.message ? err.message : String(err) });
  } finally {
    busy = false;
  }
};
