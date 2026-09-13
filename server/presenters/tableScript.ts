import type {
  TableScriptDetails,
  TableScriptExecution,
  TableScriptSummary,
} from "@shared/types/tableScript";
import type { TableScript, TableScriptRun } from "@server/models";

/**
 * Presents metadata without decrypting or listing Python source.
 *
 * @param script the authorized script.
 * @returns its editor and scheduling metadata.
 */
export function presentTableScriptSummary(
  script: TableScript
): TableScriptSummary {
  return {
    id: script.id,
    documentId: script.documentId,
    name: script.name,
    revision: script.revision,
    cron: script.cron,
    timezone: script.timezone,
    scheduleEnabled: script.scheduleEnabled,
    nextRunAt: script.nextRunAt?.toISOString() ?? null,
    createdById: script.createdById,
    createdAt: script.createdAt.toISOString(),
    updatedAt: script.updatedAt.toISOString(),
  };
}

/**
 * Presents code only after both developer and document access checks.
 *
 * @param script the authorized script.
 * @returns the script and decrypted source for its editor.
 */
export function presentTableScript(script: TableScript): TableScriptDetails {
  return { ...presentTableScriptSummary(script), source: script.source };
}

/**
 * Presents an execution without exposing its submitted source or runner token.
 *
 * @param run the authorized execution.
 * @returns the execution state and bounded console output.
 */
export function presentTableScriptRun(
  run: TableScriptRun
): TableScriptExecution {
  return {
    id: run.id,
    scriptId: run.scriptId,
    scriptRevision: run.scriptRevision,
    documentRevision: run.documentRevision,
    status: run.status,
    trigger: run.trigger,
    output: run.output,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}
