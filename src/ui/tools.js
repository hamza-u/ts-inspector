// Client for the WebAssembly subtitle and SCTE tools, and the SubRip reader
// that turns their output into cues the timeline and the tables can use.
//
// The worker is optional: a build made with --no-gpl has no tools, and every
// caller has to cope with createTools() returning null. That keeps the page
// usable as a plain inspector with no GPL payload.

export function parseSrt(text) {
  const cues = [];
  const clean = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.length);
    if (!lines.length) continue;
    let at = 0;
    if (/^\d+$/.test(lines[0])) at = 1;
    const stamp = lines[at] || "";
    const m = stamp.match(/(\d+):(\d\d):(\d\d)[,.](\d{1,3})\s*-->\s*(\d+):(\d\d):(\d\d)[,.](\d{1,3})/);
    if (!m) continue;
    const t0 = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
    const t1 = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8].padEnd(3, "0")) / 1000;
    const body = lines.slice(at + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!body) continue;
    cues.push({ t0, t1: Math.max(t1, t0), text: body });
  }
  cues.sort((a, b) => a.t0 - b.t0);
  return cues;
}

// The tools live in their own worker, built from the vendor modules. When the
// build has none of them, this returns null and the page hides the features.
export function createTools(opts) {
  if (!opts || !opts.workerSrc) return null;
  const have = opts.wasm || {};
  const any = !!(have.ccextractor || have.telxcc || have.libklscte35);
  if (!any) return null;

  let worker = null;
  let ready = null;
  let seq = 0;
  const waiting = new Map();

  function ensure() {
    if (worker) return ready;
    const url = URL.createObjectURL(new Blob([opts.workerSrc], { type: "text/javascript" }));
    worker = new Worker(url);
    ready = new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === "ready") {
          resolve();
          return;
        }
        if (msg.type === "error") {
          const pending = waiting.get(msg.id);
          if (pending) {
            waiting.delete(msg.id);
            pending.reject(new Error(msg.message || "the tool failed"));
          }
          return;
        }
        const pending = waiting.get(msg.id);
        if (!pending) return;
        waiting.delete(msg.id);
        pending.resolve(msg);
      };
      worker.onerror = (event) => {
        const err = new Error((event && event.message) || "the tool worker failed to start");
        if (!waiting.size) reject(err);
        for (const pending of waiting.values()) pending.reject(err);
        waiting.clear();
      };
      worker.postMessage({ type: "init", wasm: have });
    }).catch((err) => {
      stop();
      throw err;
    });
    return ready;
  }

  function stop() {
    if (worker) {
      worker.terminate();
      worker = null;
      ready = null;
    }
    for (const pending of waiting.values()) pending.reject(new Error("cancelled"));
    waiting.clear();
  }

  function run(message) {
    return new Promise((resolve, reject) => {
      seq += 1;
      const id = seq;
      waiting.set(id, { resolve, reject });
      ensure().then(() => worker.postMessage({ ...message, id })).catch((err) => {
        waiting.delete(id);
        reject(err);
      });
    });
  }

  return {
    available: true,
    captions: !!have.ccextractor,
    teletext: !!have.telxcc,
    scte: !!have.libklscte35,
    cancel: stop,
    async captions(file, service) {
      const msg = await run({ type: "run", job: "captions", file, service });
      return { srt: msg.srt || "", cues: parseSrt(msg.srt), exitCode: msg.exitCode };
    },
    async teletext(file, pid, page) {
      const msg = await run({ type: "run", job: "teletext", file, pid, page });
      return { srt: msg.srt || "", cues: parseSrt(msg.srt), pid, page, exitCode: msg.exitCode };
    },
    async scte(sections) {
      const msg = await run({ type: "run", job: "scte", sections });
      return (msg.items || []).map((item) => {
        let parsed = null;
        try { parsed = JSON.parse(item.json); } catch (err) { parsed = { ok: false, error: "unreadable JSON" }; }
        return { index: item.index, ...parsed };
      });
    },
  };
}

// Command names in this project against the SCTE-35 command codes, so a name
// and a hex code compare as equal.
const COMMAND_CODE = {
  splice_null: "0x00",
  "splice_schedule": "0x04",
  splice_insert: "0x05",
  time_signal: "0x06",
  bandwidth_reservation: "0x07",
  private_command: "0xff",
};

// Field-by-field comparison of our SCTE-35 parse with libklscte35's. Only the
// fields both sides produce are compared, and only a real difference is
// reported: a missing field on one side is not a disagreement.
export function compareScte(ours, theirs) {
  const diffs = [];
  if (!ours || !theirs) return diffs;
  const check = (label, a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return;
    if (String(a).toLowerCase() !== String(b).toLowerCase()) diffs.push({ field: label, ours: a, theirs: b });
  };
  const name = ours.command && ours.command.name;
  check("command", COMMAND_CODE[name] || name, theirs.command);
  check("event id", ours.command && ours.command.eventId, theirs.spliceEventId);
  check("out of network", ours.command && ours.command.outOfNetwork, theirs.outOfNetwork);
  check("break duration", ours.command && ours.command.breakDuration, theirs.breakDuration);
  check("pts adjustment", ours.ptsAdjustment, theirs.ptsAdjustment);
  check("tier", ours.tier, theirs.tier);
  const mine = (ours.descriptors || []).find((d) => d.segmentation);
  const yours = (theirs.segmentation || [])[0];
  if (mine && yours) {
    check("segmentation type", mine.segmentation.typeId, yours.typeId);
    check("segmentation duration", mine.segmentation.duration, yours.duration);
    check("segmentation event id", mine.segmentation.eventId, yours.eventId);
    check("segmentation upid", mine.segmentation.upid, hexToText(yours.upid));
  }
  return diffs;
}

function hexToText(hex) {
  if (!hex) return hex;
  let out = "";
  for (const pair of String(hex).match(/../g) || []) out += String.fromCharCode(parseInt(pair, 16));
  return out;
}
