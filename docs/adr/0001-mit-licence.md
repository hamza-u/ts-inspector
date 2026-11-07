# ADR-0001: MIT for our sources, GPL-2.0 for the full page

- Date: 2026-11-07
- Status: accepted

## Context

The full page embeds four programs compiled to WebAssembly: FFmpeg
(GPL-2.0-or-later, built with `--enable-gpl`), CCExtractor, telxcc
(GPL-2.0-or-later), and libklscte35 (LGPL-2.1-or-later). CCExtractor is
GPL-2.0-only: `ccextractor.c`, `ccx_gxf.c`, and `dvb_subtitle_decoder.c` say
"GPL 2.0" with no "or later", and its README says GPL-2.0. All of these ship
in one HTML file, so the full page must be distributable under one licence
that every part accepts.

## Decision

Our sources are under the MIT License. A full page is distributed under
GPL-2.0 as a whole. The page built with `--no-gpl` contains none of those
programs and is MIT only. GitHub Pages publishes that build.

## Alternatives

### Apache-2.0
- For: explicit patent grant.
- Against: the FSF holds Apache-2.0 incompatible with GPL-2.0.
- Rejected because: the full page could not be distributed lawfully while it
  contains GPL-2.0-only CCExtractor.

### GPL-2.0-or-later for our sources
- For: one licence everywhere.
- Against: the inspector alone could no longer go into proprietary products.
- Rejected because: copyleft is only needed for the bundle, not for our code.

### Treat the bundle as mere aggregation
- For: each part could keep its own licence, Apache-2.0 included.
- Against: the programs ship inside one file and the page calls them
  directly. That reading is arguable and a reviewer could reject it.
- Rejected because: MIT avoids the question.

## Consequences

- Easier: anyone can reuse the inspector code, commercially or in a GPL
  project.
- Harder: whoever hosts a full page must offer the corresponding source from
  the same place, and every new vendored program must be GPL-2.0 compatible.
  GPL-3.0-only and Apache-2.0 programs cannot be added.
- Risks: a future CCExtractor or FFmpeg build could change licence. Check the
  licence on every pin bump in `scripts/build_wasm.py` and
  `scripts/fetch_ffmpeg.py`.
