---
name: benchmark
description: Measure TS Inspector throughput, page weight, and load time before and after a change, and flag regressions. Use when you change a per-packet or per-section path, add a model or check that runs on every packet, or change what the build embeds.
license: MIT
metadata:
  origin: adapted from ECC skills/benchmark
---

# Benchmark

Measure before the change and after it, on the same machine, with the same input.

## 1. Analysis throughput

```sh
node --test test/perf.test.js
```

For a real number, time the command on a large capture three times and take the median:

```sh
for i in 1 2 3; do /usr/bin/time -p node bin/ts-inspector.js big.ts > /dev/null; done 2>&1 | grep real
```

Report MB/s (file size divided by the median). A drop of more than 10 % is a regression. Explain it or fix it.

## 2. Page weight

```sh
python3 build.py --no-gpl --out /tmp/bare.html && wc -c /tmp/bare.html
python3 build.py --out /tmp/full.html && wc -c /tmp/full.html
gzip -c /tmp/bare.html | wc -c
```

The bare page is about 300 kB. Report any growth over 10 kB with its cause.

## 3. Page load

Open the bare page in a browser, drop a fixture, and record the time to the first summary figures. Use the browser's performance panel or `performance.now()` marks in the console. Do not add timing code to the committed page.

## Rules

- Never commit a large capture. Use a local file and name only its size and duration in the report.
- Report numbers as a before/after table: metric, before, after, change.
