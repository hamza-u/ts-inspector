// Page controller. The worker owns the parse; this file only renders and
// reads packet bytes back from the File the user dropped.

import { PALETTE, drawBars, drawHistogram, drawLines, drawStacked, drawTimeline, hoverBin } from "./charts.js";
import { createAudioDecoder } from "./ffmpeg-decode.js";
import { bitrateCsv, reportHtml, reportJson } from "./export.js";
import { decodePacket, hexRows, packetSummary } from "./hex.js";
import { allLaneKeys, cueMarkers, drawMediaTimeline, hitTimeline, onThumbnailLoad, panSpan, resetThumbnailCache, timeAtX, timelineHeight, zoomSpan } from "./media-timeline.js";
import { dbText, levelAt, lufsText } from "./audio-level.js";
import { compareScte, createTools } from "./tools.js";
import { openReport } from "../report.js";
import { applyTheme, nextTheme, readTheme } from "./theme.js";

function el(doc, id) { return doc.getElementById(id); }

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function mbps(n) {
  if (!n) return "0";
  return (n / 1e6).toFixed(3);
}

export function mount(doc, opts) {
  const fileInput = el(doc, "file");
  const drop = el(doc, "drop");
  const out = el(doc, "out");
  const progress = el(doc, "progress");
  const bar = el(doc, "bar");
  const plabel = el(doc, "plabel");
  const cancelBtn = el(doc, "cancel");
  const jsonBtn = el(doc, "json");
  const csvBtn = el(doc, "csv");
  const htmlBtn = el(doc, "html");
  let worker = null;
  let file = null;
  let report = null;
  let reportFile = null;
  let decoder = null;
  let tooler = null;
  const toolState = { captions: null, teletext: [], scte: null };
  const view = { x0: 0, x1: 0, hidden: new Set(), hover: null, drag: null };
  const timelineView = { t0: 0, t1: 1, hidden: new Set(), drag: null, hoverX: null, height: 0, manual: false };
  function chooseTheme(choice) {
    applyTheme(doc, choice);
    if (report) {
      drawCharts();
      drawTimelineBar();
    }
  }

  function setBusy(on) {
    progress.hidden = !on;
    cancelBtn.hidden = !on;
    fileInput.disabled = on;
  }

  function fail(message) {
    setBusy(false);
    plabel.textContent = message;
    progress.hidden = false;
  }

  function download(name, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function showPacket(index) {
    if (!report) return;
    if (!file) {
      el(doc, "pktSum").textContent = "Drop the matching .ts to view packet " + index + ".";
      el(doc, "hex").textContent = "";
      return;
    }
    const framing = report.framing || { size: 188, align: 0 };
    const off = index * framing.size + framing.align;
    const buf = new Uint8Array(await file.slice(off, off + 188).arrayBuffer());
    const info = decodePacket(buf);
    el(doc, "pktSum").textContent = "Packet " + index + "  ·  " + packetSummary(info);
    const rows = hexRows(buf).map((r) => {
      const offHex = r.offset.toString(16).padStart(4, "0");
      return offHex + "  " + r.hex.padEnd(16 * 3, " ") + "  " + r.ascii;
    });
    el(doc, "hex").textContent = rows.join("\n");
    el(doc, "pktIndex").value = String(index);
  }

  function renderSummary() {
    const s = report.summary;
    const checks = report.tr290.checks;
    const p1 = Object.entries(checks).filter(([name]) => name !== "Datagram_gap")
      .reduce((n, [name, count]) => n + (prioOf(name) === 1 ? count : 0), 0);
    const hrd = report.hrd && report.hrd.modelled ? report.hrd.counts : null;
    const tstd = report.tstd && report.tstd.modelled ? report.tstd : null;
    const chips = [
      ["Duration", s.durationS.toFixed(2) + " s"],
      ["Mux", s.muxEstimated ? "nominal 10 Mb/s" : mbps(s.muxBps) + " Mb/s"],
      ["Packets", s.packets.toLocaleString()],
      ["Programs", String(s.programs)],
      ["PCR max", s.pcrMaxIntervalMs.toFixed(1) + " ms"],
      ["P1 errors", String(p1)],
      ["Resyncs", String(s.resyncs)],
      ["HRD", hrd ? (hrd.underflowPlan + hrd.overflowPlan) + " violations" : "not modelled"],
      ["T-STD", tstd ? tstd.method : "not modelled"],
    ];
    el(doc, "summary").innerHTML = chips.map(([k, v]) =>
      "<div class=\"chip\"><span>" + esc(k) + "</span><b>" + esc(v) + "</b></div>").join("");
  }

  function prioOf(name) {
    const row = {
      TS_sync_loss: 1, Sync_byte_error: 1, PAT_error: 1, Continuity_count_error: 1,
      PMT_error: 1, PID_error: 1,
      Transport_error: 2, CRC_error: 2, PCR_repetition_error: 2, PCR_discontinuity_error: 2,
      PCR_accuracy_error: 2, PTS_error: 2, CAT_error: 2, Datagram_gap: 2,
    };
    return row[name] || 3;
  }

  function selectTab(name) {
    for (const btn of doc.querySelectorAll("[data-tab]")) {
      btn.classList.toggle("on", btn.dataset.tab === name);
    }
    for (const panel of doc.querySelectorAll("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== name;
    }
    // The timeline is a band under the report, so it only belongs on Overview
    // and on its own tab. Everywhere else it would squeeze the plots.
    const band = el(doc, "timelineBar");
    if (band) {
      const onTimeline = name === "timeline";
      band.hidden = !report || !(name === "overview" || onTimeline);
      if (band.classList && band.classList.toggle) band.classList.toggle("page", onTimeline);
      if (!band.hidden && onTimeline) {
        // A canvas that was hidden has no width, so the first draw after the
        // switch would measure nothing. Redraw once the layout has settled.
        if (!timelineView.manual) timelineView.height = 0;
        const later = typeof requestAnimationFrame === "function"
          ? requestAnimationFrame
          : (fn) => setTimeout(fn, 0);
        later(() => drawTimelineBar());
      }
    }
    if (report) drawCharts();
  }

  function renderPids() {
    const rows = report.pids.map((p) => {
      // The short name is what fits the column; the stream type and the
      // descriptor-derived name are the tooltip, so nothing is hidden.
      const detail = [
        p.long && p.long !== p.kind ? p.long : "",
        p.type === null || p.type === undefined ? "" : "stream type 0x" + Number(p.type).toString(16).padStart(2, "0"),
      ].filter(Boolean).join(" · ");
      return "<tr" + (detail ? " title=\"" + esc(detail) + "\"" : "") + "><td>" + p.pid
        + "</td><td>" + esc(p.kind)
        + "</td><td>" + (p.packets || 0).toLocaleString() + "</td><td>" + p.meanMbps.toFixed(3)
        + "</td><td>" + p.minMbps.toFixed(3) + "</td><td>" + p.maxMbps.toFixed(3)
        + "</td><td>" + p.cc_errs + "</td><td>" + p.scrambled + "</td><td>"
        + (p.pcr ? "yes" : "") + "</td></tr>";
    }).join("");
    el(doc, "pids").innerHTML = "<table><thead><tr><th>PID</th><th>Kind</th><th>Packets</th>"
      + "<th>Mean Mb/s</th><th>Min</th><th>Max</th><th>CC</th><th>Scrambled</th><th>PCR</th>"
      + "</tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function renderPsi() {
    const psi = report.psi;
    const parts = [];
    if (psi.pat) {
      parts.push("<h3>PAT</h3><ul>" + psi.pat.programs.map((p) =>
        "<li>program " + p.program + " → PMT PID " + p.pid + "</li>").join("") + "</ul>");
    } else parts.push("<h3>PAT</h3><p>No PAT.</p>");
    for (const pmt of psi.pmts) {
      parts.push("<h3>PMT " + pmt.program + "</h3><p>PCR PID " + pmt.pcrPid + "</p><ul>"
        + pmt.streams.map((s) => "<li>PID " + s.pid + " " + esc(s.typeName)
          + (s.info && s.info.length ? " (" + esc(s.info.map((d) => d.text || d.name).filter(Boolean).join(", ")) + ")" : "")
          + "</li>").join("") + "</ul>");
    }
    if (psi.sdt) {
      parts.push("<h3>SDT</h3><ul>" + psi.sdt.services.map((s) =>
        "<li>" + s.id + " " + esc(s.name) + (s.provider ? " / " + esc(s.provider) : "") + "</li>").join("") + "</ul>");
    }
    if (psi.nit) {
      parts.push("<h3>NIT</h3><p>" + esc(psi.nit.name || "(no name)") + "</p>");
    }
    if (psi.eit && psi.eit.length) {
      parts.push("<h3>EIT</h3><ul>" + psi.eit.slice(0, 40).map((e) =>
        "<li>" + esc(e.start) + " " + esc(e.duration) + " " + esc(e.name) + "</li>").join("") + "</ul>");
    }
    if (report.scte35.length) {
      parts.push("<h3>SCTE-35</h3><ul>" + report.scte35.map((e) => {
        const c = e.command || {};
        const seg = (e.descriptors || []).map((d) => d.segmentation && d.segmentation.typeName).filter(Boolean).join(", ");
        return "<li>packet " + e.packetIndex + " " + esc(c.name || "")
          + (c.eventId !== undefined ? " id " + c.eventId : "")
          + (seg ? " · " + esc(seg) : "") + "</li>";
      }).join("") + "</ul>");
    }
    if (psi.crcErrors) parts.push("<p>" + psi.crcErrors + " PSI section CRC errors.</p>");
    el(doc, "psi").innerHTML = parts.join("");
  }

  function renderChecks() {
    const checks = report.tr290.checks;
    el(doc, "checks").innerHTML = "<table><thead><tr><th>Check</th><th>Pri</th><th>Count</th></tr></thead><tbody>"
      + Object.entries(checks).map(([name, count]) => "<tr class=\"" + (count ? "bad" : "") + "\"><td>"
        + esc(name) + "</td><td>P" + prioOf(name) + "</td><td>" + count + "</td></tr>").join("")
      + "</tbody></table>";
    const events = report.events || [];
    el(doc, "events").innerHTML = events.length
      ? "<table><thead><tr><th>t</th><th></th><th>Check</th><th>Detail</th></tr></thead><tbody>"
        + events.slice(-300).map((e) => "<tr data-pkt=\"" + e.packetIndex + "\"><td>"
          + (e.t || 0).toFixed(3) + "</td><td>P" + e.prio + "</td><td>" + esc(e.name)
          + "</td><td>" + esc(e.detail) + "</td></tr>").join("") + "</tbody></table>"
      : "<p>No errors.</p>";
    drawTimeline(el(doc, "errTimeline"), events, report.summary.durationS);
  }

  function renderTiming() {
    const intervals = (report.timing.intervals || []).map((p) => [p.t, p.ms]);
    drawLines(el(doc, "pcr"), {
      title: "PCR interval (ms, unwrapped)",
      series: [{ color: "#833ab4", pts: intervals }],
      empty: "No PCR interval",
    });
    const byPid = new Map();
    for (const row of report.timing.ptsPcr || []) {
      if (row.kind !== "PTS") continue;
      if (!byPid.has(row.pid)) byPid.set(row.pid, []);
      byPid.get(row.pid).push([row.t, row.ms]);
    }
    const series = [...byPid.entries()].map(([pid, pts], i) => ({
      color: PALETTE[i % PALETTE.length],
      pts,
    }));
    const fit = report.timing.fit || { maxAbsMs: 0 };
    drawLines(el(doc, "pts"), {
      title: "PTS − PCR (ms). PCR fit residual " + fit.maxAbsMs.toFixed(3) + " ms",
      series,
      empty: "No PTS",
    });
    const pcr = report.pcrAccuracy || {};
    const note = el(doc, "pcrNote");
    if (note) {
      const rms = pcr.rmsNs === null || pcr.rmsNs === undefined ? "n/a" : pcr.rmsNs.toFixed(1) + " ns rms";
      note.textContent = (pcr.count || 0) + " PCR samples, " + (pcr.overLimit || 0)
        + " outside ±500 ns, " + rms + ". " + (pcr.arrivalNote || "");
    }
    drawHistogram(el(doc, "pcrHist"), {
      title: "PCR_AC (ns)",
      bins: pcr.hist || [],
      empty: "No PCR",
    });
  }

  function renderOverview() {
    const s = report.summary;
    const c = report.compliance || { pass: 0, fail: 0, na: 0 };
    const lines = [
      "<table><tbody>",
      row("File", esc((file && file.name) || (reportFile && reportFile.name) || report.fileName || "stream")),
      row("Size", s.bytes ? (s.bytes / 1e6).toFixed(2) + " MB" : "unknown"),
      row("Duration", s.durationS.toFixed(3) + " s"),
      row("Mux rate", s.muxEstimated ? "no PCR, assumed 10 Mb/s" : mbps(s.muxBps) + " Mb/s"),
      row("Packets", s.packets.toLocaleString() + " over " + (s.bytes / 1e6).toFixed(2) + " MB"),
      row("Programs", String(s.programs)),
      row("Compliance", c.fail + " failing, " + c.pass + " passing, " + c.na + " not measured"),
      "</tbody></table>",
    ];
    el(doc, "overview").innerHTML = lines.join("");

    function row(k, v) {
      return "<tr><td style=\"color:var(--ink2);width:150px\">" + k + "</td><td>" + v + "</td></tr>";
    }
  }

  function renderSi() {
    const psi = report.psi || {};
    const bits = [];
    if (psi.tdt) bits.push("<p>TDT/TOT " + esc(psi.tdt.time) + "</p>");
    for (const pmt of psi.pmts || []) {
      bits.push("<details open><summary>PMT " + pmt.program + "</summary><ul>"
        + (pmt.streams || []).map((s) => "<li>PID " + s.pid + " " + esc(s.typeName)
          + (s.hrdManagementValid === 1 ? " HRD-managed" : s.hrdManagementValid === 0 ? " leak method" : "")
          + (s.info && s.info.length ? " — " + esc(s.info.map((d) => (d.name || "") + (d.text ? " " + d.text : "")).join("; ")) : "")
          + "</li>").join("") + "</ul></details>");
    }
    if (psi.nit) {
      bits.push("<details><summary>NIT " + esc(psi.nit.name || "") + "</summary><p>"
        + (psi.nit.transports || []).length + " transports</p></details>");
    }
    el(doc, "siTree").innerHTML = bits.join("") || "<p>No SI.</p>";
    const epg = psi.epg || [];
    el(doc, "epg").innerHTML = epg.length ? epg.map((g) => {
      const events = g.events || [];
      const bars = events.slice(0, 12).map((e, i) =>
        "<i style=\"left:" + (i * 8) + "%;width:18%\">" + esc(e.name || e.start) + "</i>").join("");
      return "<p>Service " + g.serviceId + "</p><div class=\"epg\">" + bars + "</div>";
    }).join("") : "<p>No EPG events.</p>";
  }

  function renderVideo() {
    const streams = (report.video && report.video.streams) || [];
    const stream = streams.find((s) => s.sps && s.sps.length) || streams[0];
    if (!stream || !stream.auCount) {
      el(doc, "esTree").innerHTML = "<p>No H.264 access unit in this file.</p>";
      el(doc, "esGops").innerHTML = "";
      drawBars(el(doc, "esFrames"), { bars: [], empty: "No pictures" });
      return;
    }
    const sps = (stream.sps || []).map((s) => "<li>" + esc(s.profileName) + " level " + s.levelIdc
      + " " + s.width + "×" + s.height
      + (s.bitRate ? " " + (s.bitRate / 1e6).toFixed(3) + " Mb/s" : "")
      + (s.cpbMs ? " CPB " + s.cpbMs.toFixed(1) + " ms" : "")
      + " " + esc(s.whichHrd || "no HRD") + "</li>").join("");
    el(doc, "esTree").innerHTML = "<p>PID " + stream.pid + " · " + stream.auCount + " access units · "
      + stream.idrCount + " IDR</p><ul>" + sps + "</ul>";
    const sizes = (stream.frames || []).map((f) => f.bytes);
    const meanKb = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length / 1000 : 0;
    drawBars(el(doc, "esFrames"), {
      title: "Access unit size (kB) · mean " + meanKb.toFixed(1) + " kB",
      bars: (stream.frames || []).map((f) => ({ v: f.bytes / 1000, frame: f.frame })),
      unit: "kB",
      empty: "No pictures",
    });
    el(doc, "esGops").innerHTML = "<table><thead><tr><th>GOP</th><th></th><th>Length</th><th>Packet</th></tr></thead><tbody>"
      + (stream.gops || []).slice(0, 40).map((g) => "<tr data-pkt=\"" + g.packetIndex + "\"><td>"
        + esc(g.pattern) + "</td><td>" + (g.closed ? "closed" : "open") + "</td><td>" + g.length
        + "</td><td>" + g.packetIndex + "</td></tr>").join("") + "</tbody></table>";
  }

  function renderHrd() {
    const hrd = report.hrd || {};
    const note = el(doc, "hrdNote");
    if (!hrd.modelled) {
      note.textContent = "No H.264 sequence with HRD parameters. Other codecs are not modelled.";
      drawLines(el(doc, "hrdFull"), { series: [], empty: "No CPB" });
      drawLines(el(doc, "hrdLead"), { series: [], empty: "No lead" });
      el(doc, "hrdJoins").innerHTML = "";
    } else {
      const c = hrd.counts || {};
      const sps = (hrd.sps || [])[0];
      note.textContent = "PID " + hrd.pid + (sps ? " · " + sps.profileName + " level " + sps.levelIdc : "")
        + " · " + c.aus + " AUs · underflow " + c.underflowPlan + " · overflow " + c.overflowPlan
        + " · joins " + c.joins;
      const cap = sps && sps.cpbMs ? sps.cpbMs : null;
      drawLines(el(doc, "hrdFull"), {
        title: "CPB fullness (%)",
        series: [{ color: "#d6249f", pts: (hrd.fullness || []).map((p) => [p.t, p.pct]) }],
        limits: [{ y: 100, label: "CpbSize", color: "#fd5949" }],
        empty: "No fullness",
      });
      drawLines(el(doc, "hrdLead"), {
        title: "Lead (ms)" + (cap ? " · CPB " + cap.toFixed(0) + " ms" : ""),
        series: [
          { color: "#833ab4", pts: (hrd.leads || []).map((p) => [p.t, p.plan]) },
          { color: "#f77737", pts: (hrd.leads || []).filter((p) => p.wire !== null).map((p) => [p.t, p.wire]) },
        ],
        empty: "No lead",
      });
      const joins = hrd.joins || [];
      el(doc, "hrdJoins").innerHTML = joins.length
        ? "<table><thead><tr><th>t</th><th>Debt ms</th><th>Declared</th><th>A level</th><th>Extra bits</th><th>Why</th></tr></thead><tbody>"
          + joins.map((j) => "<tr data-pkt=\"" + j.packetIndex + "\"><td>" + (j.t || 0).toFixed(3)
            + "</td><td>" + j.debtMs + "</td><td>" + j.bDeclaredMs + "</td><td>" + j.aLevelAtCutMs
            + "</td><td>" + j.extraBits + "</td><td>" + esc((j.reasons || []).join(", ")) + "</td></tr>").join("")
          + "</tbody></table>"
        : "<p>No joins.</p>";
    }
    const tstd = report.tstd || {};
    const tnote = el(doc, "tstdNote");
    if (!tstd.modelled) {
      tnote.textContent = "T-STD is only run for H.264.";
      drawLines(el(doc, "tstdChart"), { series: [], empty: "No T-STD" });
      el(doc, "tstdEvents").innerHTML = "";
      return;
    }
    const lim = tstd.limits || {};
    tnote.textContent = (tstd.method === "hrd" ? "HRD-managed" : "Leak method")
      + " · TB " + lim.tbBytes + " B · MB " + lim.mbBytes + " B · EB " + lim.ebBytes + " B"
      + " · Rx " + Math.round((lim.rxBps || 0) * 8 / 1000) + " kb/s"
      + " · Rbx " + Math.round((lim.rbxBps || 0) * 8 / 1000) + " kb/s";
    drawLines(el(doc, "tstdChart"), {
      title: "TB, MB and EB (bytes)",
      series: [
        { color: "#833ab4", pts: (tstd.series || []).map((p) => [p.t, p.tb]) },
        { color: "#f77737", pts: (tstd.series || []).map((p) => [p.t, p.mb]) },
        { color: "#d6249f", pts: (tstd.series || []).map((p) => [p.t, p.eb]) },
      ],
      limits: [
        { y: lim.tbBytes, label: "TB", color: "#833ab4" },
        { y: lim.ebBytes, label: "EB", color: "#d6249f" },
      ],
      empty: "No samples",
    });
    const events = tstd.events || [];
    el(doc, "tstdEvents").innerHTML = events.length
      ? "<table><thead><tr><th>t</th><th>Buffer</th><th>Detail</th></tr></thead><tbody>"
        + events.slice(0, 80).map((e) => "<tr data-pkt=\"" + e.packetIndex + "\"><td>" + e.t
          + "</td><td>" + esc(e.kind) + "</td><td>" + esc(e.detail) + "</td></tr>").join("")
        + "</tbody></table>"
      : "<p>No T-STD violations.</p>";
  }

  // Paint an RGBA subtitle over a mid-grey backdrop. Subtitles arrive
  // transparent, so without a backdrop a correctly decoded one looks blank.
  // With no picture the canvas is emptied and hidden rather than left holding
  // the previous file's bitmap, which would look like a subtitle belonging to
  // the file just opened.
  function paintSubtitle(canvas, picture) {
    if (!canvas) return;
    if (!picture || !picture.pixels) {
      canvas.width = 1;
      canvas.height = 1;
      canvas.hidden = true;
      return;
    }
    canvas.hidden = false;
    canvas.width = picture.width;
    canvas.height = picture.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(0, 0, picture.width, picture.height);
    const img = ctx.createImageData(picture.width, picture.height);
    img.data.set(picture.pixels);
    for (let i = 0; i < img.data.length; i += 4) {
      const a = img.data[i + 3] / 255;
      if (a >= 1) continue;
      const under = 0x3a;
      img.data[i] = Math.round(img.data[i] * a + under * (1 - a));
      img.data[i + 1] = Math.round(img.data[i + 1] * a + under * (1 - a));
      img.data[i + 2] = Math.round(img.data[i + 2] * a + under * (1 - a));
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function renderSubs() {
    const pages = report.teletext || [];
    el(doc, "subList").innerHTML = pages.length
      ? "<ul>" + pages.map((p, i) => "<li><button type=\"button\" data-page=\"" + i + "\">"
        + p.number + "</button></li>").join("") + "</ul>"
      : "<p>No teletext pages.</p>";
    el(doc, "subText").textContent = pages[0] ? pages[0].text : "";
    const canvas = el(doc, "subCanvas");
    const sets = (report.subtitles || []).filter((s) => s.pixels);
    const note = el(doc, "subNote");
    if (note) {
      note.textContent = sets.length
        ? sets.length + " display set" + (sets.length === 1 ? "" : "s") + " with pixels. The preview is the first one, over a grey backdrop in place of the video."
        : "No DVB subtitle picture was decoded from this file.";
    }
    if (!canvas) return;
    paintSubtitle(canvas, sets[0]);
  }

  // --- the bundled tools -----------------------------------------------------

  // The tools only run on a real transport stream. An imported JSON report has
  // no bytes behind it, and the vendor modules are not in every build.
  function toolerFor() {
    if (tooler) return tooler;
    // A build without the tools, or a broken one, must never stop the report
    // from rendering: the tables are worth more than the extra views.
    try {
      tooler = opts.createTools ? opts.createTools() : null;
    } catch (err) {
      tooler = null;
    }
    return tooler;
  }

  function captionPid() {
    const stream = ((report.video && report.video.streams) || []).find((s) => s.captions && (s.captions.cea608 || s.captions.cea708));
    return stream ? stream.pid : null;
  }

  function renderCaptionNote() {
    const note = el(doc, "ccNote");
    if (!note) return;
    const tools = toolerFor();
    const pid = captionPid();
    const stream = ((report.video && report.video.streams) || []).find((s) => s.pid === pid);
    const parts = [];
    if (stream && stream.captions) {
      const c = stream.captions;
      parts.push(c.messages + " caption SEI message" + (c.messages === 1 ? "" : "s") + " on PID " + pid
        + " (" + [c.cea608 ? "CEA-608" : "", c.cea708 ? "CEA-708" : ""].filter(Boolean).join(" and ") + ")");
    } else {
      parts.push("No GA94 caption data was found in the H.264 SEI messages.");
    }
    if (!tools || !tools.captions) parts.push("This build has no caption decoder.");
    else if (!file) parts.push("Drop the matching .ts to decode them.");
    note.textContent = parts.join(". ").replace(/\.\.$/, ".");
    const run = el(doc, "ccRun");
    if (run) run.disabled = !(tools && tools.captions && file && pid);
  }

  function cueRows(cues) {
    return "<table><thead><tr><th>Start</th><th>End</th><th>Text</th></tr></thead><tbody>"
      + cues.slice(0, 400).map((c) => "<tr><td>" + c.t0.toFixed(2) + " s</td><td>" + c.t1.toFixed(2) + " s</td><td>"
        + esc(c.text) + "</td></tr>").join("") + "</tbody></table>";
  }

  function captionName() {
    const base = (file && file.name ? file.name : "captions").replace(/\.[^.]+$/, "");
    return base + ".cc.srt";
  }

  async function runCaptions() {
    const tools = toolerFor();
    const pid = captionPid();
    if (!tools || !tools.captions || !file || !pid) return;
    const note = el(doc, "ccNote");
    if (note) note.textContent = "Reading captions with CCExtractor...";
    try {
      const result = await tools.captions(file);
      toolState.captions = result;
      if (note) {
        note.textContent = result.cues.length
          ? result.cues.length + " caption cue" + (result.cues.length === 1 ? "" : "s") + " from PID " + pid + "."
          : "CCExtractor ran but found no caption cues (exit " + result.exitCode + ").";
      }
      if (el(doc, "ccList")) el(doc, "ccList").innerHTML = result.cues.length ? cueRows(result.cues) : "";
      if (el(doc, "ccSave")) el(doc, "ccSave").disabled = !result.cues.length;
      // The cues go into the report so the timeline can draw them and the
      // exports carry them.
      report.captions = { cues: result.cues, exitCode: result.exitCode };
      timelineView.height = 0;
      drawTimelineBar();
    } catch (err) {
      if (note) note.textContent = "Captions failed: " + String(err && err.message ? err.message : err);
    }
  }

  // Teletext pages come from the PMT descriptor, which our own parser already
  // reads. telxcc is asked for the page number and the PID of that page.
  function teletextPages() {
    const pages = [];
    for (const pmt of (report.psi && report.psi.pmts) || []) {
      for (const stream of pmt.streams || []) {
        if (!stream.teletext || !stream.info) continue;
        for (const item of stream.info) {
          for (const page of item.pages || []) {
            const number = page && page.page !== undefined ? page.page : page;
            if (number) pages.push({ pid: stream.pid, page: number });
          }
        }
      }
    }
    const seen = new Set();
    return pages.filter((p) => {
      const key = p.pid + ":" + p.page;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function renderTeletextNote() {
    const note = el(doc, "ttList");
    const tools = toolerFor();
    const pages = teletextPages();
    if (note && !toolState.teletext.length) {
      note.innerHTML = pages.length
        ? "<p class=\"sub\">" + pages.length + " teletext subtitle page" + (pages.length === 1 ? "" : "s")
          + " declared in the PMT" + (tools && tools.teletext ? "." : "; this build has no teletext decoder.") + "</p>"
        : "";
    }
    const run = el(doc, "ttRun");
    if (run) run.disabled = !(tools && tools.teletext && file && pages.length);
  }

  async function runTeletext() {
    const tools = toolerFor();
    if (!tools || !tools.teletext || !file) return;
    const pages = teletextPages();
    const list = el(doc, "ttList");
    if (list) list.innerHTML = "<p class=\"sub\">Running telxcc...</p>";
    const out = [];
    for (const job of pages.slice(0, 8)) {
      try {
        out.push(await tools.teletext(file, job.pid, job.page));
      } catch (err) {
        out.push({ pid: job.pid, page: job.page, cues: [], error: String(err && err.message ? err.message : err) });
      }
    }
    toolState.teletext = out;
    if (list) {
      list.innerHTML = out.map((row) => "<h3>PID " + row.pid + " page " + row.page + "</h3>"
        + (row.error ? "<p class=\"sub\">" + esc(row.error) + "</p>"
          : row.cues.length ? cueRows(row.cues)
            : "<p class=\"sub\">No cues for this page"
              + (row.dropped ? " (" + row.dropped + " outside this file)" : "") + ".</p>")).join("");
    }
    const save = el(doc, "ttSave");
    if (save) save.disabled = !out.some((row) => row.cues.length);
    drawTimelineBar();
  }

  // SCTE-35 is parsed by us first, then the same section bytes go to
  // libklscte35. Only a field that both parsers report differently is listed.
  async function runScteCheck() {
    const tools = toolerFor();
    const box = el(doc, "scteCheck");
    const note = el(doc, "scteNote");
    const events = (report.scte35 || []).filter((e) => e.section);
    if (!box) return;
    if (!tools || !tools.scte) {
      box.innerHTML = "";
      if (note) note.textContent = "This build has no SCTE-35 comparison library.";
      return;
    }
    if (!events.length) {
      box.innerHTML = "";
      if (note) note.textContent = "This file has no SCTE-35 section to compare.";
      return;
    }
    box.innerHTML = "<p class=\"sub\">Comparing " + events.length + " section" + (events.length === 1 ? "" : "s") + "...</p>";
    try {
      const theirs = await tools.scte(events.map((e, i) => ({ index: i, hex: e.section })));
      const rows = [];
      for (const item of theirs) {
        const ours = events[item.index];
        if (!item.ok) {
          rows.push({ at: ours, diffs: [{ field: "parse", ours: "ok", theirs: item.error || "failed" }] });
          continue;
        }
        const diffs = compareScte(ours, item);
        if (diffs.length) rows.push({ at: ours, diffs });
      }
      toolState.scte = rows;
      box.innerHTML = rows.length
        ? "<table><thead><tr><th>Packet</th><th>Field</th><th>Here</th><th>libklscte35</th></tr></thead><tbody>"
          + rows.map((row) => row.diffs.map((d, i) => "<tr class=\"bad\"><td>"
            + (i ? "" : row.at.packetIndex) + "</td><td>" + esc(d.field) + "</td><td>" + esc(String(d.ours))
            + "</td><td>" + esc(String(d.theirs)) + "</td></tr>").join("")).join("") + "</tbody></table>"
        : "<p class=\"sub\">Both parsers agree on every section in this file.</p>";
      if (note) {
        note.textContent = rows.length
          ? rows.length + " section" + (rows.length === 1 ? "" : "s") + " differ. The field, this parser's value and libklscte35's are listed."
          : events.length + " section" + (events.length === 1 ? "" : "s") + " compared; both parsers agree.";
      }
    } catch (err) {
      box.innerHTML = "";
      if (note) note.textContent = "The comparison failed: " + String(err && err.message ? err.message : err);
    }
  }

  function renderReport() {
    const rows = (report.compliance && report.compliance.rows) || [];
    el(doc, "reportTable").innerHTML = "<table><thead><tr><th>Group</th><th>Check</th><th></th><th>Count</th><th>Packet</th><th>Clause</th></tr></thead><tbody>"
      + rows.map((r) => "<tr data-pkt=\"" + r.packetIndex + "\" class=\"" + (r.state === "fail" ? "bad" : "") + "\"><td>"
        + esc(r.group) + "</td><td>" + esc(r.name) + "</td><td>" + esc(r.state) + "</td><td>" + r.count
        + "</td><td>" + (r.packetIndex >= 0 ? r.packetIndex : "") + "</td><td>" + esc(r.clause) + "</td></tr>").join("")
      + "</tbody></table>";
  }

  function drawCharts() {
    renderTiming();
    renderVideo();
    renderHrd();
    if (report.bitrate) drawStacked(el(doc, "rate"), report.bitrate, view);
    drawTimeline(el(doc, "errTimeline"), report.events || [], report.summary.durationS);
  }

  function renderBitrate() {
    view.x0 = 0;
    view.x1 = report.bitrate.steps;
    view.hidden = new Set();
    view.hover = null;
    const legend = el(doc, "legend");
    legend.innerHTML = "";
    report.bitrate.series.forEach((s, i) => {
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "leg";
          chip.innerHTML = "<i style=\"background:" + PALETTE[i % PALETTE.length] + "\"></i>" + esc(s.label);
      chip.onclick = () => {
        if (view.hidden.has(s.pid)) view.hidden.delete(s.pid);
        else view.hidden.add(s.pid);
        chip.classList.toggle("off", view.hidden.has(s.pid));
        drawStacked(el(doc, "rate"), report.bitrate, view);
      };
      legend.appendChild(chip);
    });
    drawStacked(el(doc, "rate"), report.bitrate, view);
  }

  function render(next) {
    report = next;
    out.hidden = false;
    drop.hidden = true;
    jsonBtn.disabled = false;
    csvBtn.disabled = false;
    htmlBtn.disabled = false;
    // The tab goes first: if one render step below throws, the page is still
    // on a tab that shows what did render.
    selectTab("overview");
    renderSummary();
    renderPids();
    renderPsi();
    renderSi();
    renderBitrate();
    renderChecks();
    renderVideo();
    renderHrd();
    renderSubs();
    renderCaptionNote();
    renderReport();
    renderOverview();
    renderTiming();
    timelineView.t0 = 0;
    timelineView.t1 = report.summary.durationS || 1;
    timelineView.hidden = new Set();
    timelineView.height = 0;
    timelineView.manual = false;
    toolState.captions = null;
    toolState.teletext = [];
    toolState.scte = null;
    if (el(doc, "ccList")) el(doc, "ccList").innerHTML = "";
    if (el(doc, "ttList")) el(doc, "ttList").innerHTML = "";
    if (el(doc, "scteCheck")) el(doc, "scteCheck").innerHTML = "";
    // The preview canvases belong to the file, not to the tab. Emptying them
    // here means a new file never shows the previous one's still or subtitle.
    if (el(doc, "timelineSub")) {
      el(doc, "timelineSub").hidden = true;
      paintSubtitle(el(doc, "timelineSub"), null);
    }
    resetThumbnailCache();
    drawTimelineBar();
    renderTeletextNote();
    if (file) {
      for (const key of allLaneKeys(report)) {
        if (key.startsWith("audio:") && !timelineView.hidden.has(key)) {
          decodeAudio(Number(key.slice("audio:".length)));
        }
      }
      // The SCTE sections are already in the report, so the second parse costs
      // nothing but a worker message and gives a standing cross-check.
      runScteCheck();
      if (report.thumbnails && report.thumbnails.length) drawTimelineBar();
    }
    showPacket(0);
  }

  function laneLabel(key) {
    const [kind, pid] = key.split(":");
    if (kind === "thumbs") return "I-frame stills";
    if (kind === "video") return "pictures · PID " + pid;
    if (kind === "scte") return "SCTE-35 · PID " + pid;
    if (kind === "subtitle") return "subtitles · PID " + pid;
    if (kind === "caption") return "captions";
    if (kind === "audio") {
      // The stream name the PMT gave the PID, so the chip reads "MPEG-1 audio"
      // rather than a generic "audio".
      const row = (report.pids || []).find((p) => p.pid === Number(pid));
      const name = row && row.kind ? row.kind : "audio";
      return name + " · PID " + pid;
    }
    return key;
  }

  function duration() {
    return (report && report.summary && report.summary.durationS) || 1;
  }

  // The bar is as tall as its lanes want, unless the user has dragged the
  // grip. Lanes appear as stills and audio arrive, so a lane change refits
  // the height until the user takes over.
  function applyTimelineHeight(refit) {
    const canvas = el(doc, "mediaTimeline");
    if (!canvas) return;
    // On its own tab the bar can use most of the viewport; the sticky band on
    // Overview has to leave room for the summary above it.
    const page = !!(el(doc, "timelineBar") && el(doc, "timelineBar").classList
      && el(doc, "timelineBar").classList.contains && el(doc, "timelineBar").classList.contains("page"));
    const share = page ? 0.78 : 0.62;
    const room = Math.max(320, Math.round((window.innerHeight || 900) * share));
    if (refit && !timelineView.manual) timelineView.height = 0;
    if (!timelineView.height) timelineView.height = Math.min(room, timelineHeight(report, timelineView.hidden));
    timelineView.height = Math.min(timelineView.height, room);
    canvas.style.height = timelineView.height + "px";
  }

  function showSpan() {
    const label = el(doc, "timelineSpan");
    if (!label) return;
    const span = Math.max(0, timelineView.t1 - timelineView.t0);
    const full = Math.abs(span - duration()) < 1e-6;
    label.textContent = full ? "full file" : rangeText(timelineView.t0, timelineView.t1);
    label.title = full
      ? "Showing the whole file"
      : "Window " + timelineView.t0.toFixed(3) + " s to " + timelineView.t1.toFixed(3) + " s";
  }

  function rangeText(a, b) {
    const span = Math.max(0, b - a);
    if (span >= 1) return span.toFixed(2) + " s";
    return Math.round(span * 1000) + " ms";
  }

  function zoomBy(factor, anchorT) {
    if (!report) return;
    const next = zoomSpan(timelineView.t0, timelineView.t1, factor, anchorT, duration());
    timelineView.t0 = next.t0;
    timelineView.t1 = next.t1;
    drawTimelineBar();
  }

  function panBy(dt) {
    if (!report) return;
    const next = panSpan(timelineView.t0, timelineView.t1, dt, duration());
    timelineView.t0 = next.t0;
    timelineView.t1 = next.t1;
    drawTimelineBar();
  }

  function drawTimelineBar() {
    const canvas = el(doc, "mediaTimeline");
    if (!canvas || !report) return;
    const chips = el(doc, "timelineChips");
    if (chips) {
      chips.innerHTML = "";
      for (const key of allLaneKeys(report)) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "leg " + (timelineView.hidden.has(key) ? "off" : "on");
        button.textContent = laneLabel(key);
        button.onclick = () => {
          if (timelineView.hidden.has(key)) timelineView.hidden.delete(key);
          else timelineView.hidden.add(key);
          const kind = key.split(":")[0];
          const pid = Number(key.split(":")[1]);
          if (kind === "audio" && !timelineView.hidden.has(key)) decodeAudio(pid);
          if (kind === "thumbs" && !timelineView.hidden.has(key) && !(report.thumbnails || []).length) loadThumbs();
          drawTimelineBar();
        };
        chips.appendChild(button);
      }
    }
    const cues = cueMarkers(report);
    const legend = el(doc, "cueLegend");
    if (legend) {
      legend.innerHTML = cues.length
        ? "<span class=\"leg\"><i style=\"background:#f77737;height:14px;width:2px;display:inline-block\"></i>CUE-OUT</span>"
          + "<span class=\"leg\"><i style=\"background:#d6249f;height:14px;width:2px;display:inline-block\"></i>CUE-IN</span>"
        : "";
    }
    applyTimelineHeight(true);
    drawMediaTimeline(canvas, report, timelineView);
    showSpan();
  }

  async function loadThumbs() {
    const count = Number((el(doc, "thumbCount") && el(doc, "thumbCount").value) || 12);
    const iFrames = (report.timeline && report.timeline.iFrames) || [];
    if (!iFrames.length) {
      el(doc, "timelineDetail").textContent = "This file has no I-frame markers to place stills on.";
      return;
    }
    if (!file) {
      el(doc, "timelineDetail").textContent = "Drop the matching .ts to extract I-frame stills.";
      return;
    }
    if (!decoder) decoder = opts.createDecoder ? opts.createDecoder() : null;
    if (!decoder) {
      el(doc, "timelineDetail").textContent = "This build has no FFmpeg core, so stills are not extracted here.";
      return;
    }
    const chosen = pickTimes(iFrames, count);
    try {
      const items = await decoder.thumbnails(file, chosen, report, (status) => {
        el(doc, "timelineDetail").textContent = status && status.text ? status.text : String(status);
      });
      // Place each still on the I-frame slot it was taken from, in order.
      const slots = [];
      for (const time of chosen) {
        let best = iFrames[0];
        let bestD = Infinity;
        for (const row of iFrames) {
          const d = Math.abs(row.t - time);
          if (d < bestD) { best = row; bestD = d; }
        }
        slots.push(best);
      }
      const placed = items.map((item, i) => {
        const slot = slots[Math.min(i, slots.length - 1)] || iFrames[0];
        return { t: slot.t, packetIndex: slot.packetIndex, jpeg: item.jpeg, w: item.w, h: item.h };
      });
      report.thumbnails = placed;
      resetThumbnailCache();
      timelineView.hidden.delete("thumbs:0");
      const capped = placed.length < count
        ? " (the file has " + iFrames.length + " I-frames, so fewer than the " + count + " asked for)"
        : "";
      el(doc, "timelineDetail").textContent = placed.length + " I-frame stills" + capped + ". Click one to open it.";
      drawTimelineBar();
    } catch (err) {
      if (String(err && err.message) === "cancelled") return;
      el(doc, "timelineDetail").textContent = String(err && err.message ? err.message : err);
    }
  }

  function pickTimes(iFrames, count) {
    if (iFrames.length <= count) return iFrames.map((row) => row.t);
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(iFrames[Math.round(i * (iFrames.length - 1) / (count - 1))].t);
    }
    return out;
  }

  function showCue(row) {
    const bits = [row.cue === "out" ? "CUE-OUT" : "CUE-IN", "at " + row.t.toFixed(3) + " s"];
    if (row.label) bits.push(row.label);
    if (row.eventId !== null && row.eventId !== undefined) bits.push("event " + row.eventId);
    if (row.breakMs) bits.push("break " + (row.breakMs / 1000).toFixed(1) + " s");
    el(doc, "timelineDetail").textContent = bits.join(" · ");
  }

  async function decodeAudio(pid) {
    const have = (report.audio || []).find((row) => row.pid === pid && row.peak && row.peak.length);
    if (have || !file) {
      if (!file && !have) {
        el(doc, "timelineDetail").textContent = "Drop the matching .ts to decode audio PID " + pid + ".";
      }
      return;
    }
    if (!decoder) decoder = opts.createDecoder ? opts.createDecoder() : null;
    if (!decoder) {
      el(doc, "timelineDetail").textContent = "This build has no FFmpeg core, so the waveform is not decoded here.";
      return;
    }
    decoder.cancel();
    try {
      const wave = await decoder.decode(file, pid, report, (status) => {
        el(doc, "timelineDetail").textContent = status && status.text ? status.text : String(status);
      });
      report.audio = (report.audio || []).filter((row) => row.pid !== pid).concat(wave);
      const loud = wave.loudness;
      el(doc, "timelineDetail").textContent = "Audio PID " + pid
        + (loud
          ? " · I " + lufsText(loud.integrated) + " · LRA " + (loud.lra || 0).toFixed(1) + " LU"
            + (loud.truePeakDb !== null ? " · true peak " + loud.truePeakDb.toFixed(1) + " dBFS" : "")
          : " · peak " + dbText(wave.peakDb))
        + (wave.chunked ? " · decoded in chunks" : "");
      drawTimelineBar();
    } catch (err) {
      if (String(err && err.message) === "cancelled") return;
      el(doc, "timelineDetail").textContent = String(err && err.message ? err.message : err);
    }
  }

  function showSubtitle(row) {
    const detail = el(doc, "timelineDetail");
    const canvas = el(doc, "timelineSub");
    if (row.kind === "teletext") {
      canvas.hidden = true;
      detail.textContent = row.label + "\n" + (row.text || "");
      return;
    }
    const picture = (report.subtitles || [])[row.subtitleIndex];
    if (!picture || !picture.pixels) {
      canvas.hidden = true;
      const why = picture && picture.note ? picture.note : "no pixel data in this display set";
      detail.textContent = "DVB subtitle at " + row.t.toFixed(3) + " s · " + why;
      return;
    }
    // The pixels carry their own transparency, so a mid-grey backdrop stands
    // in for the video behind them. Without a background an almost
    // transparent subtitle reads as an empty box.
    detail.textContent = "DVB subtitle at " + row.t.toFixed(3) + " s · "
      + picture.width + "×" + picture.height + " at "
      + (picture.bbox ? picture.bbox.x + "," + picture.bbox.y : "0,0")
      + " of " + (picture.pageWidth || picture.width) + "×" + (picture.pageHeight || picture.height);
    canvas.hidden = false;
    paintSubtitle(canvas, picture);
  }

  function namesMatch(dropped) {
    if (!reportFile || !reportFile.name || !dropped.name) return true;
    return reportFile.name === dropped.name;
  }

  function attachTransport(dropped) {
    if (reportFile && reportFile.bytes && dropped.size !== reportFile.bytes) {
      fail("This file is " + dropped.size + " bytes. The report was made from " + reportFile.bytes + ".");
      return;
    }
    if (!namesMatch(dropped)) {
      fail("This file is named " + dropped.name + ". The report was made from " + reportFile.name + ".");
      return;
    }
    file = dropped;
    el(doc, "timelineDetail").textContent = "Attached " + dropped.name + " for packet view and audio decode.";
    showPacket(0);
  }

  async function importReportFile(dropped) {
    let parsed;
    try {
      parsed = JSON.parse(await dropped.text());
      const opened = openReport(parsed);
      file = null;
      reportFile = opened.file;
      if (worker) worker.terminate();
      worker = null;
      render(opened.report);
      const note = reportFile && reportFile.name
        ? "Report for " + reportFile.name + ". Drop that .ts to view packets."
        : "Report imported. Drop the matching .ts to view packets.";
      el(doc, "timelineDetail").textContent = note;
    } catch (err) {
      fail(String(err && err.message ? err.message : err));
    }
  }

  function analyze(nextFile) {
    file = nextFile;
    reportFile = null;
    if (worker) worker.terminate();
    worker = opts.createWorker();
    setBusy(true);
    bar.style.width = "0%";
    plabel.textContent = "Reading " + file.name;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "progress") {
        const pct = msg.total ? Math.min(100, 100 * msg.bytes / msg.total) : 0;
        bar.style.width = pct.toFixed(1) + "%";
        plabel.textContent = msg.packets.toLocaleString() + " packets";
      } else if (msg.type === "report") {
        setBusy(false);
        render(msg.report);
      } else if (msg.type === "error") {
        fail(msg.message);
      } else if (msg.type === "cancelled") {
        setBusy(false);
        plabel.textContent = "Cancelled";
      }
    };
    worker.postMessage({ type: "analyze", file });
  }

  fileInput.onchange = () => {
    const picked = fileInput.files && fileInput.files[0];
    if (!picked) return;
    if (/\.json$/i.test(picked.name)) importReportFile(picked);
    else analyze(picked);
  };
  cancelBtn.onclick = () => {
    if (worker) worker.postMessage({ type: "cancel" });
  };
  jsonBtn.onclick = () => {
    if (report) download((file && file.name || reportFile && reportFile.name || "stream") + ".json", "application/json", reportJson(report, {
      name: (file && file.name) || (reportFile && reportFile.name) || "",
      bytes: (file && file.size) || (reportFile && reportFile.bytes) || 0,
    }));
  };
  csvBtn.onclick = () => {
    if (report) download("bitrate.csv", "text/csv", bitrateCsv(report.bitrate, view.x0, view.x1));
  };
  htmlBtn.onclick = () => {
    if (report) download((file && file.name || "stream") + ".report.html", "text/html", reportHtml(report));
  };
  el(doc, "tabs").onclick = (event) => {
    const btn = event.target.closest("[data-tab]");
    if (btn) selectTab(btn.dataset.tab);
  };
  el(doc, "subList").onclick = (event) => {
    const btn = event.target.closest("[data-page]");
    if (!btn || !report) return;
    const page = (report.teletext || [])[Number(btn.dataset.page)];
    if (page) el(doc, "subText").textContent = page.text;
  };
  el(doc, "pktGo").onclick = () => {
    const n = Number(el(doc, "pktIndex").value);
    if (Number.isFinite(n) && n >= 0) showPacket(n | 0);
  };
  out.onclick = (event) => {
    const row = event.target.closest("tr");
    if (!row || row.dataset.pkt === undefined || row.dataset.pkt === "") return;
    const index = Number(row.dataset.pkt);
    if (index >= 0) {
      selectTab("packet");
      showPacket(index);
    }
  };

  const canvas = el(doc, "rate");
  canvas.onmousemove = (event) => {
    if (!report) return;
    if (view.drag) {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const span = report.bitrate.steps;
      const b = Math.round((x / rect.width) * span);
      view.x1 = Math.max(view.drag + 1, Math.min(span, b));
      view.x0 = Math.min(view.drag, b);
      drawStacked(canvas, report.bitrate, view);
      return;
    }
    view.hover = hoverBin(canvas, report.bitrate, view, event);
    drawStacked(canvas, report.bitrate, view);
  };
  canvas.onmousedown = (event) => {
    if (!report) return;
    view.drag = hoverBin(canvas, report.bitrate, view, event) || 0;
  };
  canvas.onmouseup = () => { view.drag = null; };
  canvas.onmouseleave = () => {
    view.hover = null;
    view.drag = null;
    if (report) drawStacked(canvas, report.bitrate, view);
  };
  canvas.ondblclick = () => {
    if (!report) return;
    view.x0 = 0;
    view.x1 = report.bitrate.steps;
    drawStacked(canvas, report.bitrate, view);
  };
  doc.body.addEventListener("dragover", (event) => { event.preventDefault(); });
  doc.body.addEventListener("drop", (event) => {
    event.preventDefault();
    const dropped = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!dropped) return;
    if (/\.json$/i.test(dropped.name)) importReportFile(dropped);
    else if (report && !file && reportFile) attachTransport(dropped);
    else analyze(dropped);
  });
  window.addEventListener("resize", () => {
    if (!report) return;
    drawCharts();
    const band = el(doc, "timelineBar");
    if (band && band.hidden) return;
    drawTimelineBar();
  });
  const timelineCanvas = el(doc, "mediaTimeline");
  const canvasX = (event) => event.clientX - timelineCanvas.getBoundingClientRect().left;

  // Drag pans the window. Shift-drag selects a range, which zooms to it.
  // A press that never moves is a click on a still, subtitle, or cue.
  let gesture = null;
  let suppressClick = false;

  function anchorTime(event) {
    const at = timeAtX(timelineCanvas, canvasX(event));
    return at && at.inside ? at.t : null;
  }

  function zoomFromWheel(event) {
    if (!report) return;
    // A trackpad pinch arrives as a wheel with ctrl held. Zoom about the
    // pointer in that case, about the middle of the window otherwise.
    const factor = Math.exp(-event.deltaY * 0.0022);
    zoomBy(factor, anchorTime(event));
  }

  timelineCanvas.onclick = (event) => {
    if (!report) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const hit = hitTimeline(timelineCanvas, event);
    if (!hit || !hit.row) {
      if (hit && hit.lane.kind === "audio") showLevel(hit.t);
      return;
    }
    const row = hit.row;
    if (hit.lane.kind === "cue") {
      showCue(row);
      if (row.packetIndex >= 0) showPacket(row.packetIndex);
      return;
    }
    if (hit.lane.kind === "thumbs") {
      const img = new Image();
      img.src = "data:image/jpeg;base64," + row.jpeg;
      const detail = el(doc, "timelineDetail");
      detail.textContent = "";
      img.style.maxWidth = "320px";
      img.style.borderRadius = "6px";
      detail.appendChild(img);
    } else if (hit.lane.kind === "caption") {
      const detail = el(doc, "timelineDetail");
      detail.textContent = "Caption " + row.t.toFixed(2) + " s to " + (row.t1 || row.t).toFixed(2) + " s\n" + (row.text || "");
    } else if (hit.lane.kind === "subtitle") {
      const sub = (report.subtitles || []).find((p) => p.packetIndex === row.packetIndex) || {};
      showSubtitle({ ...row, subtitleIndex: row.subtitleIndex !== undefined ? row.subtitleIndex : (report.subtitles || []).indexOf(sub) });
    } else {
      el(doc, "timelineDetail").textContent = (row.label || row.frame || row.kind || "") + " at " + row.t.toFixed(3) + " s";
    }
    if (row.packetIndex >= 0) showPacket(row.packetIndex);
  };

  function showLevel(t) {
    const lanes = timelineCanvas._lanes || [];
    const audio = lanes.filter((lane) => lane.kind === "audio");
    if (!audio.length) return;
    const bits = [t.toFixed(3) + " s"];
    for (const lane of audio) {
      const level = levelAt(lane.wave, t);
      if (!level) continue;
      const loud = lane.wave && lane.wave.loudness;
      bits.push("PID " + lane.pid + " peak " + dbText(level.peakDb));
      if (level.momentary !== null && level.momentary !== undefined) bits.push("M " + lufsText(level.momentary));
      if (level.shortTerm !== null && level.shortTerm !== undefined) bits.push("S " + lufsText(level.shortTerm));
      if (loud && Number.isFinite(loud.integrated)) bits.push("I " + lufsText(loud.integrated));
    }
    el(doc, "timelineDetail").textContent = bits.join(" · ");
  }

  timelineCanvas.ondblclick = () => {
    if (!report) return;
    timelineView.t0 = 0;
    timelineView.t1 = duration();
    drawTimelineBar();
  };

  timelineCanvas.onpointerdown = (event) => {
    if (!report) return;
    if (event.button !== undefined && event.button !== 0) return;
    const x = canvasX(event);
    gesture = {
      mode: event.shiftKey ? "range" : "pan",
      x0: x,
      x1: x,
      t0: timelineView.t0,
      t1: timelineView.t1,
      moved: false,
      pointerId: event.pointerId,
    };
    if (timelineCanvas.setPointerCapture) {
      try { timelineCanvas.setPointerCapture(event.pointerId); } catch (err) { /* not capturable */ }
    }
    event.preventDefault();
  };

  timelineCanvas.onpointermove = (event) => {
    if (!report) return;
    const x = Math.max(timelineCanvas._layout ? timelineCanvas._layout.ml : 0, canvasX(event));
    timelineView.hoverX = x;
    if (gesture) {
      gesture.x1 = x;
      if (Math.abs(gesture.x1 - gesture.x0) > 3) gesture.moved = true;
      if (gesture.mode === "range" && gesture.moved) {
        const a = timeAtX(timelineCanvas, gesture.x0);
        const b = timeAtX(timelineCanvas, x);
        const top = timelineCanvas._layout ? timelineCanvas._layout.top : 6;
        const floor = (timelineCanvas.clientHeight || 120) - 24;
        drawMediaTimeline(timelineCanvas, report, timelineView);
        const ctx = timelineCanvas.getContext("2d");
        ctx.save();
        ctx.fillStyle = "#d6249f";
        ctx.globalAlpha = 0.16;
        const left = Math.min(gesture.x0, x);
        const wide = Math.abs(x - gesture.x0);
        ctx.fillRect(left, top, wide, Math.max(1, floor - top));
        ctx.restore();
        if (a && b) el(doc, "timelineDetail").textContent = "Select " + rangeText(Math.min(a.t, b.t), Math.max(a.t, b.t));
        return;
      }
      if (gesture.mode === "pan" && gesture.moved) {
        const layout = timelineCanvas._layout;
        const plotW = layout && layout.plotW ? layout.plotW : 1;
        const span = gesture.t1 - gesture.t0;
        const dt = -((x - gesture.x0) / plotW) * span;
        const next = panSpan(gesture.t0, gesture.t1, dt, duration());
        timelineView.t0 = next.t0;
        timelineView.t1 = next.t1;
      }
    }
    drawMediaTimeline(timelineCanvas, report, timelineView);
    showSpan();
  };

  timelineCanvas.onpointerup = (event) => {
    if (!gesture) return;
    const finished = gesture;
    gesture = null;
    if (timelineCanvas.releasePointerCapture) {
      try { timelineCanvas.releasePointerCapture(event.pointerId); } catch (err) { /* already gone */ }
    }
    if (!finished.moved) return;
    suppressClick = true;
    if (finished.mode === "range") {
      const a = timeAtX(timelineCanvas, finished.x0);
      const b = timeAtX(timelineCanvas, finished.x1);
      if (a && b && Math.abs(b.t - a.t) > 0.001) {
        timelineView.t0 = Math.max(0, Math.min(a.t, b.t));
        timelineView.t1 = Math.min(duration(), Math.max(a.t, b.t));
      }
      drawTimelineBar();
      return;
    }
    drawTimelineBar();
  };

  timelineCanvas.onpointercancel = () => { gesture = null; };

  timelineCanvas.onpointerleave = () => {
    if (!report || gesture) return;
    timelineView.hoverX = null;
    drawMediaTimeline(timelineCanvas, report, timelineView);
  };

  // Two fingers on a touch screen zoom, as the trackpad pinch does.
  let pinch = null;
  function touchDistance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
  }
  timelineCanvas.ontouchstart = (event) => {
    if (!report || event.touches.length !== 2) return;
    const rect = timelineCanvas.getBoundingClientRect();
    const mid = (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left;
    pinch = { dist: touchDistance(event.touches[0], event.touches[1]), t: anchorTime(event), mid };
    event.preventDefault();
  };
  timelineCanvas.ontouchmove = (event) => {
    if (!report || !pinch || event.touches.length !== 2) return;
    const dist = touchDistance(event.touches[0], event.touches[1]);
    const factor = dist / pinch.dist;
    if (factor < 0.98 || factor > 1.02) {
      zoomBy(factor, pinch.t);
      pinch.dist = dist;
    }
    event.preventDefault();
  };
  timelineCanvas.ontouchend = () => { pinch = null; };

  timelineCanvas.onwheel = (event) => {
    if (!report) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomFromWheel(event);
      return;
    }
    const dx = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const span = timelineView.t1 - timelineView.t0;
    panBy((dx / Math.max(1, timelineCanvas.clientWidth || 800)) * span);
  };

  timelineCanvas.onkeydown = (event) => {
    if (!report) return;
    const span = timelineView.t1 - timelineView.t0;
    if (event.key === "+" || event.key === "=") zoomBy(1.6);
    else if (event.key === "-" || event.key === "_") zoomBy(1 / 1.6);
    else if (event.key === "0") {
      timelineView.t0 = 0;
      timelineView.t1 = duration();
      drawTimelineBar();
    } else if (event.key === "ArrowLeft") panBy(-span * 0.25);
    else if (event.key === "ArrowRight") panBy(span * 0.25);
    else if (event.key === "Home") panBy(-duration());
    else if (event.key === "End") panBy(duration());
    else return;
    event.preventDefault();
  };

  // Wheel over the bar zooms there too, so the whole strip behaves like a
  // map. The listener has to be non-passive to stop the page scrolling.
  const timelineBar = el(doc, "timelineBar");
  if (timelineBar && timelineBar.addEventListener) {
    timelineBar.addEventListener("wheel", (event) => {
      if (!report || event.target === timelineCanvas) return;
      if (!event.shiftKey && !event.ctrlKey) return;
      event.preventDefault();
      zoomFromWheel(event);
    }, { passive: false });
  }

  // The grip drags the bar taller, up to half the viewport.
  const grip = el(doc, "timelineGrip");
  if (grip) {
    let sizing = null;
    grip.onpointerdown = (event) => {
      if (!report) return;
      timelineView.manual = true;
      sizing = { y: event.clientY, height: timelineView.height || timelineCanvas.clientHeight || 240 };
      if (grip.setPointerCapture) {
        try { grip.setPointerCapture(event.pointerId); } catch (err) { /* not capturable */ }
      }
      event.preventDefault();
    };
    grip.onpointermove = (event) => {
      if (!sizing) return;
      const limit = Math.max(140, Math.round((window.innerHeight || 800) * 0.62));
      const next = Math.max(200, Math.min(limit, sizing.height - (event.clientY - sizing.y)));
      if (next === timelineView.height) return;
      timelineView.height = next;
      drawMediaTimeline(timelineCanvas, report, timelineView);
    };
    grip.onpointerup = () => { sizing = null; };
    grip.onpointercancel = () => { sizing = null; };
  }

  if (el(doc, "thumbLoad")) el(doc, "thumbLoad").onclick = () => loadThumbs();
  if (el(doc, "ccRun")) el(doc, "ccRun").onclick = () => runCaptions();
  if (el(doc, "ccSave")) {
    el(doc, "ccSave").onclick = () => {
      if (toolState.captions && toolState.captions.srt) download(captionName(), "text/plain;charset=utf-8", toolState.captions.srt);
    };
  }
  if (el(doc, "ttRun")) el(doc, "ttRun").onclick = () => runTeletext();
  if (el(doc, "ttSave")) {
    el(doc, "ttSave").onclick = () => {
      const row = toolState.teletext.find((r) => r.cues.length);
      if (!row) return;
      const base = (file && file.name ? file.name : "teletext").replace(/\.[^.]+$/, "");
      download(base + ".page" + row.page + ".srt", "text/plain;charset=utf-8", row.srt);
    };
  }
  if (el(doc, "zoomIn")) el(doc, "zoomIn").onclick = () => zoomBy(1.8);
  if (el(doc, "zoomOut")) el(doc, "zoomOut").onclick = () => zoomBy(1 / 1.8);
  if (el(doc, "zoomReset")) {
    el(doc, "zoomReset").onclick = () => {
      if (!report) return;
      timelineView.t0 = 0;
      timelineView.t1 = duration();
      drawTimelineBar();
    };
  }
  const themeBar = el(doc, "theme");
  if (themeBar) {
    themeBar.onclick = () => chooseTheme(nextTheme(doc));
  }
  onThumbnailLoad(() => drawTimelineBar());
  chooseTheme(readTheme(doc));
  selectTab("overview");
}
