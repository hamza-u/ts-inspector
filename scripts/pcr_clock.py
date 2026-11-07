"""Media-time clock for a raw transport stream. Twin of src/worker/clock.js.

See aidlc-docs/construction/ts-inspector-web/requirements.md. Both copies
must emit the same microsecond-quantized timestamps.
"""

from __future__ import annotations

PCR_MOD = (1 << 33) * 300
NOMINAL_BPS = 10_000_000
MAX_BUFFER = 8000


def _nominal():
    return (188 * 8) / NOMINAL_BPS


def _quantize(abs_sec, origin_us):
    us = int(abs_sec * 1_000_000.0 + 0.5)
    if origin_us is None:
        origin_us = us
    return origin_us, (us - origin_us) / 1_000_000.0


class PcrClock:
    def __init__(self, max_buffer=MAX_BUFFER):
        self.max_buffer = max_buffer
        self.buf = []
        self.origin_us = None
        self.rate = None
        self.anchor_index = None
        self.anchor_sec = None
        self.unwrapped = None
        self.rebase_uw = None
        self.rebase_sec = None
        self.nominal_locked = False

    def _sec(self, raw):
        mod = PCR_MOD
        if self.unwrapped is None:
            self.unwrapped = raw
        else:
            last = self.unwrapped % mod
            d = raw - last
            if d < -mod / 2:
                d += mod
            elif d > mod / 2:
                d -= mod
            self.unwrapped += d
        if self.rebase_uw is None:
            return self.unwrapped / 27_000_000.0
        return self.rebase_sec + (self.unwrapped - self.rebase_uw) / 27_000_000.0

    def _emit(self, index, abs_sec):
        self.origin_us, now = _quantize(abs_sec, self.origin_us)
        return [index, now]

    def push(self, index, pcr):
        if self.nominal_locked:
            return [self._emit(index, index * _nominal())]
        self.buf.append((index, pcr))
        if pcr is None:
            if len(self.buf) > self.max_buffer:
                return self._flush_open()
            return []
        sec = self._sec(pcr)
        if self.anchor_sec is None:
            self.anchor_index = index
            self.anchor_sec = sec
            return []
        prev_i = self.anchor_index
        prev_s = self.anchor_sec
        new_rate = None
        if index != prev_i:
            new_rate = (sec - prev_s) / (index - prev_i)
        if new_rate is None or new_rate <= 0:
            return self._discontinuity(index, sec)
        self.rate = new_rate
        out = self._emit_span(prev_i, prev_s, index, sec)
        self.anchor_index = index
        self.anchor_sec = sec
        return out

    def _emit_span(self, i0, t0, i1, t1):
        rate = (t1 - t0) / (i1 - i0) if i1 != i0 else (self.rate or _nominal())
        out = []
        keep = []
        for index, pcr in self.buf:
            if index > i1:
                keep.append((index, pcr))
                continue
            if index <= i0:
                abs_t = t0 - (i0 - index) * rate
            else:
                abs_t = t0 + (index - i0) * rate
            out.append(self._emit(index, abs_t))
        self.buf = keep
        return out

    def _discontinuity(self, index, sec):
        use = self.rate if self.rate and self.rate > 0 else _nominal()
        prev_i = self.anchor_index
        prev_s = self.anchor_sec
        out = []
        for i, _pcr in self.buf:
            abs_t = prev_s + (i - prev_i) * use
            out.append(self._emit(i, abs_t))
            if i == index:
                self.anchor_index = i
                self.anchor_sec = abs_t
        self.buf = []
        self.rate = use
        self.rebase_uw = self.unwrapped
        self.rebase_sec = self.anchor_sec
        return out

    def _flush_open(self):
        if self.rate is None or self.anchor_sec is None:
            self.nominal_locked = True
            out = []
            for index, _pcr in self.buf:
                out.append(self._emit(index, index * _nominal()))
            self.buf = []
            return out
        rate = self.rate
        base_i = self.anchor_index
        base_t = self.anchor_sec
        out = []
        last_abs = None
        last_i = None
        for index, _pcr in self.buf:
            abs_t = base_t + (index - base_i) * rate
            out.append(self._emit(index, abs_t))
            last_abs = abs_t
            last_i = index
        if last_i is not None:
            self.anchor_index = last_i
            self.anchor_sec = last_abs
        self.buf = []
        return out

    def finish(self):
        if self.nominal_locked:
            out = []
            for index, _pcr in self.buf:
                out.append(self._emit(index, index * _nominal()))
            self.buf = []
            return out
        return self._flush_open()


def timestamps(pcrs, indexes):
    """pcrs is a list of raw PCR or None, one per packet, for packets 0..n-1
    when indexes is None. Otherwise pcrs aligns with indexes."""
    clock = PcrClock()
    out = []
    if indexes is None:
        for i, pcr in enumerate(pcrs):
            out.extend(clock.push(i, pcr))
    else:
        have = set()
        n = max(indexes) + 1 if indexes else 0
        by = dict(zip(indexes, pcrs))
        for i in range(n):
            out.extend(clock.push(i, by.get(i)))
    out.extend(clock.finish())
    return out
