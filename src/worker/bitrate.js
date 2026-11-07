// Equal-packet bitrate bins scaled by the PCR-derived mux rate.
// `bitrateDataset` is the batch form. `createBitrate` fills the same edges
// one packet at a time once the packet count is known (the file size).

const PID_NAMES = {
  0: "PAT", 1: "CAT", 16: "NIT", 17: "SDT/BAT", 18: "EIT", 20: "TOT/TDT", 8191: "NULL",
};

export function muxBitrate(pcrs) {
  if (!pcrs || pcrs.length < 2) return null;
  const a = pcrs[0];
  const b = pcrs[pcrs.length - 1];
  const dp = b.pcr - a.pcr;
  if (!(dp > 0) || b.index <= a.index) return null;
  return (b.index - a.index) * 188 * 8 * 27_000_000 / dp;
}

function mean(values) {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return values.length ? s / values.length : 0;
}

function pstdev(values) {
  const m = mean(values);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m;
    s += d * d;
  }
  return values.length ? Math.sqrt(s / values.length) : 0;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function binOf(index, per, steps) {
  let s = Math.min(steps - 1, Math.max(0, Math.floor(index / per)));
  while (s < steps - 1 && index >= Math.floor((s + 1) * per)) s += 1;
  while (s > 0 && index < Math.floor(s * per)) s -= 1;
  return s;
}

function seriesFrom(totals, rows, steps, per, rate) {
  const order = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a) || a - b);
  const out = [];
  for (const pid of order) {
    const counts = rows.get(pid);
    const v = [];
    for (let s = 0; s < steps; s++) {
      const a = Math.floor(s * per);
      const b = Math.floor((s + 1) * per);
      const width = b - a || 1;
      v.push(round4(((counts ? counts[s] : 0) / width) * rate / 1e6));
    }
    const mbps = v.map((x) => x * 1e6);
    const m = mean(mbps);
    const sd = pstdev(mbps);
    const name = PID_NAMES[pid];
    out.push({
      pid,
      label: name ? pid + " " + name : String(pid),
      pkts: totals.get(pid),
      mean: round4(m / 1e6),
      sd: round4(sd / 1e6),
      min: v.reduce((x, y) => Math.min(x, y), v[0] || 0),
      max: v.reduce((x, y) => Math.max(x, y), v[0] || 0),
      v,
    });
  }
  return out;
}

export function bitrateDataset(pids, pcrs, steps) {
  const n = pids.length;
  const rate = muxBitrate(pcrs) || 1;
  const stepN = Math.min(steps, Math.max(1, Math.floor(n / 8) || 1));
  const per = n / stepN;
  const totals = new Map();
  const rows = new Map();
  for (let i = 0; i < n; i++) {
    const pid = pids[i];
    if (pid < 0) continue;
    totals.set(pid, (totals.get(pid) || 0) + 1);
    let row = rows.get(pid);
    if (!row) {
      row = new Float64Array(stepN);
      rows.set(pid, row);
    }
    row[binOf(i, per, stepN)] += 1;
  }
  const dur = n * 188 * 8 / rate;
  return {
    mux: round4(rate / 1e6),
    dur: Math.round(dur * 100) / 100,
    pkts: n,
    steps: stepN,
    series: seriesFrom(totals, rows, stepN, per, rate),
  };
}

export function createBitrate(expectedPackets, steps = 1200) {
  const n = Math.max(0, expectedPackets | 0);
  const stepN = n ? Math.min(steps, Math.max(1, Math.floor(n / 8) || 1)) : 1;
  const per = n ? n / stepN : 1;
  const totals = new Map();
  const rows = new Map();
  return {
    add(index, pid) {
      if (!n || pid < 0) return;
      totals.set(pid, (totals.get(pid) || 0) + 1);
      let row = rows.get(pid);
      if (!row) {
        row = new Float64Array(stepN);
        rows.set(pid, row);
      }
      row[binOf(index, per, stepN)] += 1;
    },
    finish(rate) {
      const use = rate && rate > 0 ? rate : 1;
      const dur = n * 188 * 8 / use;
      return {
        mux: round4(use / 1e6),
        dur: Math.round(dur * 100) / 100,
        pkts: n,
        steps: stepN,
        series: seriesFrom(totals, rows, stepN, per, use),
      };
    },
  };
}
