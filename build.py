#!/usr/bin/env python3
"""Inline the inspector into one HTML file that opens from disk.

No bundler and no network. ES module import/export lines are removed and the
files are concatenated in dependency order. The worker is a blob URL.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
UI = ROOT / "src" / "ui"
FFMPEG = ROOT / "vendor" / "ffmpeg"

# The wasm tools, in the order tools-worker.js creates them. Each entry is the
# vendor folder, the factory name in the loader, and the licence it carries.
# CCExtractor is GPL-2.0-only: ccextractor.c, ccx_gxf.c and
# dvb_subtitle_decoder.c say "GPL 2.0" with no "or later". That pins any page
# that embeds it to GPL-2.0, which is why our own sources are MIT and not
# Apache-2.0 (the FSF holds Apache-2.0 incompatible with GPL-2.0).
TOOLS = [
    ("ccextractor", "createModule", "GPL-2.0-only"),
    ("telxcc", "createTelx", "GPL-2.0-or-later"),
    ("libklscte35", "createKl", "LGPL-2.1-or-later"),
]
FFMPEG_LICENCE = "GPL-2.0-or-later"
WORKER_FILES = [
    "crc.js", "tsutil.js", "bits.js", "dvbtext.js", "stream-type.js", "h264.js",
    "framer.js", "clock.js", "psi.js", "scte35.js",
    "tr290.js", "bitrate.js", "timing.js",
    "pes.js", "hrd.js", "tstd.js", "pcrac.js", "timeline.js",
    "teletext.js", "dvbsub.js", "compliance.js",
    "inspect.js", "worker.js",
]
PAGE_FILES = [
    "report.js", "hex.js", "export.js", "charts.js", "audio-level.js", "tools.js",
    "extract.js", "media-timeline.js", "ffmpeg-decode.js", "theme.js", "app.js",
]


# Import lines are deleted, so `import { a as b }` would leave b undefined.
# Keep every import name identical to the exported name.
ALIAS = re.compile(r"^\s*import\s*\{[^}]*\bas\b")


def strip_module(text: str, name: str = "") -> str:
    out = []
    for line in text.splitlines():
        if ALIAS.match(line):
            raise SystemExit(name + " uses an aliased import, which is dropped by the build: " + line.strip())
        stripped = line.strip()
        if stripped.startswith("import "):
            continue
        if stripped.startswith("export {"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        out.append(line)
    return "\n".join(out) + "\n"


def embed(text: str) -> str:
    return (text
            .replace("\\", "\\\\")
            .replace("`", "\\`")
            .replace("${", "\\${")
            .replace("</script>", "<\\/script>"))


def page_text(name: str) -> str:
    if name == "report.js":
        return (ROOT / "src" / "report.js").read_text()
    return (UI / name).read_text()


def ffmpeg_boot(include: bool) -> str:
    if not include:
        return "  createDecoder() { return null; },\n"
    core = (FFMPEG / "ffmpeg-core.js").read_text()
    wasm = (FFMPEG / "ffmpeg-core.wasm").read_bytes()
    # The core is concatenated into the worker source. importScripts of a blob
    # URL is blocked when the page itself was opened from file://.
    # audio-level.js goes ahead of the worker too: the worker builds the peak
    # and RMS envelope, so the dBFS lane never needs the samples in the page.
    worker = (core + "\n"
              + strip_module((UI / "audio-level.js").read_text(), "audio-level.js")
              + (UI / "ffmpeg-worker.js").read_text())
    return (
        "  createDecoder() {\n"
        "    return createAudioDecoder({\n"
        "      wasmB64: \"" + base64.b64encode(wasm).decode("ascii") + "\",\n"
        "      workerSrc: `" + embed(worker) + "`,\n"
        "    });\n"
        "  },\n"
    )


def tools_present() -> bool:
    return all((ROOT / "vendor" / name / (name + ".js")).is_file()
               and (ROOT / "vendor" / name / (name + ".wasm")).is_file()
               for name, _, _ in TOOLS)


def tools_boot(include: bool) -> str:
    if not include:
        return "  createTools() { return null; },\n"
    # Each loader is a factory in its own scope. They are concatenated into the
    # tool worker, and the wasm bytes travel in the init message, so nothing is
    # fetched: a page opened from file:// has no origin to fetch from.
    parts = []
    payload = {}
    for name, factory, _ in TOOLS:
        folder = ROOT / "vendor" / name
        loader = (folder / (name + ".js")).read_text()
        # The glue's CommonJS tail would shadow the factory in a classic worker
        # and it has no meaning there; the factory itself stays.
        tail = loader.find("if (typeof exports === 'object' && typeof module === 'object')")
        if tail != -1:
            loader = loader[:tail]
        elif "module.exports=" in loader:
            loader = loader[:loader.rfind("if(typeof exports===")]
        parts.append(loader + "\n")
        payload[name] = base64.b64encode((folder / (name + ".wasm")).read_bytes()).decode("ascii")
    parts.append((UI / "tools-worker.js").read_text())
    return (
        "  createTools() {\n"
        "    return createTools({\n"
        "      workerSrc: `" + embed("".join(parts)) + "`,\n"
        "      wasm: " + json.dumps(payload) + ",\n"
        "    });\n"
        "  },\n"
    )


MIT_TEXT = (ROOT / "LICENSE").read_text()


def licence_header(include_ffmpeg: bool, include_tools: bool) -> str:
    """Comment placed at the top of the page: one file, so it carries its notices."""
    lines = ["TS Inspector", "", MIT_TEXT.strip(), ""]
    bundled = []
    if include_ffmpeg:
        bundled.append("FFmpeg core (@ffmpeg/core 0.12.6), " + FFMPEG_LICENCE
                       + ". See vendor/ffmpeg/NOTICE.")
    if include_tools:
        for name, _, licence in TOOLS:
            bundled.append(name + ", " + licence + ". See vendor/" + name + "/NOTICE.")
    if bundled:
        lines += [
            "This page also embeds the following programs, compiled to WebAssembly.",
            "Each one keeps its own licence:",
            "",
        ] + ["  - " + b for b in bundled] + [
            "",
            "Because they are bundled into one file, this page as a whole is",
            "distributed under the GNU General Public License, version 2. The",
            "TS Inspector code inside it stays available under MIT on its own.",
            "Corresponding source: the TS Inspector repository, plus each",
            "upstream at the commit named in its NOTICE, rebuilt by",
            "scripts/build_wasm.py and scripts/fetch_ffmpeg.py. Whoever hosts",
            "this page must offer that source from the same place.",
        ]
    body = "\n".join(lines).replace("--", "- -")
    return "<!--\n" + body + "\n-->\n"


def build(include_ffmpeg: bool = True, include_tools: bool = True, out: Path | None = None) -> Path:
    include_tools = include_tools and tools_present()
    worker = "".join(strip_module((ROOT / "src" / "worker" / name).read_text(), name)
                     for name in WORKER_FILES)
    page = "".join(strip_module(page_text(name), name) for name in PAGE_FILES)
    html = (UI / "index.html").read_text()
    boot = (
        page
        + "\nconst WORKER_SRC = `" + embed(worker) + "`;\n"
        + "mount(document, {\n"
        + "  createWorker() {\n"
        + "    const blob = new Blob([WORKER_SRC], { type: \"text/javascript\" });\n"
        + "    return new Worker(URL.createObjectURL(blob));\n"
        + "  },\n"
        + ffmpeg_boot(include_ffmpeg)
        + tools_boot(include_tools)
        + "});\n"
    )
    needle = '<script type="module" src="./main.js"></script>'
    if needle not in html:
        raise SystemExit("index.html is missing the module script tag")
    html = html.replace(needle, "<script>\n" + boot + "</script>")
    doctype = "<!doctype html>\n"
    if not html.startswith(doctype):
        raise SystemExit("index.html must start with " + doctype.strip())
    html = doctype + licence_header(include_ffmpeg, include_tools) + html[len(doctype):]
    # The embedded payloads are base64. Check the page and the inspector worker,
    # which are the parts we author, before those payloads are considered.
    authored = (page + worker + (UI / "index.html").read_text()
                + (UI / "ffmpeg-worker.js").read_text() + (UI / "tools-worker.js").read_text())
    for banned in ("fonts.googleapis", "http://", "https://"):
        if banned in authored:
            raise SystemExit("dist references the network via " + banned)
    dest = out or (ROOT / "dist" / "ts-inspector.html")
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(html)
    with tempfile.TemporaryDirectory() as tmp:
        worker_path = Path(tmp) / "worker.js"
        page_path = Path(tmp) / "page.js"
        worker_path.write_text(worker)
        page_path.write_text(boot)
        for path in (worker_path, page_path):
            check = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
            if check.returncode != 0:
                raise SystemExit(path.name + " failed to parse:\n" + check.stderr)
    return dest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the single-file inspector")
    parser.add_argument("--no-ffmpeg", action="store_true", help="omit the embedded FFmpeg core")
    parser.add_argument("--no-gpl", action="store_true",
                        help="omit FFmpeg and the wasm tools, leaving an MIT-only page")
    parser.add_argument("--out", help="write somewhere other than dist/ts-inspector.html")
    args = parser.parse_args()
    have_core = (FFMPEG / "ffmpeg-core.js").is_file() and (FFMPEG / "ffmpeg-core.wasm").is_file()
    path = build(include_ffmpeg=have_core and not (args.no_ffmpeg or args.no_gpl),
                 include_tools=tools_present() and not args.no_gpl,
                 out=Path(args.out).resolve() if args.out else None)
    print("wrote %s (%d bytes)" % (path, path.stat().st_size))
