---
name: verification-loop
description: Verify work in TS Inspector before calling it done. Build both pages, run the tests, check the page has no network calls, scan the diff, and report PASS or FAIL with evidence. Use after a feature, fix, or refactor, and before a commit or pull request.
license: MIT
metadata:
  origin: adapted from ECC skills/verification-loop
---

# Verification loop

Run every phase. Stop at the first FAIL, fix it, and start again.

## Phase 1: Build

```sh
python3 build.py --no-gpl --out /tmp/ts-inspector-bare.html
python3 build.py --out /tmp/ts-inspector-full.html   # embeds what is in vendor/
```

Both must print `wrote ...`. `build.py` already runs `node --check` on the generated scripts and rejects network URLs in authored code.

## Phase 2: Syntax

```sh
for f in src/worker/*.js src/ui/*.js src/report.js bin/*.js; do node --check "$f" || echo "FAIL $f"; done
python3 -m py_compile build.py scripts/*.py
```

## Phase 3: Tests

```sh
node --test test 2>&1 | tail -8
```

Quote the `tests`, `pass`, `fail`, and `skipped` lines. Skips are expected only when `vendor/` is absent.

## Phase 4: Page checks

```sh
head -c 2000 /tmp/ts-inspector-bare.html | grep -q "MIT License" || echo "FAIL licence header"
grep -c "General Public License" /tmp/ts-inspector-bare.html   # must be 0
ls -l /tmp/ts-inspector-bare.html                              # about 300 kB
```

## Phase 5: Diff scan

```sh
git diff --stat
git diff | grep -nE "console\.log|debugger|TODO|FIXME|http://|https://" | grep "^[0-9]*:+"
```

Also check the diff for:

- Names of employers, customers, internal hosts, IP addresses, or private file paths.
- Text copied from ISO, ETSI, or SCTE documents.
- Code copied from a GPL project into `src/`.
- `dist/` or `vendor/src/` staged by mistake.

## Report

```
VERIFICATION: PASS | FAIL
Build:  bare <size>, full <size>
Tests:  <pass>/<tests>, <skipped> skipped
Page:   licence header ok, no GPL text in bare page
Diff:   <files> files, issues: <none | list>
```

Never report PASS for a phase you did not run. Say "not run" and why.
