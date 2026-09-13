// oxlint-disable-next-line no-restricted-imports -- Operator-configured private runner; bypass application proxy and webhook networking rules.
import fetch from "node-fetch";
import { z } from "zod";
import { TableScriptLimits } from "@shared/types/tableScript";
import type {
  TableScriptInput,
  TableScriptResult,
} from "@shared/types/tableScript";
import { requireTableScriptRunner } from "@server/commands/tableScriptManager";
import { TableScriptUnavailableError } from "@server/errors";
import { getTableScriptConfig } from "./tableScriptConfig";

export type { TableScriptInput } from "@shared/types/tableScript";

/**
 * Submits exactly one execution to the isolated service, without HTTP retries.
 *
 * @param input the execution UUID, source and authorized table data.
 * @returns the bounded terminal result.
 * @throws {TableScriptUnavailableError} when the isolated service cannot finish.
 */
export async function executeTableScript(
  input: TableScriptInput
): Promise<TableScriptResult> {
  requireTableScriptRunner();
  const { runnerUrl, runnerToken } = getTableScriptConfig();
  try {
    const response = await fetch(`${runnerUrl}/runs/${input.id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runnerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      redirect: "error",
      timeout: TableScriptLimits.executionMs + 15000,
      size: TableScriptLimits.outputBytes * 8 + 2048,
    });
    if (!response.ok) {
      throw TableScriptUnavailableError();
    }
    const result = resultSchema.parse(await response.json());
    if (Buffer.byteLength(result.output) > TableScriptLimits.outputBytes) {
      throw TableScriptUnavailableError();
    }
    return result;
  } catch {
    throw TableScriptUnavailableError();
  }
}

/**
 * Requests termination of an execution, including one still starting up.
 *
 * @param id the authorized execution UUID.
 * @throws {TableScriptUnavailableError} if termination was not acknowledged.
 */
export async function cancelTableScriptExecution(id: string): Promise<void> {
  requireTableScriptRunner();
  const { runnerUrl, runnerToken } = getTableScriptConfig();
  try {
    const response = await fetch(`${runnerUrl}/runs/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${runnerToken}` },
      redirect: "error",
      timeout: TableScriptLimits.terminationMs,
      size: 1024,
    });
    if (!response.ok) {
      throw TableScriptUnavailableError();
    }
  } catch {
    throw TableScriptUnavailableError();
  }
}

const resultSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
  output: z.string().max(TableScriptLimits.outputBytes),
});
