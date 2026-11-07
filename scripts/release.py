#!/usr/bin/env python3
"""Build the files attached to a GitHub release.

    python3 scripts/release.py v0.1.0

Writes dist/release/:

    ts-inspector.html                 MIT-only page with the sample stream
    ts-inspector-full.html            full page, GPL-2.0 as a whole
    ts-inspector-full-sources.tar.gz  the corresponding source for the full page
    SHA256SUMS

The full page embeds FFmpeg, CCExtractor, telxcc, and libklscte35, so it is
distributed under GPL-2.0, and its source must be offered from the same place
(GPL-2.0 section 3). The source archive holds this repository at the release
commit, each WebAssembly tool at the commit pinned in scripts/build_wasm.py,
and the ffmpeg.wasm build recipe for @ffmpeg/core 0.12.6 with FFmpeg and every
library at the versions that recipe names.

Needs git, python3, node, and the built modules in vendor/ (see README, Full
build). Clones are cached in vendor/src/release/, which git ignores.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import build  # noqa: E402
from build_wasm import TOOLS  # noqa: E402

OUT = ROOT / "dist" / "release"
CACHE = ROOT / "vendor" / "src" / "release"

# @ffmpeg/core 0.12.6 was released from this commit of ffmpeg.wasm. Its
# Dockerfile names the FFmpeg version and the branch or tag of each library.
FFMPEG_WASM = ("https://github.com/ffmpegwasm/ffmpeg.wasm.git", "c3a763857c5e615ae8674715ad5e4f63ff469e9d")
FFMPEG_DEPS = [
    ("ffmpeg", "https://github.com/FFmpeg/FFmpeg.git", "n5.1.4"),
    ("x264", "https://github.com/ffmpegwasm/x264.git", "4-cores"),
    ("x265", "https://github.com/ffmpegwasm/x265.git", "3.4"),
    ("libvpx", "https://github.com/ffmpegwasm/libvpx.git", "v1.13.1"),
    ("lame", "https://github.com/ffmpegwasm/lame.git", "master"),
    ("ogg", "https://github.com/ffmpegwasm/Ogg.git", "v1.3.4"),
    ("theora", "https://github.com/ffmpegwasm/theora.git", "v1.1.1"),
    ("opus", "https://github.com/ffmpegwasm/opus.git", "v1.3.1"),
    ("vorbis", "https://github.com/ffmpegwasm/vorbis.git", "v1.3.3"),
    ("zlib", "https://github.com/ffmpegwasm/zlib.git", "v1.2.11"),
    ("libwebp", "https://github.com/ffmpegwasm/libwebp.git", "v1.3.2"),
    ("freetype2", "https://github.com/ffmpegwasm/freetype2.git", "VER-2-10-4"),
    ("fribidi", "https://github.com/fribidi/fribidi.git", "v1.0.9"),
    ("harfbuzz", "https://github.com/harfbuzz/harfbuzz.git", "5.2.0"),
    ("libass", "https://github.com/libass/libass.git", "0.15.0"),
    ("zimg", "https://github.com/sekrit-twc/zimg.git", "release-3.0.5"),
]


def git(*args, cwd=None) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def checkout(name: str, repo: str, ref: str) -> tuple[Path, str]:
    """Clone repo at ref (a branch, tag, or commit) with submodules. Returns the commit."""
    dest = CACHE / name
    if not dest.is_dir():
        CACHE.mkdir(parents=True, exist_ok=True)
        print("clone", name, ref)
        git("clone", "--quiet", "--no-checkout", "--filter=blob:none", repo, str(dest))
    else:
        git("fetch", "--quiet", "--tags", "origin", cwd=dest)
    target = ref if len(ref) == 40 else ("origin/" + ref if git("ls-remote", "--heads", "origin", ref, cwd=dest) else ref)
    git("checkout", "--quiet", "--force", target, cwd=dest)
    git("submodule", "--quiet", "update", "--init", "--recursive", cwd=dest)
    return dest, git("rev-parse", "HEAD", cwd=dest)


def add_tree(tar: tarfile.TarFile, src: Path, arcname: str) -> None:
    def skip_git(info: tarfile.TarInfo):
        parts = Path(info.name).parts
        return None if ".git" in parts else info
    tar.add(str(src), arcname=arcname, filter=skip_git)


def add_text(tar: tarfile.TarFile, arcname: str, text: str) -> None:
    data = text.encode()
    info = tarfile.TarInfo(arcname)
    info.size = len(data)
    info.mtime = 0
    tar.addfile(info, io.BytesIO(data))


def source_archive(version: str, dest: Path) -> None:
    top = "ts-inspector-full-sources"
    head = git("rev-parse", "HEAD", cwd=ROOT)
    rows = []
    with tarfile.open(dest, "w:gz") as tar:
        ours = subprocess.run(["git", "archive", "--format=tar", "--prefix=" + top + "/ts-inspector/", head],
                              cwd=ROOT, check=True, capture_output=True).stdout
        with tarfile.open(fileobj=io.BytesIO(ours)) as inner:
            for member in inner.getmembers():
                tar.addfile(member, inner.extractfile(member) if member.isfile() else None)
        rows.append(("ts-inspector", "this repository", version + " (" + head + ")", "MIT"))
        for name, spec in TOOLS.items():
            path, commit = checkout(name, spec["repo"], spec["commit"])
            add_tree(tar, path, top + "/tools/" + name)
            rows.append(("tools/" + name, spec["repo"], commit, spec["note"]))
        path, commit = checkout("ffmpeg.wasm", *FFMPEG_WASM)
        add_tree(tar, path, top + "/ffmpeg-core/ffmpeg.wasm")
        rows.append(("ffmpeg-core/ffmpeg.wasm", FFMPEG_WASM[0], commit, "MIT (build recipe)"))
        for name, repo, ref in FFMPEG_DEPS:
            path, commit = checkout(name, repo, ref)
            add_tree(tar, path, top + "/ffmpeg-core/" + name)
            rows.append(("ffmpeg-core/" + name, repo, ref + " (" + commit + ")", "see its licence files"))
        table = "\n".join("| `%s` | %s | `%s` | %s |" % row for row in rows)
        add_text(tar, top + "/SOURCES.md", """# Corresponding source for ts-inspector-full.html, %s

