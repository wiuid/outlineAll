import type { ICellData, Nullable } from "@univerjs/core";
import Papa from "papaparse";

/** A confirmed clear operation bound to its original selection. */
export interface TableSelectionClear {
  destination: string;
  cellCount: number;
  apply: () => Promise<void>;
}

/**
 * Serializes displayed selection values for spreadsheet clipboard exchange.
 *
 * @param values the rectangular displayed values, including empty cells.
 * @returns tab-separated text with quoted multiline fields and formula protection.
 */
export function selectionToTSV(values: string[][]): string {
  return Papa.unparse(values, {
    delimiter: "\t",
    newline: "\r\n",
    escapeFormulae: /^[\s]*[=+\-@]/u,
  });
}

/**
 * Clears cell contents and embedded images while retaining formatting and metadata.
 *
 * @param cells the captured cells to clear.
 * @returns native cell values suitable for a single undoable command.
 */
export function clearTableSelectionValues(
  cells: Nullable<ICellData>[][]
): ICellData[][] {
  return cells.map((row) =>
    row.map((cell) => ({
      ...cell,
      v: null,
      t: null,
      f: null,
      p: null,
      si: null,
      ref: null,
      custom: { ...cell?.custom, outlineImage: null },
    }))
  );
}
