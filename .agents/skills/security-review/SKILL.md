---
name: security-review
description: Security checklist for TS Inspector, a page and command that parse untrusted transport-stream files. Use when you change code that reads stream bytes, renders stream text into HTML, handles imported JSON reports, runs the WebAssembly tools, or touches the build or CI.
license: MIT
metadata:
  origin: adapted from ECC skills/security-review
---

# Security review

The threat: a crafted `.ts` file, or a crafted exported JSON report, opened in the page or passed to the command. There is no server, no account, and no secret. The risks are script injection into the page, a hang, a crash, and memory blow-up.

## 1. Bounds

- Check every offset and length against the buffer before reading. Section length, descriptor length, adaptation field length, PES header length, and NAL size all come from the attacker.
- A length that runs past the packet or section is an error row. Stop parsing that unit, keep parsing the stream.
- Loops over descriptors, NAL units, or sections must advance by at least one byte each time.

## 2. HTML output (XSS)

- Service names, provider names, EPG text, teletext, and subtitles are attacker text. Render them with `textContent`, or escape `& < > " '` before they go into markup.
- Never pass stream text to `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or a URL.
- `reportHtml` in `src/ui/export.js` builds the HTML report as a string. Every interpolated value goes through its `esc` helper. `src/ui/app.js` has its own `esc` for the page.
- An imported JSON report (`openReport` in `src/report.js`) is untrusted the same way.

## 3. Resources

- No allocation sized by a stream field without a cap. A 32-bit length can ask for 4 GB.
- Per-PID and per-section tables need a limit. A stream can declare 8191 PIDs and thousands of programs.
- Large files are read in slices. Do not load a whole capture into the WebAssembly heap.

## 4. No network

- The page makes no requests. No `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, external `<script>`, `<link>`, `<img>`, or font URL.
- Blob and data URLs only. `build.py` and `test/ui.test.js` check authored code for `http://` and `https://`.

## 5. WebAssembly tools

- Tools run in their own worker with their own memory. Pass bytes in, read files out. No shared memory with the page.
- Treat tool output (SRT, field lists) as untrusted text, as in section 2.

## 6. Build and CI

- No new npm or PyPI dependency without an ADR.
- Workflows use pinned major versions of official actions and the least `permissions` they need.
- No secrets in the repository. No employer names, internal hosts, or IP addresses.

## Test it

For each finding, add a fixture in `scripts/make_fixtures.py` that triggers it and a test that shows the error row instead of a throw. A string with `<script>` and `"><img src=x onerror=...>` in a service name is a good XSS fixture.