`ts-inspector-full.html` embeds programs compiled to WebAssembly. Because they
ship in one file, that page is distributed under the GNU General Public
License, version 2. This archive is its corresponding source.

| Folder | Source | Revision | Licence |
|---|---|---|---|
%s

## Rebuild

1. `ts-inspector/`: see its README, Full build. `scripts/build_wasm.py`
   compiles the three tools with Emscripten, using the flags in that script.
2. `ffmpeg-core/`: `ffmpeg.wasm/Dockerfile` builds `@ffmpeg/core` 0.12.6
   (`make prd` in `ffmpeg.wasm/`). The other folders hold FFmpeg and each
   library at the version that Dockerfile names, so the build needs no
   network for sources.
3. Run `python3 build.py` in `ts-inspector/` with the modules in `vendor/`.
""" % (version, table))


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the release files")
    parser.add_argument("version", help="the tag, for example v0.1.0")
    parser.add_argument("--allow-dirty", action="store_true", help="for a trial run only")
    args = parser.parse_args()
    if git("status", "--porcelain", cwd=ROOT) and not args.allow_dirty:
        raise SystemExit("the working tree has changes; commit them first")
    if not build.tools_present() or not (build.FFMPEG / "ffmpeg-core.wasm").is_file():
        raise SystemExit("vendor/ is missing modules; run scripts/build_wasm.py and scripts/fetch_ffmpeg.py")
    OUT.mkdir(parents=True, exist_ok=True)
    files = [
        build.build(include_ffmpeg=False, include_tools=False, out=OUT / "ts-inspector.html"),
        build.build(include_ffmpeg=True, include_tools=True, out=OUT / "ts-inspector-full.html"),
    ]
    archive = OUT / "ts-inspector-full-sources.tar.gz"
    source_archive(args.version, archive)
    files.append(archive)
    sums = "".join(sha256(p) + "  " + p.name + "\n" for p in files)
    (OUT / "SHA256SUMS").write_text(sums)
    for p in files:
        print("%-36s %10d bytes" % (p.name, p.stat().st_size))


if __name__ == "__main__":
    main()
