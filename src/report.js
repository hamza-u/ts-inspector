// Shared by the page and the headless command. A report file is either
// this envelope or an older bare report that already has summary and tr290.

export const SCHEMA = "ts-inspector-report";
export const VERSION = 1;
export const TOOL_VERSION = "0.1.0";

export function wrapReport(report, file) {
  return {
    schema: SCHEMA,
    version: VERSION,
    tool: TOOL_VERSION,
    file: {
      name: (file && file.name) || report.fileName || "",
      bytes: (file && file.bytes) || 0,
      analyzedAt: new Date().toISOString(),
    },
    report,
  };
}

export function openReport(data) {
  if (!data || typeof data !== "object") {
    throw new Error("not a TS Inspector report");
  }
  if (data.schema === SCHEMA) {
    if (Number(data.version) !== VERSION) {
      throw new Error("unsupported report version " + data.version);
    }
    if (!data.report || !data.report.summary) {
      throw new Error("report is missing");
    }
    return { report: data.report, file: data.file || null };
  }
  if (data.summary && data.tr290) return { report: data, file: null };
  throw new Error("not a TS Inspector report");
}
