// Turns the embedded FFmpeg core into a worker and decodes one audio PID or
// a handful of I-frame stills. Only the packets that are needed are sent,
// so a large capture is read in slices and never loaded whole.

import { decodePlan, LEVEL_BUDGET } from "./audio-level.js";
import { collectPid, findParameterSets, findPsi, framingOf, miniTs } from "./extract.js";

export function createAudioDecoder(opts) {
  if (!opts || !opts.wasmB64 || !opts.workerSrc) return null;
  let worker = null;
  let ready = null;
  let current = null;

  function ensure() {
    if (worker) return ready;
    // The core is concatenated into workerSrc, and the wasm travels as bytes.
    const workerUrl = URL.createObjectURL(new Blob([opts.workerSrc], { type: "text/javascript" }));
    worker = new Worker(workerUrl);
    ready = new Promise((resolve, reject) => {
      const wait = (event) => {
        const msg = event.data || {};
        if (msg.type === "ready") {
          worker.removeEventListener("message", wait);
          resolve();
        } else if (msg.type === "error") {
          worker.removeEventListener("message", wait);
          reject(new Error(msg.message || "ffmpeg failed to start"));
        }
      };
      worker.addEventListener("message", wait);
      worker.postMessage({ type: "init", wasmB64: opts.wasmB64 });
    });
    return ready;
  }

  function stop() {
    current = null;
    if (worker) {
      worker.terminate();
      worker = null;
      ready = null;
    }
  }

  function request(message, transfer, match, onStatus) {
    const token = {};
    current = token;
    return new Promise((resolve, reject) => {
      const wait = (event) => {
        if (current !== token) {
          worker.removeEventListener("message", wait);
          reject(new Error("cancelled"));
          return;
        }
        const msg = event.data || {};
        if (msg.type === "progress" && onStatus) {
          onStatus(msg);
          return;
        }
        if (match(msg)) {
          worker.removeEventListener("message", wait);
          resolve(msg);
        } else if (msg.type === "error") {
          worker.removeEventListener("message", wait);
          reject(new Error(msg.message + (msg.log ? "\n" + msg.log : "")));
        }
      };
      worker.addEventListener("message", wait);
      worker.postMessage(message, transfer);
      if (onStatus) onStatus({ type: "progress", done: 0, total: 0 });
    });
  }

  // Audio only needs its own PID. The video PID and the null padding, which
  // are most of a capture, are never read.
  async function audioPid(file, report, pid, onStatus) {
    const framing = framingOf(report);
    const total = Math.floor(file.size / framing.size);
    const from = 0;
    const to = total;
    const psi = await findPsi(file, framing, Math.min(total, 20000));
    if (!psi.patPkt && !psi.pmtPkt) {
      throw new Error("No PAT or PMT found in the first " + Math.round(Math.min(file.size, 20000 * framing.size) / 1e6) + " MB");
    }
    if (onStatus) onStatus({ text: "Reading audio packets on PID " + pid });
    const parts = await collectPid(file, framing, pid, from, to, (done, end) => {
      if (onStatus) onStatus({ text: "Reading PID " + pid + " · " + Math.round(100 * done / Math.max(1, end)) + "%" });
    });
    if (!parts.length) throw new Error("PID " + pid + " has no packets in this file");
    const bytes = await miniTs(file, framing, psi, [parts]);
    return { bytes, packets: parts.length };
  }

  return {
    available: true,
    cancel: stop,
    // EBU R128 loudness of the audio PID plus a small PCM envelope for the
    // waveform shape. `durationS` comes from the report, so the decode can be
    // planned before a byte is read: a long capture is decoded in chunks
    // rather than in one pass the wasm heap could not hold.
    async decode(file, pid, report, onStatus) {
      const built = await audioPid(file, report, pid, onStatus);
      await ensure();
      const durationS = (report.summary && report.summary.durationS) || 0;
      const plan = decodePlan(durationS, LEVEL_BUDGET);
      if (onStatus) {
        onStatus({
          text: plan.chunkS
            ? "Measuring " + built.packets + " audio packets in " + Math.ceil((durationS || 1) / plan.chunkS) + " chunks"
            : "Measuring " + built.packets + " audio packets",
        });
      }
      const msg = await request(
        { type: "wave", pid, bytes: built.bytes, durationS, rate: plan.rate },
        [built.bytes.buffer],
        (m) => m.type === "wave" && m.pid === pid,
        (status) => {
          if (!onStatus) return;
          if (status.text) onStatus(status);
          else if (status.total) {
            onStatus({ text: "Decoding audio · " + Math.round(100 * status.done / status.total) + "%" });
          }
        },
      );
      return { pid, ...msg.envelope, chunked: !!msg.chunked };
    },
    // Stills come from a small window around each requested I frame, so a
    // large capture turns into a few MB of demuxer input. Each window is its
    // own decode: one window cannot decode a picture from another.
    async thumbnails(file, times, report, onStatus) {
      if (!times.length) return [];
      const framing = framingOf(report);
      const rate = (report.summary && report.summary.muxBps) || 0;
      const perPacket = rate > 0 ? (188 * 8) / rate : 0;
      const total = Math.floor(file.size / framing.size);
      const psi = await findPsi(file, framing, Math.min(total, 20000));
      psi.parameterSets = await findParameterSets(file, framing, Math.min(total, 200000));
      const jobs = [];
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        if (perPacket <= 0) continue;
        const at = Math.floor(t / perPacket);
        // Start a little before the target so its access unit is whole, and
        // stop after it. One GOP at 25 fps is under a second of packets.
        const lead = Math.max(400, Math.floor(0.35 / perPacket));
        const tail = Math.max(2400, Math.floor(1.2 / perPacket));
        const from = Math.max(0, at - lead);
        const to = Math.min(total, at + tail);
        if (onStatus) onStatus({ text: "Reading still " + (i + 1) + " of " + times.length });
        const packets = await collectPid(file, framing, -1, from, to);
        jobs.push({
          name: "still-" + i + ".ts",
          bytes: await miniTs(file, framing, psi, [packets]),
          times: [t],
        });
      }
      if (!jobs.length) throw new Error("No place to take a still from this file");
      await ensure();
      if (onStatus) onStatus({ text: "Decoding " + jobs.length + " I-frame stills" });
      const msg = await request(
        { type: "thumbs", jobs },
        jobs.map((job) => job.bytes.buffer),
        (m) => m.type === "thumbs",
      );
      return msg.items;
    },
  };
}
