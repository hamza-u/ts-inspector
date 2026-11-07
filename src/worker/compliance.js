// One pass/fail/not-measured row per check. Counts and the first packet
// come from the modules that already measured them.

const TR_CLAUSE = {
  TS_sync_loss: "TR 101 290 1.1",
  Sync_byte_error: "TR 101 290 1.2",
  PAT_error: "TR 101 290 1.3",
  Continuity_count_error: "TR 101 290 1.4",
  PMT_error: "TR 101 290 1.5",
  PID_error: "TR 101 290 1.6",
  Transport_error: "TR 101 290 2.1",
  CRC_error: "TR 101 290 2.2",
  PCR_repetition_error: "TR 101 290 2.3",
  PCR_discontinuity_error: "TR 101 290 2.3",
  PCR_accuracy_error: "TR 101 290 2.4 / H.222.0 ±500 ns",
  PTS_error: "TR 101 290 2.5",
  CAT_error: "TR 101 290 2.6",
  Datagram_gap: "arrival time, not measured on a file",
  NIT_error: "TR 101 290 3.1",
  SI_repetition_error: "TR 101 290 3.2",
  Unreferenced_PID: "TR 101 290 3.3",
  SDT_error: "TR 101 290 3.4",
  EIT_error: "TR 101 290 3.5",
  RST_error: "TR 101 290 3.6",
  TDT_error: "TR 101 290 3.6",
  Buffer_error: "TR 101 290 3.8 / H.222.0 2.14.3.1",
  Empty_buffer_error: "TR 101 290 3.9 / H.222.0 2.14.3.1",
  Data_delay_error: "TR 101 290 3.10 / H.222.0 2.14.3.1",
};

const PRIO = {
  TS_sync_loss: 1, Sync_byte_error: 1, PAT_error: 1, Continuity_count_error: 1,
  PMT_error: 1, PID_error: 1,
  Transport_error: 2, CRC_error: 2, PCR_repetition_error: 2, PCR_discontinuity_error: 2,
  PCR_accuracy_error: 2, PTS_error: 2, CAT_error: 2, Datagram_gap: 2,
};

function row(group, name, state, count, packetIndex, clause, detail) {
  return {
    group, name, state, count: count || 0,
    packetIndex: packetIndex === undefined || packetIndex === null ? -1 : packetIndex,
    clause, detail: detail || "",
  };
}

export function buildCompliance(report) {
  const rows = [];
  const checks = (report.tr290 && report.tr290.checks) || {};
  const events = report.events || [];
  for (const [name, count] of Object.entries(checks)) {
    const first = events.find((e) => e.name === name);
    let state = count ? "fail" : "pass";
    if (name === "Datagram_gap" || name === "CAT_error") state = "na";
    const prio = PRIO[name] || 3;
    rows.push(row(
      "TR 101 290 P" + prio,
      name,
      state,
      count,
      first ? first.packetIndex : -1,
      TR_CLAUSE[name] || "TR 101 290",
      first ? first.detail : "",
    ));
  }
  const hrd = report.hrd;
  if (!hrd || !hrd.modelled) {
    rows.push(row("HRD", "Annex C", "na", 0, -1, "H.264 Annex C", "No H.264 HRD parameters"));
  } else {
    const bad = (hrd.counts.underflowPlan || 0) + (hrd.counts.overflowPlan || 0);
    rows.push(row(
      "HRD",
      "CPB underflow/overflow",
      bad ? "fail" : "pass",
      bad,
      -1,
      "H.264 Annex C",
      "underflow " + hrd.counts.underflowPlan + ", overflow " + hrd.counts.overflowPlan,
    ));
    rows.push(row(
      "HRD",
      "Wire lead under 0 ms",
      hrd.counts.wireLeadLt0 ? "fail" : "pass",
      hrd.counts.wireLeadLt0 || 0,
      -1,
      "H.264 Annex C / H.222.0",
      "DTS before the first TS packet of the access unit",
    ));
  }
  const tstd = report.tstd;
  if (!tstd || !tstd.modelled) {
    rows.push(row("T-STD", "TB MB EB", "na", 0, -1, "H.222.0 2.14.3.1", "No modelled H.264 buffer"));
  } else {
    const c = tstd.counts || {};
    const n = (c.tb_overflow || 0) + (c.mb_overflow || 0) + (c.eb_overflow || 0)
      + (c.eb_underflow || 0) + (c.tb_not_empty || 0) + (c.data_delay || 0);
    const first = (tstd.events || [])[0];
    rows.push(row(
      "T-STD",
      tstd.method === "hrd" ? "HRD-managed TB/MB/EB" : "Leak-method TB/MB/EB",
      n ? "fail" : "pass",
      n,
      first ? first.packetIndex : -1,
      "H.222.0 2.14.3.1",
      tstd.method === "hrd" ? "MB to EB follows the HRD" : "MB leaks into EB at Rbx",
    ));
  }
  const pcr = report.pcrAccuracy;
  if (!pcr || !pcr.count) {
    rows.push(row("PCR", "PCR_AC", "na", 0, -1, "H.222.0 ±500 ns", "No PCR"));
  } else {
    rows.push(row(
      "PCR",
      "PCR_AC",
      pcr.overLimit ? "fail" : "pass",
      pcr.overLimit,
      pcr.firstPacket,
      "H.222.0 ±500 ns",
      pcr.overLimit ? "first " + Math.round(pcr.firstNs) + " ns" : "within ±500 ns",
    ));
  }
  rows.push(row("PCR", "PCR_OJ / drift", "na", 0, -1, "TR 101 290", pcr && pcr.arrivalNote ? pcr.arrivalNote : "Needs arrival time"));
  const fail = rows.filter((r) => r.state === "fail").length;
  const pass = rows.filter((r) => r.state === "pass").length;
  const na = rows.filter((r) => r.state === "na").length;
  return { rows, pass, fail, na };
}

