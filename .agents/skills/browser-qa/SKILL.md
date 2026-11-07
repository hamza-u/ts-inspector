---
name: browser-qa
description: Check the built TS Inspector page in a real browser. Smoke test from file:// and over HTTP, drop fixtures, walk every tab, check the console and the network log, and give a SHIP or DO NOT SHIP verdict. Use after any change to src/ui, src/report.js, build.py, or the page styles.
license: MIT
metadata:
  origin: adapted from ECC skills/browser-qa
---

# Browser QA

Use whatever browser automation the agent has (Playwright, Puppeteer, a browser MCP). Without one, list the steps for a human and mark the result INCONCLUSIVE.

## Phase 1: Smoke

1. `python3 build.py --no-gpl`.
2. Open `dist/ts-inspector.html` from `file://`.
3. Serve it from a sub-path, as GitHub Pages does:

   ```sh
   mkdir -p /tmp/site/ts-inspector && cp dist/ts-inspector.html /tmp/site/ts-inspector/index.html
   python3 -m http.server -d /tmp/site 8000   # open http://localhost:8000/ts-inspector/
   ```

4. In both cases: the title is "TS Inspector", the console has no errors, and the network log has one request (the page) and nothing else.

## Phase 2: Interaction

1. Drop `test/fixtures/ok.ts`. Summary figures appear, and the check list has no errors.
2. Drop `test/fixtures/cc_gap.ts`. A continuity error shows. Clicking its row opens the hex view at that packet.
3. Open every tab. Each one renders without a console error.
4. Switch Light, Dark, and Auto. Reload. The choice is kept.
5. Export JSON, CSV, and report. Each file downloads and opens.
6. On a full build, check that the caption, teletext, and SCTE-35 cross-check views fill in. On a bare build, check that they say the tools are not in this build.

## Phase 3: Layout

Check at 375 px, 768 px, and 1440 px wide. No horizontal page scroll. Tables scroll inside their own box.

## Phase 4: Accessibility

Run the `accessibility` skill's checks on the tabs and the import control.

## Report

```
QA: <build> <file:// | http>
Smoke:        pass | fail (<detail>)
Interaction:  <n>/<n> pass
Layout:       pass | <issues>
Accessibility: pass | <issues>
Verdict: SHIP | SHIP WITH FIXES | DO NOT SHIP | INCONCLUSIVE
```

Only use fixtures from `test/fixtures/` or files the user gives you. Never upload a capture anywhere.
