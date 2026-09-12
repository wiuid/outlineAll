import { CellValueType, LocaleType } from "@univerjs/core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import { UniverSheetsNodeCorePreset } from "@univerjs/preset-sheets-node-core";
import { createUniver } from "@univerjs/presets";
import type { LightweightTable } from "@shared/utils/lightweightTable";
import { TableDocumentSchema } from "@shared/utils/tableDocument";
import {
  createTableWorkbook,
  getTableWorkbook,
  snapshotTable,
} from "./tableWorkbook";

const legacy: LightweightTable = {
  format: "outline-table",
  version: 1,
  columns: [{ width: 180 }, { width: 140 }, {}],
  rows: [
    {
      height: 64,
      cells: [
        { value: 15, style: { bold: true, color: "#123456", wrap: true } },
        { value: 21 },
        { formula: "=SUM(A1:B1)" },
      ],
    },
    {
      cells: [
        { value: "=1+1" },
        { value: false },
        { value: "line one\nline two" },
      ],
    },
  ],
};

describe("native workbook integration", () => {
  it("preserves legacy literal types, formulas, row sizes and cell formatting", () => {
    const workbook = getTableWorkbook(legacy, "Legacy");
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    expect(sheet.rowData?.[0]).toEqual({ h: 64 });
    expect(sheet.columnData?.[0]).toEqual({ w: 180 });
    expect(sheet.cellData?.[0]?.[0]).toMatchObject({
      v: 15,
      t: CellValueType.NUMBER,
      s: { bl: 1, cl: { rgb: "#123456" }, tb: 3 },
    });
    expect(sheet.cellData?.[1]?.[0]).toMatchObject({
      v: "=1+1",
      t: CellValueType.STRING,
    });
    expect(sheet.cellData?.[1]?.[1]).toMatchObject({
      v: false,
      t: CellValueType.BOOLEAN,
    });
  });

  it("calculates basic formulas using the real Univer engine and saves reloadable native snapshots", async () => {
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: enUS },
      presets: [UniverSheetsNodeCorePreset()],
    });
    try {
      const workbook = univerAPI.createWorkbook(
        getTableWorkbook(legacy, "Legacy")
      );
      const sheet = workbook.getActiveSheet();
      await univerAPI.getFormula().onCalculationResultApplied(5000);
      expect(sheet.getRange("C1").getValue()).toBe(36);
      expect(sheet.getRange("A2").getValue()).toBe("=1+1");
      sheet
        .getRange("A3:C3")
        .setValues([["=AVERAGE(A1:B1)", "=IF(A1>10,1,0)", "=A1*B1"]]);
      await univerAPI.getFormula().onCalculationResultApplied(5000);
      expect(sheet.getRange("A3:C3").getValues()).toEqual([[18, 1, 315]]);
      sheet.getRange("B1").setValue(25);
      await univerAPI.getFormula().onCalculationResultApplied(5000);
      expect(sheet.getRange("C1").getValue()).toBe(40);
      workbook.insertSheet("Second sheet");
      sheet.getRange("A5:B5").merge();
      const snapshot = snapshotTable(workbook.save());
      expect(TableDocumentSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.workbook.sheetOrder).toHaveLength(2);
      expect(
        snapshot.workbook.sheets[sheet.getSheetId()].mergeData
      ).toContainEqual(
        expect.objectContaining({
          startRow: 4,
          endRow: 4,
          startColumn: 0,
          endColumn: 1,
        })
      );
      expect(getTableWorkbook(snapshot, "Unused")).toEqual(snapshot.workbook);
    } finally {
      univer.dispose();
    }
  });

  it("starts new tables with separate workbook and worksheet identities", () => {
    const first = createTableWorkbook("First");
    const second = createTableWorkbook("Second");
    expect(first.id).not.toBe(second.id);
    expect(first.sheetOrder[0]).not.toBe(second.sheetOrder[0]);
    expect(TableDocumentSchema.safeParse(snapshotTable(first)).success).toBe(
      true
    );
  });
});
