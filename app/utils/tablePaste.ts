import { CellValueType } from "@univerjs/core";
import type { ICellData, Nullable } from "@univerjs/core";
import type { TableCSVImport } from "./tableCSVImport";

/** A reviewed text paste, bound to its original destination and cell contents. */
export interface TablePastePreview {
  destination: string;
  occupiedCells: number;
  apply: () => Promise<void>;
}

/** A destination captured before the paste dialog takes keyboard focus. */
export interface TablePasteTarget {
  prepare: (data: TableCSVImport) => TablePastePreview;
}

/**
 * Builds literal text values while retaining destination formatting.
 *
 * @param data the bounded, parsed clipboard rows.
 * @param previous the destination cells used for the overwrite preview.
 * @returns rectangular values and the number of nonempty destination cells.
 */
export function buildTablePasteValues(
  data: TableCSVImport,
  previous: Nullable<ICellData>[][]
): { values: ICellData[][]; occupiedCells: number } {
  let occupiedCells = 0;
  const values = Array.from({ length: data.rowCount }, (_, row) =>
    Array.from({ length: data.columnCount }, (_, column) => {
      const cell = previous[row]?.[column];
      if (
        cell?.f ||
        cell?.p ||
        cell?.si ||
        cell?.custom?.outlineImage ||
        (cell?.v !== null && cell?.v !== undefined && cell.v !== "")
      ) {
        occupiedCells++;
      }
      return {
        ...cell,
        v: data.rows[row]?.[column] ?? "",
        t: CellValueType.FORCE_STRING,
        f: null,
        p: null,
        si: null,
        ref: null,
        custom: { ...cell?.custom, outlineImage: null },
      };
    })
  );
  return { values, occupiedCells };
}
