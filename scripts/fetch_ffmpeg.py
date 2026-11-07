#!/usr/bin/env python3
"""Download the single-thread FFmpeg core used for in-browser waveforms.

The files land in vendor/ffmpeg/. They are GPL-2.0-or-later. See NOTICE there.
"""

from __future__ import annotations

import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "vendor" / "ffmpeg"
FILES = {
    "ffmpeg-core.js": "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",
    "ffmpeg-core.wasm": "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm",
}


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for name, url in FILES.items():
        dest = ROOT / name
        print("fetch", name)
        urllib.request.urlretrieve(url, dest)
        print("wrote", dest, dest.stat().st_size)


if __name__ == "__main__":
    main()
