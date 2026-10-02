import { describe, expect, it } from "vitest";
import { parseTableCSV } from "./tableCSVImport";
import { clearTableSelectionValues, selectionToTSV } from "./tableSelection";

describe("selectionToTSV", () => {
  it("round trips leading zeros, Unicode, empty cells and quoted multiline text", () => {
    const values = [
      ["00123", "中文", ""],
      ["line\nnext", 'a\t"b"', "last"],
    ];
    expect(parseTableCSV(selectionToTSV(values), "\t").rows).toEqual(values);
  });
  it("protects copied text from executing as formulas in external spreadsheets", () => {
    expect(
      parseTableCSV(selectionToTSV([["=SUM(A1)", "  @cmd", "+1", "-1"]]), "\t")
        .rows
    ).toEqual([["'=SUM(A1)", "'  @cmd", "'+1", "'-1"]]);
  });
});
describe("clearTableSelectionValues", () => {
  it("clears formulas and images while preserving styles and unrelated metadata", () => {
    const cell = {
      v: 42,
      f: "=42",
      si: "formula",
      s: "style",
      custom: { outlineImage: { name: "image" }, other: true },
    };
    expect(clearTableSelectionValues([[cell, null]])).toEqual([
      [
        {
          ...cell,
          v: null,
          t: null,
          f: null,
          p: null,
          si: null,
          ref: null,
          custom: { outlineImage: null, other: true },
        },
        {
          v: null,
          t: null,
          f: null,
          p: null,
          si: null,
          ref: null,
          custom: { outlineImage: null },
        },
      ],
    ]);
    expect(cell.v).toBe(42);
    expect(cell.custom.outlineImage).toEqual({ name: "image" });
  });
});
