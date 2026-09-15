import { CellValueType, LocaleType } from "@univerjs/core";
import type { ICellData, IWorkbookData } from "@univerjs/core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import {
  BEFORE_CELL_EDIT,
  SheetInterceptorService,
  UniverSheetsNodeCorePreset,
} from "@univerjs/preset-sheets-node-core";
import { createUniver } from "@univerjs/presets";
import { createTableWorkbook, getTableWorkbook } from "./tableWorkbook";
import { registerTableMultilineEditing } from "./tableMultiline";

function createEditor(
  cell: ICellData,
  snapshot: IWorkbookData = createTableWorkbook("Multiline")
) {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: enUS },
    presets: [UniverSheetsNodeCorePreset()],
  });
  snapshot.sheets[snapshot.sheetOrder[0]].cellData = { 0: { 0: cell } };
  const facade = univerAPI.createWorkbook(snapshot);
  const interceptors = univer.__getInjector().get(SheetInterceptorService);
  const registration = registerTableMultilineEditing(interceptors);
  const workbook = facade.getWorkbook();
  const worksheet = workbook.getActiveSheet();
  if (!worksheet) {
    throw new Error("Missing test worksheet");
  }
  const context = {
    workbook,
    worksheet,
    unitId: workbook.getUnitId(),
    subUnitId: worksheet.getSheetId(),
    row: 0,
    col: 0,
    origin: worksheet.getCellRaw(0, 0),
  };
  const edit = () => {
    const edited = interceptors.writeCellInterceptor.fetchThroughInterceptors(
      BEFORE_CELL_EDIT
    )(worksheet.getCell(0, 0), context);
    if (!edited) {
      return undefined;
    }
    return worksheet.getCellDocumentModelWithFormula(edited, 0, 0)
      ?.documentModel;
  };
  return { univer, facade, worksheet, registration, edit };
}

describe("external multiline cell editing", () => {
  it.each([
    ["first\nsecond", "first\rsecond\r\n"],
    ["first\r\nsecond", "first\rsecond\r\n"],
    ["first\rsecond", "first\rsecond\r\n"],
    ["\nfirst\n\nsecond\n", "\rfirst\r\rsecond\r\r\n"],
    ["\r\n", "\r\r\n"],
    ["第一行😀\n  第二行\t ", "第一行😀\r  第二行\t \r\n"],
  ])(
    "retains every paragraph in %j without changing the stored value",
    (value, expected) => {
      const runtime = createEditor({ v: value, t: CellValueType.STRING });
      try {
        const before = runtime.facade.save();
        const model = runtime.edit();
        expect(model?.getBody()?.dataStream).toBe(expected);
        expect(model?.getBody()?.paragraphs?.map((p) => p.startIndex)).toEqual(
          [...expected.matchAll(/\r/g)].map((match) => match.index)
        );
        expect(runtime.facade.save()).toEqual(before);
        expect(runtime.worksheet.getCellRaw(0, 0)?.v).toBe(value);
        model?.dispose();
      } finally {
        runtime.univer.dispose();
      }
    }
  );

  it("preserves composed formatting in the native editor", () => {
    const snapshot = createTableWorkbook("Styled");
    snapshot.styles = { emphasis: { bl: 1, cl: { rgb: "#345678" } } };
    const sheet = snapshot.sheets[snapshot.sheetOrder[0]];
    sheet.rowData = { 0: { s: { it: 1 } } };
    sheet.columnData = { 0: { s: { fs: 16, ff: "Arial" } } };
    const runtime = createEditor(
      { v: "first\nsecond", s: "emphasis" },
      snapshot
    );
    try {
      const model = runtime.edit();
      expect(model?.getBody()?.textRuns).toEqual([
        expect.objectContaining({
          st: 0,
          ed: 12,
          ts: expect.objectContaining({
            bl: 1,
            it: 1,
            fs: 16,
            ff: "Arial",
            cl: { rgb: "#345678" },
          }),
        }),
      ]);
      model?.dispose();
    } finally {
      runtime.univer.dispose();
    }
  });

  it("keeps existing rich text authoritative over its plain value", () => {
    const cell: ICellData = {
      v: "stale\nvalue",
      p: {
        id: "rich",
        documentStyle: {},
        body: {
          dataStream: "rich\rtext\r\n",
          paragraphs: [{ startIndex: 4 }, { startIndex: 9 }],
          textRuns: [{ st: 0, ed: 4, ts: { bl: 1 } }],
        },
      },
    };
    const runtime = createEditor(cell);
    try {
      const model = runtime.edit();
      expect(model?.getBody()?.dataStream).toBe(cell.p?.body?.dataStream);
      expect(model?.getBody()?.textRuns).toEqual(cell.p?.body?.textRuns);
      model?.dispose();
    } finally {
      runtime.univer.dispose();
    }
  });

  it.each([
    { v: "first\\nsecond", t: CellValueType.STRING },
    { v: 12, t: CellValueType.NUMBER },
    { v: true, t: CellValueType.BOOLEAN },
    { v: "first\nsecond", f: '=CONCAT("first",CHAR(10),"second")' },
    { v: "first\nsecond", si: "shared-formula" },
  ])(
    "leaves literal backslashes, scalar types and formulas to Univer (%#)",
    (cell) => {
      const runtime = createEditor(cell);
      try {
        runtime.registration.dispose();
        const expected = runtime.edit();
        registerTableMultilineEditing(
          runtime.univer.__getInjector().get(SheetInterceptorService)
        );
        const actual = runtime.edit();
        expect(actual?.getBody()).toEqual(expected?.getBody());
        actual?.dispose();
        expected?.dispose();
      } finally {
        runtime.univer.dispose();
      }
    }
  );

  it("retains Univer's forced-text edit prefix", () => {
    const runtime = createEditor({
      v: "=literal\nsecond",
      t: CellValueType.FORCE_STRING,
    });
    try {
      const model = runtime.edit();
      expect(model?.getBody()?.dataStream).toBe("'=literal\rsecond\r\n");
      model?.dispose();
    } finally {
      runtime.univer.dispose();
    }
  });

  it("also handles the original table format and later native cell changes", () => {
    const workbook = getTableWorkbook(
      {
        format: "outline-table",
        version: 1,
        columns: [{}],
        rows: [{ cells: [{ value: "legacy\nlines" }] }],
      },
      "Legacy"
    );
    const runtime = createEditor(
      { v: "legacy\nlines", t: CellValueType.STRING },
      workbook
    );
    try {
      const initial = runtime.edit();
      expect(initial?.getBody()?.dataStream).toBe("legacy\rlines\r\n");
      initial?.dispose();
      runtime.facade.getActiveSheet().getRange("A1").setValue("remote\nchange");
      const updated = runtime.edit();
      expect(updated?.getBody()?.dataStream).toBe("remote\rchange\r\n");
      expect(runtime.worksheet.getCellRaw(0, 0)?.v).toBe("remote\nchange");
      updated?.dispose();
    } finally {
      runtime.univer.dispose();
    }
  });
});
