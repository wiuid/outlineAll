import { LocaleType } from "@univerjs/core";
import type { IWorkbookData } from "@univerjs/core";
import * as Y from "yjs";
import {
  captureTableChanges,
  createTableCollaboration,
  getTableLayout,
  materializeTable,
  trackTableStructure,
  validateTableCollaboration,
} from "./tableCollaboration";

const initial: IWorkbookData = {
  id: "book",
  name: "Collaboration",
  appVersion: "0.25.1",
  locale: LocaleType.EN_US,
  styles: {},
  sheetOrder: ["sheet"],
  sheets: {
    sheet: {
      id: "sheet",
      name: "Sheet1",
      rowCount: 12,
      columnCount: 4,
      cellData: {
        0: { 0: { v: 2 }, 1: { f: "=SUM(A1:A10)", v: 2 } },
        9: { 0: { v: "original" } },
      },
    },
  },
};

function peers() {
  const first = createTableCollaboration(initial);
  const second = new Y.Doc();
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  return { first, second };
}
function edit(doc: Y.Doc, apply: (book: IWorkbookData) => void, origin = {}) {
  const before = materializeTable(doc);
  const after = structuredClone(before);
  apply(after);
  const layout = getTableLayout(doc);
  captureTableChanges(
    doc,
    before,
    after,
    layout,
    structuredClone(layout),
    origin
  );
}
function merge(first: Y.Doc, second: Y.Doc) {
  const a = Y.encodeStateAsUpdate(first);
  const b = Y.encodeStateAsUpdate(second);
  Y.applyUpdate(first, b);
  Y.applyUpdate(second, a);
  expect(materializeTable(first)).toEqual(materializeTable(second));
}

