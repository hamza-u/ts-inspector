// Canvas charts for the bitrate stack, PCR interval and PTS-PCR.
// No framework and no network.

export const PALETTE = [
  "#d6249f", "#fd5949", "#f77737", "#fcaf45", "#833ab4",
  "#c13584", "#e1306c", "#5851db", "#f56040", "#405de6",
];

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fit(canvas) {
  const r = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 280;
  canvas.width = Math.max(1, Math.floor(w * r));
  canvas.height = Math.max(1, Math.floor(h * r));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return { ctx, w, h };
}

export function drawStacked(canvas, bitrate, view) {
  if (!canvas || !bitrate || !bitrate.steps) return;
  const { ctx, w, h } = fit(canvas);
  const ml = 56;
  const mr = 12;
  const mt = 12;
  const mb = 26;
  const pw = w - ml - mr;
  const ph = h - mt - mb;
  const x0 = view.x0 || 0;
  const x1 = view.x1 || bitrate.steps;
  const span = Math.max(1, x1 - x0);
  const hidden = view.hidden || new Set();
  const shown = bitrate.series.filter((s) => !hidden.has(s.pid));
  let ymax = 0;
  for (let b = 0; b < span; b++) {
    let sum = 0;
    for (const s of shown) sum += s.v[x0 + b] || 0;
    if (sum > ymax) ymax = sum;
  }
  ymax = Math.max(ymax * 1.05, 0.001);
  const yOf = (v) => mt + ph * (1 - Math.min(v, ymax) / ymax);
  const xOf = (b) => ml + pw * (b / Math.max(1, span - 1));
  ctx.clearRect(0, 0, w, h);
  ctx.font = "11px ui-sans-serif, sans-serif";
  ctx.fillStyle = css("--ink2");
  ctx.strokeStyle = css("--grid");
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = ymax * k / 4;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(ml, y);
    ctx.lineTo(w - mr, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(v.toFixed(2), ml - 6, y + 4);
  }
  const low = new Float64Array(span);
  for (let si = 0; si < bitrate.series.length; si++) {
    const s = bitrate.series[si];
    if (hidden.has(s.pid)) continue;
    const hi = new Float64Array(span);
    for (let b = 0; b < span; b++) hi[b] = low[b] + (s.v[x0 + b] || 0);
    ctx.beginPath();
    for (let b = 0; b < span; b++) {
      const x = xOf(b);
      if (b) ctx.lineTo(x, yOf(hi[b]));
      else ctx.moveTo(x, yOf(hi[b]));
    }
    for (let b = span - 1; b >= 0; b--) ctx.lineTo(xOf(b), yOf(low[b]));
    ctx.closePath();
    ctx.fillStyle = PALETTE[si % PALETTE.length];
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    low.set(hi);
  }
  ctx.fillStyle = css("--ink2");
  ctx.textAlign = "center";
  for (let k = 0; k <= 4; k++) {
    const b = x0 + span * k / 4;
    const t = bitrate.dur * b / bitrate.steps;
    ctx.fillText(t.toFixed(1) + "s", xOf(span * k / 4), h - 8);
  }
  if (view.hover !== null && view.hover !== undefined) {
    const b = view.hover - x0;
    if (b >= 0 && b < span) {
      ctx.strokeStyle = css("--ink");
      ctx.beginPath();
      ctx.moveTo(xOf(b), mt);
      ctx.lineTo(xOf(b), mt + ph);
      ctx.stroke();
    }
  }
}

export function hoverBin(canvas, bitrate, view, event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const ml = 56;
  const mr = 12;
  const pw = rect.width - ml - mr;
  const x0 = view.x0 || 0;
  const x1 = view.x1 || bitrate.steps;
  const span = Math.max(1, x1 - x0);
  if (x < ml || x > rect.width - mr) return null;
  const b = Math.round(x0 + ((x - ml) / pw) * (span - 1));
  return Math.max(x0, Math.min(x1 - 1, b));
}

