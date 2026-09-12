import {
  BooleanNumber,
  CellValueType,
  LocaleType,
  WrapStrategy,
} from "@univerjs/core";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { v4 as uuid } from "uuid";
import type { TableCell } from "@shared/utils/lightweightTable";
import {
  type TableDocumentContent,
  type UniverTable,
  UniverTableSchema,
} from "@shared/utils/tableDocument";

/**
 * Creates a workbook using Univer's native document model.
 *
 * @param name the document title.
 * @param sheetName the initial worksheet name.
 * @returns an editable workbook with room to grow using Univer's own commands.
 */
export function createTableWorkbook(
  name: string,
  sheetName = "Sheet1"
): IWorkbookData {
  const sheetId = uuid();
  return {
    id: uuid(),
    name,
    appVersion: "0.25.1",
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: sheetName,
        rowCount: 1000,
        columnCount: 26,
        cellData: {},
      },
    },
  };
}

/**
 * Opens native workbooks or adapts the original single-sheet format losslessly.
 *
 * @param table the saved table in either supported format.
 * @param title the Outline document title, used for legacy workbooks.
 * @returns a detached snapshot suitable for Univer initialization.
 */
export function getTableWorkbook(
  table: TableDocumentContent,
  title: string
): IWorkbookData {
  if (table.version === 2) {
    return snapshotTable(table.workbook).workbook;
  }
  const workbook = createTableWorkbook(title);
  const cellData: IWorksheetData["cellData"] = {};
  const rowData: IWorksheetData["rowData"] = {};
  const columnData: IWorksheetData["columnData"] = {};
  table.rows.forEach((row, rowIndex) => {
    cellData[rowIndex] = Object.fromEntries(
      row.cells.map((cell, columnIndex) => [columnIndex, convertCell(cell)])
    );
    if (row.height !== undefined) {
      rowData[rowIndex] = { h: row.height };
    }
  });
  table.columns.forEach((column, index) => {
    if (column.width !== undefined) {
      columnData[index] = { w: column.width };
    }
  });
  Object.assign(workbook.sheets[workbook.sheetOrder[0]], {
    cellData,
    rowData,
    columnData,
  });
  return workbook;
}

/**
 * Detaches Univer's snapshot and normalizes optional fields to JSON semantics.
 *
 * @param workbook the current native snapshot.
 * @returns the versioned table payload with all native fields preserved.
 * @throws {Error} if the snapshot cannot be represented by the supported format.
 */
export function snapshotTable(workbook: IWorkbookData): UniverTable {
  return UniverTableSchema.parse(
    JSON.parse(
      JSON.stringify({
        format: "outline-table",
        version: 2,
        workbook,
      })
    )
  );
}

function convertCell(cell: TableCell): ICellData {
  const result: ICellData =
    "formula" in cell
      ? { f: cell.formula }
      : {
          v: cell.value,
          t:
            typeof cell.value === "number"
              ? CellValueType.NUMBER
              : typeof cell.value === "boolean"
                ? CellValueType.BOOLEAN
                : CellValueType.STRING,
        };
  if (cell.style) {
    const { bold, italic, color, background, wrap } = cell.style;
    result.s = {
      ...(bold !== undefined && {
        bl: bold ? BooleanNumber.TRUE : BooleanNumber.FALSE,
      }),
      ...(italic !== undefined && {
        it: italic ? BooleanNumber.TRUE : BooleanNumber.FALSE,
      }),
      ...(color && { cl: { rgb: color } }),
      ...(background && { bg: { rgb: background } }),
      ...(wrap !== undefined && {
        tb: wrap ? WrapStrategy.WRAP : WrapStrategy.CLIP,
      }),
    };
  }
  return result;
}
