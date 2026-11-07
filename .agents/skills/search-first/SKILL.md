---
name: search-first
description: Look for an existing, licence-compatible implementation or a reference before writing a new parser, decoder, or tool for TS Inspector. Use when a task needs a codec parser, a table decoder, a character set, a subtitle format, or a new build tool.
license: MIT
metadata:
  origin: adapted from ECC skills/search-first
---

# Search first

## Steps

1. **Is it already here?** Search `src/worker/` and `src/ui/` for the table, descriptor, or format. Reuse `bits.js`, `tsutil.js`, `crc.js`, and `dvbtext.js` before writing new helpers.
2. **Is there a reference?** Find the clause in the specification (H.222.0, H.264, EN 300 468, EN 300 743, EN 300 706, ETSI TR 101 290, SCTE 35). Cite it in a comment. Do not copy its text.
3. **Is there a library?** Look on npm, GitHub, and in the projects already used here (FFmpeg, CCExtractor, telxcc, libklscte35).
4. **Check the licence.**

   | Licence | Can go into `src/` | Can run from `vendor/` |
   |---|---|---|
   | MIT, BSD, ISC, zlib | Yes, with its notice | Yes |
   | Apache-2.0 | No (breaks the GPL-2.0 full page) | No |
   | LGPL-2.1, GPL-2.0, GPL-2.0-or-later | No | Yes, with a NOTICE |
   | GPL-3.0-only, AGPL | No | No (not compatible with CCExtractor) |

5. **Decide.**

   | Finding | Action |
   |---|---|
   | Exact match, compatible licence, small | Adopt. Inline it with its notice, or vendor it. |
   | Partial match | Write our own, and test against the library's output. |
   | GPL program that does the job | Compile it to WebAssembly in `vendor/`. Write an ADR. |
   | Nothing suitable | Write our own, test first. |

6. Any new dependency or vendored program needs an ADR (see `architecture-decision-records`).

## Rules

- The page must still work offline from one file. A library that needs a fetch, a CDN, or a server does not fit.
- No npm runtime dependencies. Inline small code; compile large C code to WebAssembly.
- A second implementation is useful as a cross-check, as libklscte35 is for SCTE-35.
