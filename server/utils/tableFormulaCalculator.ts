import { Worker } from "node:worker_threads";
import type { IWorkbookData } from "@univerjs/core";
import { UniverTableSchema } from "@shared/utils/tableDocument";
import { ValidationError } from "@server/errors";

let activeCalculations = 0;

/**
 * Recalculates native formulas in a bounded worker, keeping expensive workbook
 * calculations off the API event loop. Only the workbook enters the worker.
 *
 * @param snapshot the validated native snapshot to calculate.
 * @returns the calculated snapshot with all browser plugin resources retained.
 * @throws {ValidationError} if calculation exceeds its time or memory budget.
 */
export async function calculateTableFormulas(
  snapshot: IWorkbookData
): Promise<IWorkbookData> {
  if (activeCalculations >= 4) {
    throw ValidationError(
      "Spreadsheet calculation is busy. Please save again shortly."
    );
  }
  activeCalculations++;
  try {
    const calculated = await new Promise<IWorkbookData>((resolve, reject) => {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          snapshot,
          preset: require.resolve("@univerjs/preset-sheets-node-core"),
          presets: require.resolve("@univerjs/presets"),
        },
        env: {},
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      });
      // Native library diagnostics must not fill a worker's output pipe.
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const finish = (workbook?: IWorkbookData) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        void worker.terminate();
        if (workbook) {
          resolve(workbook);
        } else {
          reject(
            ValidationError(
              "Spreadsheet calculation could not finish. Your changes have not been saved."
            )
          );
        }
      };
      const timeout = setTimeout(() => finish(), 8000);
      worker.once("message", (workbook: object) => {
        const result = UniverTableSchema.safeParse({
          format: "outline-table",
          version: 2,
          workbook,
        });
        finish(result.success ? result.data.workbook : undefined);
      });
      worker.once("error", () => finish());
      worker.once("exit", () => finish());
    });
    const resources = new Map(
      (snapshot.resources ?? []).map((resource) => [resource.name, resource])
    );
    for (const resource of calculated.resources ?? []) {
      resources.set(resource.name, resource);
    }
    return { ...calculated, resources: [...resources.values()] };
  } finally {
    activeCalculations--;
  }
}

// This is fixed application code, never constructed from a formula or user text.
// Univer parses formulas with its native AST interpreter. Package paths are
// resolved by the parent, and the worker inherits no application environment.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { UniverSheetsNodeCorePreset } = require(workerData.preset);
const { createUniver } = require(workerData.presets);
const { univer, univerAPI } = createUniver({ locale: "enUS", presets: [UniverSheetsNodeCorePreset()] });
(async () => {
  try {
    const workbook = univerAPI.createWorkbook(workerData.snapshot);
    await univerAPI.getFormula().onCalculationResultApplied(6000);
    parentPort.postMessage(workbook.save());
  } finally {
    univer.dispose();
  }
})().catch(() => process.exit(1));
`;
