import { mount } from "./app.js";

const workerUrl = new URL("../worker/worker.js", import.meta.url);
mount(document, {
  createWorker() {
    return new Worker(workerUrl, { type: "module" });
  },
});
