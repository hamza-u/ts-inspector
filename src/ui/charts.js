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

// Pointer and arrow keys move a crosshair. The tooltip shows the time and the
// nearest value of each series. Bound once per canvas; redraws use the last opts.
function bindHover(canvas) {
  if (canvas._linesBound || !canvas.addEventListener) return;
  canvas._linesBound = true;
  if (canvas.setAttribute) canvas.setAttribute("tabindex", "0");
  const redraw = () => drawLines(canvas, canvas._lines);
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    canvas._hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    redraw();
  });
  canvas.addEventListener("pointerleave", () => {
    canvas._hover = null;
    redraw();
  });
  canvas.addEventListener("blur", () => {
    canvas._hover = null;
    redraw();
  });
  canvas.addEventListener("keydown", (e) => {
    const g = canvas._linesGeom;
    if (!g) return;
    if (e.key === "Escape") canvas._hover = null;
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const step = g.pw / 100;
      const x = canvas._hover ? canvas._hover.x : g.ml;
      const nx = x + (e.key === "ArrowRight" ? step : -step);
      canvas._hover = { x: Math.max(g.ml, Math.min(g.ml + g.pw, nx)), y: null };
      e.preventDefault();
    } else return;
    redraw();
  });
}

function nearest(pts, x) {
  let best = null;
  let bd = Infinity;
  for (const p of pts) {
    const d = Math.abs(p[0] - x);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

export function drawLines(canvas, opts) {
  if (!canvas) return;
  canvas._lines = opts;
  bindHover(canvas);
  const { ctx, w, h } = fit(canvas);
  ctx.font = "11px ui-sans-serif, sans-serif";
  const ml = 56;
  const mr = 12;
  const mb = 26;
  const series = opts.series || [];
  const named = series.filter((s) => s.name);
  // Legend goes right of the title, or on its own row when there is no room.
  const legW = named.length > 1
    ? named.reduce((n, s) => n + 18 + ctx.measureText(s.name).width + 12, 0)
    : 0;
  const titleW = opts.title ? ctx.measureText(opts.title).width : 0;
  const legRow = legW && ml + titleW + 16 + legW > w - mr ? 1 : 0;
  const mt = 16 + legRow * 14;
  const pw = w - ml - mr;
  const ph = h - mt - mb;
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
    canvas._linesGeom = null;
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
  canvas._linesGeom = { ml, pw };
  const xOf = (x) => ml + pw * ((x - xmin) / (xmax - xmin));
  const yOf = (y) => mt + ph * (1 - (y - ymin) / (ymax - ymin));
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = css("--grid");
  ctx.fillStyle = css("--ink2");
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
  if (legW) {
    let lx = w - mr - legW;
    const ly = 12 + legRow * 14;
    ctx.textAlign = "left";
    for (const s of named) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly - 7, 12, 3);
      ctx.fillStyle = css("--ink");
      ctx.fillText(s.name, lx + 18, ly);
      lx += 18 + ctx.measureText(s.name).width + 12;
    }
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
  const hv = canvas._hover;
  if (!hv || hv.x < ml || hv.x > ml + pw) return;
  const tx = xmin + (hv.x - ml) / pw * (xmax - xmin);
  const unit = opts.unit ? " " + opts.unit : "";
  ctx.strokeStyle = css("--ink2");
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(hv.x, mt);
  ctx.lineTo(hv.x, mt + ph);
  ctx.stroke();
  const inY = hv.y !== null && hv.y >= mt && hv.y <= mt + ph;
  if (inY) {
    ctx.beginPath();
    ctx.moveTo(ml, hv.y);
    ctx.lineTo(w - mr, hv.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const lines = [{ text: "t " + tx.toFixed(3) + " s", color: null }];
  if (inY) {
    const cy = ymin + (1 - (hv.y - mt) / ph) * (ymax - ymin);
    lines.push({ text: "cursor: " + cy.toFixed(1) + unit, color: null });
  }
  series.forEach((s, i) => {
    const p = nearest(s.pts, tx);
    if (!p) return;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(xOf(p[0]), yOf(p[1]), 3, 0, 2 * Math.PI);
    ctx.fill();
    lines.push({ text: (s.name || "series " + (i + 1)) + ": " + p[1].toFixed(1) + unit, color: s.color });
  });
  const bw = 16 + Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 12;
  const bh = 8 + lines.length * 15;
  let bx = hv.x + 12;
  if (bx + bw > w - mr) bx = hv.x - 12 - bw;
  if (bx < 0) bx = 0;
  const by = mt + 4;
  ctx.fillStyle = css("--panel");
  ctx.strokeStyle = css("--edge");
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.textAlign = "left";
  lines.forEach((l, i) => {
    const y = by + 15 + i * 15;
    if (l.color) {
      ctx.fillStyle = l.color;
      ctx.fillRect(bx + 6, y - 7, 8, 3);
    }
    ctx.fillStyle = css("--ink");
    ctx.fillText(l.text, bx + (l.color ? 18 : 6), y);
  });
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