export function drawLines(canvas, opts) {
  if (!canvas) return;
  const { ctx, w, h } = fit(canvas);
  const ml = 56;
  const mr = 12;
  const mt = 16;
  const mb = 26;
  const pw = w - ml - mr;
  const ph = h - mt - mb;
  const series = opts.series || [];
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const s of series) {
    for (const p of s.pts) {
      if (p[0] < xmin) xmin = p[0];
      if (p[0] > xmax) xmax = p[0];
      if (p[1] < ymin) ymin = p[1];
      if (p[1] > ymax) ymax = p[1];
    }
  }
  for (const lim of opts.limits || []) {
    if (lim.y < ymin) ymin = lim.y;
    if (lim.y > ymax) ymax = lim.y;
  }
  if (!Number.isFinite(xmin)) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = css("--ink2");
    ctx.font = "13px ui-sans-serif, sans-serif";
    ctx.fillText(opts.empty || "No samples", ml, mt + 20);
    return;
  }
  if (xmax === xmin) xmax = xmin + 1;
  const pad = (ymax - ymin) * 0.08 || 1;
  ymin -= pad;
  ymax += pad;
  const xOf = (x) => ml + pw * ((x - xmin) / (xmax - xmin));
  const yOf = (y) => mt + ph * (1 - (y - ymin) / (ymax - ymin));
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = css("--grid");
  ctx.fillStyle = css("--ink2");
  ctx.font = "11px ui-sans-serif, sans-serif";
  ctx.textAlign = "right";
  for (let k = 0; k <= 4; k++) {
    const v = ymin + (ymax - ymin) * k / 4;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(ml, y);
    ctx.lineTo(w - mr, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(1), ml - 6, y + 4);
  }
  ctx.textAlign = "center";
  for (let k = 0; k <= 4; k++) {
    const x = xmin + (xmax - xmin) * k / 4;
    ctx.fillText(x.toFixed(2) + "s", xOf(x), h - 8);
  }
  if (opts.title) {
    ctx.textAlign = "left";
    ctx.fillStyle = css("--ink");
    ctx.fillText(opts.title, ml, 12);
  }
  for (const lim of opts.limits || []) {
    const y = yOf(lim.y);
    ctx.strokeStyle = lim.color || "#fd5949";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(ml, y);
    ctx.lineTo(w - mr, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (lim.label) {
      ctx.fillStyle = lim.color || "#fd5949";
      ctx.textAlign = "left";
      ctx.fillText(lim.label, ml + 4, y - 3);
    }
  }
  for (const s of series) {
    if (!s.pts.length) continue;
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.4;
    s.pts.forEach((p, i) => {
      const x = xOf(p[0]);
      const y = yOf(p[1]);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
}

const FRAME_COLOR = { I: "#e1306c", P: "#833ab4", B: "#f77737", "?": "#a49bb3" };

export function drawBars(canvas, opts) {
  if (!canvas) return;
  const { ctx, w, h } = fit(canvas);
  const bars = opts.bars || [];
  const ml = 56;
  const mr = 12;
  const mt = 16;
  const mb = 26;
  if (!bars.length) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = css("--ink2");
    ctx.font = "13px ui-sans-serif, sans-serif";
    ctx.fillText(opts.empty || "No samples", ml, mt + 20);
    return;
  }
  let ymax = 0;
  for (const b of bars) if (b.v > ymax) ymax = b.v;
  ymax = Math.max(ymax * 1.05, 1);
  const pw = w - ml - mr;
  const ph = h - mt - mb;
  const yOf = (v) => mt + ph * (1 - v / ymax);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = css("--grid");
  ctx.fillStyle = css("--ink2");
  ctx.font = "11px ui-sans-serif, sans-serif";
  ctx.textAlign = "right";
  for (let k = 0; k <= 4; k++) {
    const v = ymax * k / 4;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(ml, y);
    ctx.lineTo(w - mr, y);
    ctx.stroke();
    const text = opts.unit === "kB"
      ? v.toFixed(v >= 100 ? 0 : 1)
      : Math.round(v).toString();
    ctx.fillText(text, ml - 6, y + 4);
  }
  const bw = Math.max(1, pw / bars.length);
  bars.forEach((b, i) => {
    const x = ml + i * bw;
    ctx.fillStyle = b.color || FRAME_COLOR[b.frame] || FRAME_COLOR["?"];
    ctx.fillRect(x, yOf(b.v), Math.max(1, bw - 1), yOf(0) - yOf(b.v));
  });
  if (opts.title) {
    ctx.fillStyle = css("--ink");
    ctx.textAlign = "left";
    ctx.fillText(opts.title, ml, 12);
  }
}

export function drawHistogram(canvas, opts) {
  if (!canvas) return;
  const { ctx, w, h } = fit(canvas);
  const bins = opts.bins || [];
  const ml = 56;
  const mr = 12;
  const mt = 16;
  const mb = 26;
  ctx.clearRect(0, 0, w, h);
  if (!bins.length) {
    ctx.fillStyle = css("--ink2");
    ctx.font = "13px ui-sans-serif, sans-serif";
    ctx.fillText(opts.empty || "No samples", ml, mt + 20);
    return;
  }
  let ymax = 0;
  for (const b of bins) if (b.n > ymax) ymax = b.n;
  ymax = Math.max(ymax, 1);
  const pw = w - ml - mr;
  const ph = h - mt - mb;
  const bw = pw / bins.length;
  const yOf = (v) => mt + ph * (1 - v / ymax);
  ctx.strokeStyle = css("--grid");
  ctx.fillStyle = css("--ink2");
  ctx.font = "11px ui-sans-serif, sans-serif";
  bins.forEach((b, i) => {
    const x = ml + i * bw;
    ctx.fillStyle = Math.abs((b.lo + (opts.step || 200) / 2)) > 500 ? "#fd5949" : "#833ab4";
    ctx.fillRect(x, yOf(b.n), Math.max(1, bw - 1), yOf(0) - yOf(b.n));
  });
  if (opts.title) {
    ctx.fillStyle = css("--ink");
    ctx.textAlign = "left";
    ctx.fillText(opts.title, ml, 12);
  }
}

export function drawTimeline(canvas, events, duration) {
  if (!canvas) return;
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = css("--grid");
  ctx.fillRect(0, h / 2 - 3, w, 6);
  const span = duration || 1;
  for (const ev of events) {
    const x = Math.max(0, Math.min(w - 1, (ev.t / span) * w));
    ctx.fillStyle = ev.prio === 1 ? "#e1306c" : "#f77737";
    ctx.fillRect(x, 4, 2, h - 8);
  }
}
