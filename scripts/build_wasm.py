#!/usr/bin/env python3
"""Build the three WebAssembly tools that back the subtitles and SCTE views.

CCExtractor (CEA-608/708 and more, GPL-2.0-only), telxcc (teletext to SRT,
GPL-2.0-or-later) and libklscte35 (SCTE-35 section parsing, LGPL-2.1-or-later)
are compiled to WebAssembly with Emscripten and written to vendor/<tool>/.
build.py then embeds the resulting .js and .wasm files in
dist/ts-inspector.html.

Each tool keeps its own program and its own Module instance. Nothing here is
linked into the inspector's own code, which stays under MIT. A dist that
embeds these modules is distributed under GPL-2.0 as a whole, like the one
with the FFmpeg core.

Usage:
    brew install emscripten          (or source an emsdk environment)
    python3 scripts/build_wasm.py

The sources are cloned at the commits pinned below. Pass --refresh to move a
pin to the current head of its branch.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "vendor" / "src"
SHIM = ROOT / "scripts" / "wasm"
KEEP_LIBS = SHIM / "keep_libs.js"

# Pinned so that a rebuild is reproducible. Licence notes live in vendor/<tool>.
TOOLS = {
    "ccextractor": {
        "repo": "https://github.com/CCExtractor/ccextractor.git",
        "commit": "97b381a2b0bee35d3b22411772329eb540ee511b",  # v0.94
        "license": "LICENSE.txt",
        "note": "GPL-2.0-only",
    },
    "telxcc": {
        # The original repository is gone; this fork is the maintained copy.
        "repo": "https://github.com/kanongil/telxcc.git",
        "commit": "f6b44b3b163407a3d99903f4afa5a0c30c333156",
        "license": "LICENSE",
        "note": "GPL-2.0-or-later",
    },
    "libklscte35": {
        "repo": "https://github.com/stoth68000/libklscte35.git",
        "commit": "a428caef64cd86ba368a613334b6077ecd78c807",
        "license": "lgpl-2.1.txt",
        "note": "LGPL-2.1-or-later",
    },
}

COMMON = [
    "-O3",
    # No debug info: it is most of the module size, and the browser does not
    # need a symbol map to run a subtitle extractor.
    "-g0",
    "-sMODULARIZE=1",
    "-sINVOKE_RUN=0",
    "-sEXIT_RUNTIME=0",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sFORCE_FILESYSTEM=1",
    "-sENVIRONMENT=web,worker,node",
    "-lnodefs.js",
    "-lworkerfs.js",
    # The libraries are dropped unless something names them; the pre-js file
    # mentions WORKERFS so the mount point survives the link.
    "--pre-js", str(KEEP_LIBS),
    "-sEXPORTED_RUNTIME_METHODS=['FS','callMain']",
]


def run(args, **kwargs):
    print("$", " ".join(str(a) for a in args))
    result = subprocess.run([str(a) for a in args], **kwargs)
    if result.returncode != 0:
        raise SystemExit("command failed: " + " ".join(str(a) for a in args))
    return result


def emcc_env():
    """Put emcc on PATH, or explain how to get it."""
    if shutil.which("emcc"):
        return None
    for candidate in ("/tmp/emsdk/emsdk_env.sh", str(Path.home() / "emsdk" / "emsdk_env.sh")):
        if Path(candidate).is_file():
            text = subprocess.run(
                ["bash", "-lc", "source " + candidate + " >/dev/null 2>&1; command -v emcc"],
                capture_output=True, text=True,
            ).stdout.strip()
            if text:
                env = dict(os.environ)
                env["PATH"] = str(Path(text).parent) + ":" + env.get("PATH", "")
                env.setdefault("EMSDK", "/tmp/emsdk")
                return env
    raise SystemExit(
        "emcc was not found. Install Emscripten first:\n"
        "  brew install emscripten\n"
        "or\n"
        "  git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install latest && ./emsdk activate latest\n"
    )


def checkout(name, spec, refresh):
    dest = SRC / name
    if not (dest / ".git").is_dir():
        dest.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", spec["repo"], str(dest)])
    have = subprocess.run(["git", "-C", str(dest), "cat-file", "-e", spec["commit"] + "^{commit}"],
                          capture_output=True).returncode == 0
    if not have or refresh:
        run(["git", "-C", str(dest), "fetch", "--depth", "1", "origin", spec["commit"]])
    if refresh:
        head = subprocess.run(["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        print("pin for %s is %s; head is %s" % (name, spec["commit"], head))
    run(["git", "-C", str(dest), "checkout", "--detach", spec["commit"]])
    return dest


def build_ccextractor(env):
    src = SRC / "ccextractor"
    build = src / "build-wasm"
    if build.exists():
        shutil.rmtree(build)
    build.mkdir(parents=True)
    cmake = shutil.which("cmake")
    emcmake = shutil.which("emcmake")
    if not emcmake:
        raise SystemExit("emcmake was not found; is the Emscripten environment sourced?")
    run([
        emcmake, cmake, str(src / "src"),
        "-DWITHOUT_RUST=ON", "-DWITH_OCR=OFF", "-DWITH_HARDSUBX=OFF", "-DWITH_FFMPEG=OFF",
        "-DCMAKE_BUILD_TYPE=Release",
        # Old projects still declare cmake_minimum_required below 3.5.
        "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
        "-DCMAKE_C_FLAGS=-O3 -g0 -D_FILE_OFFSET_BITS=64",
        # -g0 last wins over the -g the project sets for its own library.
        "-DCMAKE_EXE_LINKER_FLAGS=" + " ".join(COMMON + ["-sEXPORT_NAME=createModule"]),
    ], cwd=build, env=env)
    run(["emmake", "make", "-j%d" % max(2, (os.cpu_count() or 4))], cwd=build, env=env)
    wasm = build / "ccextractor.wasm"
    return build / "ccextractor.js", wasm, "createModule"


def build_telxcc(env):
    src = SRC / "telxcc"
    out_js = src / "telxcc.js"
    out_wasm = src / "telxcc.wasm"
    run(["emcc", "-std=gnu99", "-O3", "-sEXPORT_NAME=createTelx",
         *COMMON, "-o", out_js, src / "telxcc.c"], cwd=src, env=env)
    return out_js, out_wasm, "createTelx"


def build_klscte35(env):
    src = SRC / "libklscte35"
    # The output name is what the glue asks for at run time, so it matches the
    # name the module is published under.
    out_js = src / "libklscte35.js"
    out_wasm = src / "libklscte35.wasm"
    objects = []
    for name in ("scte35.c", "crc32.c", "base64.c"):
        obj = src / (name.replace(".c", ".o"))
        run(["emcc", "-std=gnu99", "-O2", "-I", src / "src", "-I", src / "src" / "libklscte35",
             "-c", src / "src" / name, "-o", obj], cwd=src, env=env)
        objects.append(obj)
    run(["emcc", "-std=gnu99", "-O2", "-I", src / "src", "-I", src / "src" / "libklscte35",
         SHIM / "klscte35_shim.c", *objects, *[a for a in COMMON
         if not a.startswith("-sEXPORTED_RUNTIME_METHODS")],
         "-sEXPORT_NAME=createKl",
         "-sEXPORTED_FUNCTIONS=['_kl_parse','_malloc','_free']",
         "-sEXPORTED_RUNTIME_METHODS=['FS','UTF8ToString','HEAPU8']",
         "-o", out_js], cwd=src, env=env)
    return out_js, out_wasm, "createKl"


def optimise(wasm, env):
    """Try wasm-opt, but keep the original if the result does not validate.

    Recent Emscripten emits an import encoding that older Binaryen builds in
    the same distribution reject, so this is a best-effort step. The linker
    runs with -g0, which is where most of the size saving comes from.
    """
    wasm_opt = shutil.which("wasm-opt")
    if not wasm_opt:
        guess = Path(os.environ.get("EMSDK", "/tmp/emsdk")) / "upstream" / "bin" / "wasm-opt"
        wasm_opt = str(guess) if guess.is_file() else None
    if not wasm_opt:
        print("wasm-opt not found; leaving", wasm.name, "unoptimised")
        return
    slim = wasm.with_suffix(".opt.wasm")
    result = subprocess.run([wasm_opt, "-Oz", "--all-features", "--strip-debug", wasm, "-o", slim],
                            capture_output=True, env=env)
    if result.returncode == 0 and validates(slim):
        slim.replace(wasm)
        print("wasm-opt:", wasm.name, wasm.stat().st_size, "bytes")
    else:
        if slim.exists():
            slim.unlink()
        print("wasm-opt skipped (glue and wasm stay as linked):",
              (result.stderr or b"").decode(errors="replace").strip().splitlines()[-1:] or "")


def validates(path):
    node = shutil.which("node")
    if not node:
        return True
    probe = ("const b=require('fs').readFileSync(process.argv[1]);"
             "new WebAssembly.Module(b);")
    return subprocess.run([node, "-e", probe, str(path)], capture_output=True).returncode == 0


def notice(dest, name, spec):
    text = (
        name + " compiled to WebAssembly for TS Inspector\n"
        + "=" * (len(name) + 40) + "\n\n"
        + "Source: " + spec["repo"] + "\n"
        + "Commit: " + spec["commit"] + "\n"
        + "Licence: " + spec["note"] + " (see LICENSE" + (Path(spec["license"]).suffix or ".txt") + " in this directory)\n"
        + "Built with Emscripten, flags in scripts/build_wasm.py.\n\n"
        + "The files " + name + ".js and " + name + ".wasm here are that build. They are\n"
        + "bundled into dist/ts-inspector.html, so a distributed page is, as a\n"
        + "whole, under GPL-2.0. Whoever hosts that page must offer this source\n"
        + "from the same place. The TS Inspector sources are MIT; build with\n"
        + "`python3 build.py --no-gpl` to leave these modules, and FFmpeg, out.\n\n"
        + "Rebuild with: python3 scripts/build_wasm.py --only " + name + "\n"
    )
    (dest / "NOTICE").write_text(text)


def place(name, src_root, out_js, out_wasm, factory, env):
    dest = ROOT / "vendor" / name
    dest.mkdir(parents=True, exist_ok=True)
    optimise(out_wasm, env)
    # The Emscripten glue looks for "<its own name>.wasm". Copying to a
    # differently named file would make Node read the wrong path, and the
    # browser build passes the bytes anyway, so the names are kept in step.
    shutil.copy2(out_js, dest / (name + ".js"))
    shutil.copy2(out_wasm, dest / (name + ".wasm"))
    for extra in dest.glob("*.wasm"):
        if extra.name != name + ".wasm":
            extra.unlink()
    notice(dest, name, TOOLS[name])
    lic = src_root / TOOLS[name]["license"]
    if lic.is_file():
        suffix = Path(TOOLS[name]["license"]).suffix or ".txt"
        shutil.copy2(lic, dest / ("LICENSE" + suffix))
    # The factory name is what build.py looks for in the loader.
    got = (dest / (name + ".js")).read_text(errors="replace")
    if factory not in got:
        raise SystemExit(name + ".js does not define " + factory)
    print("wrote", dest / (name + ".wasm"), (dest / (name + ".wasm")).stat().st_size, "bytes")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the wasm subtitle and SCTE tools")
    parser.add_argument("--refresh", action="store_true", help="move each pin to the current head")
    parser.add_argument("--only", action="append", choices=sorted(TOOLS), help="build one tool (repeatable)")
    args = parser.parse_args()

    env = emcc_env()
    env = dict(os.environ if env is None else env)
    jobs = args.only or ["telxcc", "libklscte35", "ccextractor"]
    for name in jobs:
        spec = TOOLS[name]
        root = checkout(name, spec, args.refresh)
        if name == "ccextractor":
            out_js, out_wasm, factory = build_ccextractor(env)
        elif name == "telxcc":
            out_js, out_wasm, factory = build_telxcc(env)
        else:
            out_js, out_wasm, factory = build_klscte35(env)
        place(name, root, out_js, out_wasm, factory, env)


if __name__ == "__main__":
    main()
