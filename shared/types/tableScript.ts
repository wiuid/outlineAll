import type { TableDocumentContent } from "../utils/tableDocument";

/** Resource limits shared by the editor, API and isolated execution service. */
export const TableScriptLimits = {
  sourceLength: 64 * 1024,
  outputBytes: 64 * 1024,
  executionMs: 60 * 1000,
  terminationMs: 25 * 1000,
  concurrency: 2,
  scriptsPerDocument: 50,
  httpRequests: 20,
  httpBodyBytes: 256 * 1024,
  httpResponseBytes: 1024 * 1024,
  httpTimeoutMs: 15000,
};

/** One authorized snapshot; the runner never receives database credentials. */
export interface TableScriptInput {
  id: string;
  source: string;
  document: {
    id: string;
    title: string;
    revision: number;
    table: TableDocumentContent;
  };
}

/** The lifecycle of one execution; failed executions are never rescheduled. */
export type TableScriptRunStatus =
  | "queued"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Metadata visible to an authorized developer of the containing document. */
export interface TableScriptSummary {
  id: string;
  documentId: string;
  name: string;
  revision: number;
  cron: string | null;
  timezone: string;
  scheduleEnabled: boolean;
  nextRunAt: string | null;
  createdById: string | null;
  updatedAt: string;
  createdAt: string;
}

/** Script source is loaded separately from list metadata. */
export interface TableScriptDetails extends TableScriptSummary {
  source: string;
}

/** A durable execution record, without credentials or a copy of its source. */
export interface TableScriptExecution {
  id: string;
  scriptId: string;
  scriptRevision: number;
  documentRevision: number | null;
  status: TableScriptRunStatus;
  trigger: "manual" | "schedule";
  output: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** Availability is checked by the server independently of document editing. */
export interface TableScriptCapabilities {
  canDevelop: boolean;
  executionEnabled: boolean;
  executionSeconds: number;
}

/** A terminal result returned by the isolated execution service. */
export interface TableScriptResult {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  output: string;
}

/** A useful first script that reads data without sending any external message. */
export const defaultTableScript = `from outline import workbook
import json
import requests

sheet = workbook.sheet(0)
rows = sheet.range("A1:D10").values
print(json.dumps(rows, ensure_ascii=False, indent=2))

# Use requests for any HTTP API; choose the URL and payload in your code.
# response = requests.post("https://example.com/api", json={"text": str(rows)}, timeout=10)
# response.raise_for_status()
`;
