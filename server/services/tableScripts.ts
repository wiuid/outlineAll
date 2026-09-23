import {
  claimTableScriptRun,
  expireTableScriptRuns,
  performTableScriptRun,
  scheduleDueTableScripts,
} from "@server/commands/tableScriptExecutor";
import { toError } from "@shared/utils/error";
import Logger from "@server/logging/Logger";
import { getTableScriptExecutionConfig } from "@server/utils/tableScriptConfig";

/**
 * Starts the separate script dispatcher only when an isolated runner is set up.
 *
 * @returns without starting background work when execution is disabled.
 */
export function initTableScripts(): void {
  if (!getTableScriptExecutionConfig().executionEnabled) {
    return;
  }
  let polling = false;
  let lastMaintenance = 0;
  const tick = async () => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      if (Date.now() - lastMaintenance >= 10000) {
        await expireTableScriptRuns();
        lastMaintenance = Date.now();
      }
      await scheduleDueTableScripts();
      const run = await claimTableScriptRun();
      if (run) {
        void performTableScriptRun(run).catch((error: unknown) => {
          Logger.error(
            "Unable to persist script execution result",
            toError(error),
            { runId: run.id }
          );
        });
      }
    } catch (error) {
      Logger.warn("Script dispatcher could not check pending work", {
        error: toError(error).message,
      });
    } finally {
      polling = false;
    }
  };
  setInterval(() => void tick(), 1000).unref();
  void tick();
}

export default initTableScripts;
