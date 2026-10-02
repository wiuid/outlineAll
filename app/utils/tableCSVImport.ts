import { CellValueType } from "@univerjs/core";
import type { IWorksheetData } from "@univerjs/core";
import Papa from "papaparse";

/** Parsed CSV text and dimensions, including internal blank rows and cells. */
export interface TableCSVImport {
  rows: string[][];
  rowCount: number;
  columnCount: number;
}

/** Maximum file size accepted by the table import dialog. */
export const TABLE_CSV_MAX_BYTES = 1024 * 1024;

/**
 * Parses bounded CSV or TSV without converting strings to numbers or formulas.
 *
 * @param text the decoded file contents.
 * @param delimiter the selected separator, or empty for automatic detection.
 * @returns the parsed rows and dimensions.
 * @throws when input is malformed, empty or exceeds import limits.
 */
export function parseTableCSV(text: string, delimiter = ""): TableCSVImport {
  if (text.length > TABLE_CSV_MAX_BYTES) {
    throw new Error("CSV files must be smaller than 1 MB.");
  }
  const result = Papa.parse<string[]>(text, {
    delimiter,
    delimitersToGuess: [",", "\t", ";"],
    dynamicTyping: false,
    skipEmptyLines: false,
    preview: 10_002,
  });
  if (result.errors.some((error) => error.code !== "UndetectableDelimiter")) {
    throw new Error("The CSV contains invalid quotes or incomplete fields.");
  }
  const rows = result.data;
  // A final line terminator does not represent an additional worksheet row.
  if (/[\r\n]$/.test(text) && rows.at(-1)?.every((value) => value === "")) {
    rows.pop();
  }
  if (!rows.some((row) => row.some((value) => value !== ""))) {
    throw new Error("The CSV contains no data.");
  }
  const columnCount = Math.max(...rows.map((row) => row.length));
  if (
    rows.length > 10_000 ||
    columnCount > 256 ||
    rows.length * columnCount > 50_000
  ) {
    throw new Error(
      "CSV imports support up to 10,000 rows, 256 columns and 50,000 cells."
    );
  }
  return { rows, rowCount: rows.length, columnCount };
}

/**
 * Builds a new worksheet with literal text cells and a unique, valid name.
 *
 * @param data the parsed CSV rows.
 * @param name the requested worksheet name.
 * @param existingNames the names already used in this workbook.
 * @returns the worksheet fields accepted by Univer's insert sheet command.
 */
export function createCSVWorksheet(
  data: TableCSVImport,
  name: string,
  existingNames: string[]
): Partial<IWorksheetData> {
  const base =
    name
      .replace(/[\\/?*[\]:]/g, "_")
      .trim()
      .slice(0, 31) || "CSV";
  let unique = base;
  let suffix = 2;
  const names = new Set(existingNames.map((value) => value.toLowerCase()));
  while (names.has(unique.toLowerCase())) {
    const ending = ` (${suffix++})`;
    unique = base.slice(0, 31 - ending.length) + ending;
  }
  const cellData: NonNullable<IWorksheetData["cellData"]> = {};
  data.rows.forEach((row, rowIndex) => {
    const cells: NonNullable<IWorksheetData["cellData"]>[number] = {};
    row.forEach((value, columnIndex) => {
      if (value !== "") {
        cells[columnIndex] = { v: value, t: CellValueType.FORCE_STRING };
      }
    });
    cellData[rowIndex] = cells;
  });
  return {
    name: unique,
    rowCount: Math.max(data.rowCount, 100),
    columnCount: Math.max(data.columnCount, 26),
    cellData,
  };
}
