import type {
  ICellData,
  IObjectMatrixPrimitiveType,
  IWorkbookData,
  Nullable,
} from "@univerjs/core";
import { SetRangeValuesMutation } from "@univerjs/preset-sheets-core";
import type { createUniver } from "@univerjs/presets";

type UniverAPI = ReturnType<typeof createUniver>["univerAPI"];
type Workbook = ReturnType<UniverAPI["createWorkbook"]>;

/**
 * Patches cell changes through native mutations when the structure is unchanged.
 * Structural/plugin changes are loaded through Univer's normal workbook lifecycle.
 *
 * @param api the current native facade.
 * @param workbook the displayed workbook.
 * @param previous the previously materialized shared snapshot.
 * @param next the new shared snapshot.
 * @returns true if the view was patched without replacing the workbook.
 */
export function patchTableCells(
  api: UniverAPI,
  workbook: Workbook,
  previous: IWorkbookData,
  next: IWorkbookData
): boolean {
  if (structure(previous) !== structure(next)) {
    return false;
  }
  workbook.getWorkbook().addStyles(next.styles);
  const displayed = workbook.save();
  for (const sheetId of next.sheetOrder) {
    const before = displayed.sheets[sheetId]?.cellData ?? {};
    const after = next.sheets[sheetId].cellData ?? {};
    const changes: IObjectMatrixPrimitiveType<Nullable<ICellData>> = {};
    for (const row of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      const oldRow = before[Number(row)] ?? {};
      const newRow = after[Number(row)] ?? {};
      for (const col of new Set([
        ...Object.keys(oldRow),
        ...Object.keys(newRow),
      ])) {
        const oldCell = oldRow[Number(col)];
        const newCell = newRow[Number(col)];
        if (cellContent(oldCell) === cellContent(newCell)) {
          continue;
        }
        changes[Number(row)] ??= {};
        changes[Number(row)][Number(col)] = newCell
          ? {
              ...Object.fromEntries(
                Object.keys(oldCell ?? {}).map((field) => [field, null])
              ),
              ...newCell,
            }
          : null;
      }
    }
    if (Object.keys(changes).length) {
      api.syncExecuteCommand(
        SetRangeValuesMutation.id,
        { unitId: workbook.getId(), subUnitId: sheetId, cellValue: changes },
        { fromCollab: true }
      );
    }
  }
  return true;
}

function cellContent(cell?: Nullable<ICellData>): string {
  if (!cell) {
    return "null";
  }
  if (cell.f) {
    const { v: _value, t: _type, ...rest } = cell;
    return JSON.stringify(rest);
  }
  return JSON.stringify(cell);
}

function structure(workbook: IWorkbookData): string {
  const { styles: _styles, rev: _revision, sheets, ...metadata } = workbook;
  return JSON.stringify({
    ...metadata,
    sheets: Object.fromEntries(
      Object.entries(sheets).map(([id, sheet]) => {
        const { cellData: _cells, ...rest } = sheet;
        return [id, rest];
      })
    ),
  });
}
