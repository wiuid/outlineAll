import type { ICellData, IWorksheetData } from "@univerjs/core";
import { CSVHelper } from "./csv";

/**
 * Exports worksheet values as Excel-compatible CSV without formulas or images.
 *
 * @param sheet the current worksheet snapshot.
 * @returns UTF-8 CSV text with a byte order mark.
 * @throws when the used range exceeds one million cells.
 */
export function worksheetToCSV(
  sheet: Pick<IWorksheetData, "cellData">
): string {
  const values = new Map<number, Map<number, string>>();
  let lastRow = -1;
  let lastColumn = -1;
  for (const [rowKey, cells] of Object.entries(sheet.cellData ?? {})) {
    const row = Number(rowKey);
    if (!Number.isSafeInteger(row) || row < 0 || !cells) {
      continue;
    }
    for (const [columnKey, cell] of Object.entries(cells)) {
      const column = Number(columnKey);
      if (!Number.isSafeInteger(column) || column < 0 || !cell) {
        continue;
      }
      const value = cellText(cell);
      if (value === "") {
        continue;
      }
      let rowValues = values.get(row);
      if (!rowValues) {
        rowValues = new Map();
        values.set(row, rowValues);
      }
      rowValues.set(column, value);
      lastRow = Math.max(lastRow, row);
      lastColumn = Math.max(lastColumn, column);
    }
  }
  if ((lastRow + 1) * (lastColumn + 1) > 1_000_000) {
    throw new Error("The worksheet is too large to export as CSV.");
  }
  const rows: string[] = [];
  for (let row = 0; row <= lastRow; row++) {
    const fields: string[] = [];
    for (let column = 0; column <= lastColumn; column++) {
      const value = values.get(row)?.get(column) ?? "";
      // Leading whitespace must not bypass spreadsheet formula protection.
      const safeValue = /^[\s]*[=+\-@]/u.test(value)
        ? `'${value}`
        : CSVHelper.sanitizeValue(value);
      fields.push(`"${safeValue.replace(/"/g, '""')}"`);
    }
    rows.push(fields.join(","));
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

function cellText(cell: ICellData): string {
  if (cell.p?.body?.dataStream) {
    return cell.p.body.dataStream.replace(/\r\n$/, "");
  }
  return cell.v === null || cell.v === undefined ? "" : String(cell.v);
}
