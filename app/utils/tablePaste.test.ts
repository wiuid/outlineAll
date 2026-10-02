import { CellValueType } from "@univerjs/core";
import { describe, expect, it } from "vitest";
import { parseTableCSV } from "./tableCSVImport";
import { buildTablePasteValues } from "./tablePaste";

describe("buildTablePasteValues", () => {
  it("preserves literal formulas, leading zeros and rectangular empty cells", () => {
    const result = buildTablePasteValues(
      parseTableCSV("00123\t=SUM(A1)\nlast", "\t"),
      []
    );
    expect(result.values.map((row) => row.map((cell) => cell.v))).toEqual([
      ["00123", "=SUM(A1)"],
      ["last", ""],
    ]);
    expect(result.values[0][1].t).toBe(CellValueType.FORCE_STRING);
    expect(result.occupiedCells).toBe(0);
  });

  it("counts zero, false, formulas, rich text and images as occupied", () => {
    const result = buildTablePasteValues(
      parseTableCSV("a\tb\tc\td\te\tf", "\t"),
      [
        [
          { v: 0 },
          { v: false },
          { f: "=1" },
          { si: "shared" },
          { custom: { outlineImage: {} } },
          { v: "", s: "style" },
        ],
      ]
    );
    expect(result.occupiedCells).toBe(5);
    expect(result.values[0][5].s).toBe("style");
  });

  it("clears previous content and images without mutating source metadata", () => {
    const cell = {
      v: 42,
      f: "=42",
      si: "shared",
      s: "style",
      custom: { outlineImage: { name: "image" }, other: true },
    };
    const result = buildTablePasteValues(parseTableCSV("text", "\t"), [[cell]]);
    expect(result.values[0][0]).toMatchObject({
      v: "text",
      f: null,
      p: null,
      si: null,
      ref: null,
      s: "style",
      custom: { outlineImage: null, other: true },
    });
    expect(cell.custom.outlineImage).toEqual({ name: "image" });
  });
});
