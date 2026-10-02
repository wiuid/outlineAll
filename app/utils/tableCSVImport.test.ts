import { describe, expect, it } from "vitest";
import { CellValueType } from "@univerjs/core";
import { createCSVWorksheet, parseTableCSV } from "./tableCSVImport";

describe("parseTableCSV", () => {
  it("preserves Chinese, leading zeros, quoted separators and multiline fields", () => {
    const data = parseTableCSV(
      '\uFEFF名称,编号,备注\r\n中文,00123,"a,""b""\n下一行"\r\n'
    );
    expect(data.rows).toEqual([
      ["名称", "编号", "备注"],
      ["中文", "00123", 'a,"b"\n下一行'],
    ]);
    expect(data.rowCount).toBe(2);
    expect(data.columnCount).toBe(3);
  });
  it("preserves internal empty rows and trailing fields", () => {
    expect(parseTableCSV("a,b,\n\n1,2,\n", ",").rows).toEqual([
      ["a", "b", ""],
      [""],
      ["1", "2", ""],
    ]);
  });
  it("detects TSV and supports semicolon and single-column files", () => {
    expect(parseTableCSV("a\tb\n1\t2").columnCount).toBe(2);
    expect(parseTableCSV("a;b\n1;2", ";").columnCount).toBe(2);
    expect(parseTableCSV("hello\nworld").rows).toEqual([["hello"], ["world"]]);
  });
  it("rejects malformed quotes and empty input", () => {
    expect(() => parseTableCSV('a,"unclosed')).toThrow("invalid quotes");
    expect(() => parseTableCSV("\n\n")).toThrow("no data");
  });
  it("rejects excessive file sizes, dimensions and cells", () => {
    expect(() => parseTableCSV("x".repeat(1024 * 1024 + 1))).toThrow("1 MB");
    expect(() => parseTableCSV("x\n".repeat(10_001))).toThrow("10,000");
    expect(() => parseTableCSV(Array(257).fill("x").join(","))).toThrow("256");
    expect(() =>
      parseTableCSV((Array(100).fill("x").join(",") + "\n").repeat(501))
    ).toThrow("50,000");
  });
});

describe("createCSVWorksheet", () => {
  it("creates literal text cells without executable formulas", () => {
    const sheet = createCSVWorksheet(
      parseTableCSV("00123,=SUM(A1),false", ","),
      "data",
      []
    );
    expect(sheet.cellData?.[0]?.[0]).toEqual({
      v: "00123",
      t: CellValueType.FORCE_STRING,
    });
    expect(sheet.cellData?.[0]?.[1]).toEqual({
      v: "=SUM(A1)",
      t: CellValueType.FORCE_STRING,
    });
    expect(sheet.cellData?.[0]?.[2]?.v).toBe("false");
  });
  it("avoids name collisions and preserves existing worksheets", () => {
    const names = ["data", "DATA (2)"];
    expect(createCSVWorksheet(parseTableCSV("x"), "data", names).name).toBe(
      "data (3)"
    );
    expect(names).toEqual(["data", "DATA (2)"]);
    expect(createCSVWorksheet(parseTableCSV("x"), "a/b:c", []).name).toBe(
      "a_b_c"
    );
  });
});
