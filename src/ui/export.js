// CSV of the bitrate bins the chart is showing, and a JSON download helper
// that drops nothing the report already capped.

import { wrapReport } from "../report.js";

export function bitrateCsv(bitrate, x0 = 0, x1 = bitrate ? bitrate.steps : 0) {
  if (!bitrate || !bitrate.series) return "";
  const from = Math.max(0, x0 | 0);
  const to = Math.min(bitrate.steps, x1 | 0);
  const header = ["bin", "t_s", ...bitrate.series.map((s) => s.label)];
  const lines = [header.join(",")];
  for (let b = from; b < to; b++) {
    const t = bitrate.dur && bitrate.steps ? (bitrate.dur * b / bitrate.steps) : b;
    const cells = [b, t.toFixed(3)];
    for (const series of bitrate.series) cells.push(series.v[b]);
    lines.push(cells.join(","));
  }
  return lines.join("\n") + "\n";
}

export function reportJson(report, file) {
  return JSON.stringify(wrapReport(report, file), null, 2);
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function reportHtml(report) {
  const c = report.compliance || { rows: [], pass: 0, fail: 0, na: 0 };
  const lines = (c.rows || []).map((r) =>
    "<tr class=\"" + esc(r.state) + "\"><td>" + esc(r.group) + "</td><td>" + esc(r.name)
    + "</td><td>" + esc(r.state) + "</td><td>" + r.count + "</td><td>"
    + (r.packetIndex >= 0 ? r.packetIndex : "") + "</td><td>" + esc(r.clause)
    + "</td><td>" + esc(r.detail) + "</td></tr>").join("");
  const hrd = report.hrd && report.hrd.modelled
    ? "<p>HRD joins: " + (report.hrd.joins || []).length
      + ". Plan underflow " + report.hrd.counts.underflowPlan
      + ", overflow " + report.hrd.counts.overflowPlan + ".</p>"
    : "<p>No H.264 HRD model for this file.</p>";
  const audio = (report.audio || []).filter((wave) => wave && wave.loudness && wave.loudness.measured);
  const loudness = audio.length
    ? "<h2>Audio loudness (EBU R 128)</h2><table><thead><tr><th>PID</th><th>Integrated</th><th>LRA</th>"
      + "<th>True peak</th><th>Blocks</th></tr></thead><tbody>"
      + audio.map((wave) => {
        const l = wave.loudness;
        return "<tr><td>" + wave.pid + "</td><td>" + (l.integrated === null ? "" : l.integrated.toFixed(1) + " LUFS")
          + "</td><td>" + (l.lra === null ? "" : l.lra.toFixed(1) + " LU")
          + "</td><td>" + (l.truePeakDb === null ? "" : l.truePeakDb.toFixed(1) + " dBFS")
          + "</td><td>" + (l.blocks || 0) + "</td></tr>";
      }).join("")
      + "</tbody></table>"
    : "";
  const captions = (report.captions && report.captions.cues) || [];
  const teletext = (report.teletextSrt || []).filter((row) => row.cues && row.cues.length);
  const scteDiffs = (report.scteCheck || []).filter((row) => row.diff && row.diff.length);
  const tools = (captions.length || teletext.length || (report.scteCheck || []).length)
    ? "<h2>Captions and SCTE-35 cross-check</h2>"
      + (captions.length
        ? "<h3>CEA-608 / 708</h3><table><thead><tr><th>Start</th><th>End</th><th>Text</th></tr></thead><tbody>"
          + captions.slice(0, 200).map((cue) => "<tr><td>" + cue.t0.toFixed(2) + " s</td><td>"
            + cue.t1.toFixed(2) + " s</td><td>" + esc(cue.text) + "</td></tr>").join("")
          + "</tbody></table>"
        : "")
      + teletext.map((row) => "<h3>Teletext page " + row.page + " (PID " + row.pid + ")</h3><table><tbody>"
        + row.cues.slice(0, 200).map((cue) => "<tr><td>" + cue.t0.toFixed(2) + " s</td><td>"
          + cue.t1.toFixed(2) + " s</td><td>" + esc(cue.text) + "</td></tr>").join("")
        + "</tbody></table>").join("")
      + (report.scteCheck
        ? "<p>SCTE-35 sections parsed twice: " + report.scteCheck.length + " compared, "
          + scteDiffs.length + " with a differing field.</p>"
        : "")
    : "";
  return "<!doctype html><html><head><meta charset=\"utf-8\"><title>TS Inspector report</title><style>"
    + "body{font:14px/1.4 ui-sans-serif,sans-serif;margin:24px;color:#1c2733}"
    + "table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e4e8ec;padding:4px 8px;text-align:left}"
    + "tr.fail{background:#fde8ec}tr.na{color:#5c6b78}</style></head><body>"
    + "<h1>TS Inspector</h1><p>" + esc(report.fileName || "stream") + "</p>"
    + "<p>" + c.pass + " pass, " + c.fail + " fail, " + c.na + " not measured. "
    + "Not a conformance certificate.</p>"
    + hrd
    + loudness
    + tools
    + "<table><thead><tr><th>Group</th><th>Check</th><th></th><th>Count</th><th>Packet</th><th>Clause</th><th>Detail</th></tr></thead><tbody>"
    + lines + "</tbody></table></body></html>\n";
}
