---
name: tdd-workflow
description: Test-first workflow for TS Inspector. Write a fixture and a failing node:test, watch it fail, make the smallest change to pass, then refactor. Use when adding a check, a parser, a panel, a command option, or when fixing a bug.
license: MIT
metadata:
  origin: adapted from ECC skills/tdd-workflow
---

# TDD workflow

## Cycle

1. **Name the behaviour.** One sentence: "A PMT with a CRC error raises a priority 1 CRC error on its PID."
2. **Make the input.** Add a generator to `scripts/make_fixtures.py` that writes the smallest `.ts` that shows the behaviour. Run `python3 scripts/make_fixtures.py`. Never commit a private capture.
3. **Write the test.** Add it to the suite that owns the area: `test/core.test.js`, `test/analyse.test.js`, `test/timeline.test.js`, `test/cli.test.js`, and so on. For a new fixture, add `test/golden/<name>.json` with the expected counts.
4. **Run it and see it fail** for the right reason:

   ```sh
   node --test --test-name-pattern "CRC error" test
   ```

   A test that passes before the change proves nothing. Fix the test.
5. **Make it pass** with the smallest change in `src/`.
6. **Refactor**, then run the whole suite: `node --test test`.
7. **Record the evidence** in your report: the failing line from step 4 and the pass count from step 6.

## Rules

- A bug fix starts with a test that reproduces the bug.
- Test behaviour through the public function (`inspect`, `analyse`, the command), not private helpers.
- Golden files change only when the expected behaviour changes. Say why in the commit body.
- Tests that need `vendor/` use `{ skip: !HAVE }`. CI has no `vendor/`.
- Keep each test under about a second. `test/perf.test.js` is the only throughput test.
- Malformed input gets its own test: truncated packet, bad section length, wrong sync byte. The result is an error row, not an exception.