describe("open-source table collaboration", () => {
  it("merges independent cells and retains native extension data", () => {
    const { first, second } = peers();
    edit(first, (book) => {
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        1: { 0: { v: "A" } },
      };
    });
    edit(second, (book) => {
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        2: { 0: { v: "B", s: { bl: 1 } } },
      };
      book.resources = [{ name: "plugin", data: '{"a":1}' }];
    });
    merge(first, second);
    const book = materializeTable(first);
    expect(book.sheets.sheet.cellData?.[1]?.[0]?.v).toBe("A");
    expect(book.sheets.sheet.cellData?.[2]?.[0]).toEqual({
      v: "B",
      s: { bl: 1 },
    });
    expect(book.resources).toEqual([{ name: "plugin", data: '{"a":1}' }]);
    validateTableCollaboration(first);
  });

  it("keeps cell contents atomic when a formula and literal are edited concurrently", () => {
    const { first, second } = peers();
    edit(first, (book) => {
      book.sheets.sheet.cellData = { 0: { 0: { f: "=2+3", v: 5 } } };
    });
    edit(second, (book) => {
      book.sheets.sheet.cellData = { 0: { 0: { v: "text" } } };
    });
    merge(first, second);
    const cell = materializeTable(first).sheets.sheet.cellData?.[0]?.[0];
    expect(cell?.f ? cell : cell?.v).toEqual(cell?.f ? { f: "=2+3" } : "text");
  });

  it("keeps an edit on its original row when a peer inserts a row", () => {
    const { first, second } = peers();
    const before = materializeTable(first);
    const layout = getTableLayout(first);
    const afterLayout = structuredClone(layout);
    trackTableStructure(afterLayout, "sheet.mutation.insert-row", {
      subUnitId: "sheet",
      range: { startRow: 1, endRow: 1, startColumn: 0, endColumn: 3 },
    });
    const after = structuredClone(before);
    after.sheets.sheet.rowCount = 13;
    after.sheets.sheet.cellData = {
      0: { 0: { v: 2 }, 1: { f: "=SUM(A1:A11)" } },
      10: { 0: { v: "original" } },
    };
    captureTableChanges(first, before, after, layout, afterLayout, {});
    edit(second, (book) => {
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        9: { 0: { v: "concurrent edit" } },
      };
    });
    merge(first, second);
    const sheet = materializeTable(first).sheets.sheet;
    expect(sheet.rowCount).toBe(13);
    expect(sheet.cellData?.[10]?.[0]?.v).toBe("concurrent edit");
    expect(sheet.cellData?.[0]?.[1]?.f).toBe("=SUM(A1:A11)");
    expect(sheet.cellData?.[9]).toBeUndefined();
  });

  it("undoes only the local edit and preserves a peer's later value", () => {
    const { first, second } = peers();
    const origin = {};
    const undo = new Y.UndoManager(first.getMap("properties"), {
      trackedOrigins: new Set([origin]),
      captureTimeout: 0,
    });
    edit(
      first,
      (book) => {
        book.sheets.sheet.cellData = {
          ...book.sheets.sheet.cellData,
          1: { 0: { v: "mine" } },
        };
      },
      origin
    );
    merge(first, second);
    edit(second, (book) => {
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        1: { 0: { v: "theirs" } },
      };
    });
    merge(first, second);
    undo.undo();
    expect(materializeTable(first).sheets.sheet.cellData?.[1]?.[0]?.v).toBe(
      "theirs"
    );
  });

  it("rejects unrelated shared roots", () => {
    const doc = createTableCollaboration(initial);
    doc.getMap("untrusted").set("x", "y");
    expect(() => validateTableCollaboration(doc)).toThrow("Unexpected");
  });

  it("merges independent native style definitions without losing either cell's formatting", () => {
    const { first, second } = peers();
    edit(first, (book) => {
      book.styles.bold = { bl: 1 };
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        1: { 0: { v: "bold", s: "bold" } },
      };
    });
    edit(second, (book) => {
      book.styles.italic = { it: 1 };
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        2: { 0: { v: "italic", s: "italic" } },
      };
    });
    merge(first, second);
    expect(materializeTable(first).styles).toEqual({
      bold: { bl: 1 },
      italic: { it: 1 },
    });
  });

  it("preserves a concurrent formula edit when native insertion rewrites its coordinates", () => {
    const { first, second } = peers();
    const before = materializeTable(first);
    const oldLayout = getTableLayout(first);
    const layout = structuredClone(oldLayout);
    trackTableStructure(layout, "sheet.mutation.insert-row", {
      subUnitId: "sheet",
      range: { startRow: 1, endRow: 1, startColumn: 0, endColumn: 3 },
    });
    const after = structuredClone(before);
    after.sheets.sheet.rowCount = 13;
    after.sheets.sheet.cellData = {
      0: { 0: { v: 2 }, 1: { f: "=SUM(A1:A11)" } },
      10: { 0: { v: "original" } },
    };
    edit(second, (book) => {
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        0: { 0: { v: 2 }, 1: { f: "=SUM(A1:A10)*3" } },
      };
    });
    // A remote update arrives while the first view is still showing old coordinates.
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
    captureTableChanges(first, before, after, oldLayout, layout, {});
    merge(first, second);
    expect(materializeTable(first).sheets.sheet.cellData?.[0]?.[1]?.f).toBe(
      "=SUM(A1:A11)*3"
    );
  });

  it("restores a deleted row with the peer's edit when the deletion is undone", () => {
    const { first, second } = peers();
    const origin = {};
    const undo = new Y.UndoManager([...first.share.values()], {
      trackedOrigins: new Set([origin]),
      captureTimeout: 0,
    });
    const before = materializeTable(first);
    const oldLayout = getTableLayout(first);
    const layout = structuredClone(oldLayout);
    trackTableStructure(layout, "sheet.mutation.remove-rows", {
      subUnitId: "sheet",
      range: { startRow: 9, endRow: 9, startColumn: 0, endColumn: 3 },
    });
    const after = structuredClone(before);
    after.sheets.sheet.rowCount = 11;
    after.sheets.sheet.cellData = {
      0: { 0: { v: 2 }, 1: { f: "=SUM(A1:A9)" } },
    };
    captureTableChanges(first, before, after, oldLayout, layout, origin);
    edit(second, (book) => {
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        9: { 0: { v: "edit in removed row" } },
      };
    });
    merge(first, second);
    expect(materializeTable(first).sheets.sheet.rowCount).toBe(11);
    undo.undo();
    merge(first, second);
    const sheet = materializeTable(first).sheets.sheet;
    expect(sheet.rowCount).toBe(12);
    expect(sheet.cellData?.[9]?.[0]?.v).toBe("edit in removed row");
    expect(sheet.cellData?.[0]?.[1]?.f).toBe("=SUM(A1:A10)");
  });

  it("keeps formulas and a peer's cells anchored across column insertion", () => {
    const { first, second } = peers();
    const before = materializeTable(first);
    const oldLayout = getTableLayout(first);
    const layout = structuredClone(oldLayout);
    trackTableStructure(layout, "sheet.mutation.insert-col", {
      subUnitId: "sheet",
      range: { startRow: 0, endRow: 11, startColumn: 0, endColumn: 0 },
    });
    const after = structuredClone(before);
    after.sheets.sheet.columnCount = 5;
    after.sheets.sheet.cellData = {
      0: { 1: { v: 2 }, 2: { f: "=SUM(B1:B10)" } },
      9: { 1: { v: "original" } },
    };
    captureTableChanges(first, before, after, oldLayout, layout, {});
    edit(second, (book) => {
      book.sheets.sheet.cellData = {
        ...book.sheets.sheet.cellData,
        9: { 0: { v: "peer" } },
      };
    });
    merge(first, second);
    const sheet = materializeTable(first).sheets.sheet;
    expect(sheet.cellData?.[9]?.[1]?.v).toBe("peer");
    expect(sheet.cellData?.[0]?.[2]?.f).toBe("=SUM(B1:B10)");
  });

  it("preserves explicit ordering for numeric worksheet identifiers", () => {
    const workbook = structuredClone(initial);
    workbook.sheetOrder = ["2", "1"];
    workbook.sheets = {
      1: { ...initial.sheets.sheet, id: "1", name: "First" },
      2: { ...initial.sheets.sheet, id: "2", name: "Second" },
    };
    expect(
      materializeTable(createTableCollaboration(workbook)).sheetOrder
    ).toEqual(["2", "1"]);
  });

  it("preserves user extension values containing internal marker names", () => {
    const doc = createTableCollaboration({
      ...initial,
      custom: {
        $outlineCollaborationRange: { arbitrary: true },
        nested: ["kept"],
      },
    });
    expect(materializeTable(doc).custom).toEqual({
      $outlineCollaborationRange: { arbitrary: true },
      nested: ["kept"],
    });
  });

  it("rejects hidden-only workbooks and duplicate worksheet names after a merge", () => {
    const hidden = structuredClone(initial);
    hidden.sheets.sheet.hidden = 1;
    expect(() => materializeTable(createTableCollaboration(hidden))).toThrow(
      "visible sheet"
    );
    const duplicate = structuredClone(initial);
    duplicate.sheetOrder.push("another");
    duplicate.sheets.another = {
      ...duplicate.sheets.sheet,
      id: "another",
      name: "sheet1",
    };
    expect(() => materializeTable(createTableCollaboration(duplicate))).toThrow(
      "unique worksheet names"
    );
  });
});
