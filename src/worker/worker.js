// Browser adapter. The page hands it a File; chunks come from file.stream()
// so a multi-GB import is not loaded into one ArrayBuffer.

import { createInspector } from "./inspect.js";

let cancelled = false;

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  if (msg.type !== "analyze") return;
  cancelled = false;
  const file = msg.file;
  try {
    const inspector = createInspector({ fileSize: file.size });
    const reader = file.stream().getReader();
    let got = 0;
    let since = 0;
    while (!cancelled) {
      const step = await reader.read();
      if (step.done) break;
      got += step.value.length;
      inspector.push(step.value);
      const packets = inspector.packetCount();
      if (packets - since >= 100000) {
        since = packets;
        self.postMessage({
          type: "progress",
          packets,
          bytes: got,
          total: file.size,
        });
      }
    }
    if (cancelled) {
      try { await reader.cancel(); } catch (err) { /* already closed */ }
      self.postMessage({ type: "cancelled" });
      return;
    }
    const report = inspector.finish();
    report.fileName = file.name || "";
    self.postMessage({ type: "report", report });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
};
