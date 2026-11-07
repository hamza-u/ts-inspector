// Pre-js for the WebAssembly tool builds.
//
// Emscripten drops the WORKERFS and NODEFS libraries unless the generated code
// mentions them, and they are not reachable from the caller's scope. These two
// helpers live inside the module, where both are in scope, and are published on
// Module so tools-worker.js can mount the dropped File and the CLI can mount
// the directory that holds a capture.

function klMountWorker(FS, file, point) {
  FS.mkdir(point);
  FS.mount(WORKERFS, { files: [file] }, point);
}

function klMountNode(FS, root, point) {
  FS.mkdir(point);
  FS.mount(NODEFS, { root: root }, point);
}

Module["klMountWorker"] = klMountWorker;
Module["klMountNode"] = klMountNode;
