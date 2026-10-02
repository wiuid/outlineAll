import { describe, expect, it } from "vitest";
import { worksheetToCSV } from "./tableCSV";

describe("worksheetToCSV", () => {
  it("preserves Chinese, quotes, newlines and gaps in the used range", () => {
    expect(
      worksheetToCSV({
        cellData: {
          0: { 0: { v: '中文,"名称"\n下一行' } },
          2: { 1: { v: 0 }, 2: { v: false } },
          100: { 100: { s: "style-only" } },
        },
      })
    ).toBe(
      '\uFEFF"中文,""名称""\n下一行","",""\r\n"","",""\r\n"","0","false"\r\n'
    );
  });

  it("exports cached formula values and protects formula-like text", () => {
    expect(
      worksheetToCSV({
        cellData: {
          0: {
            0: { f: "=1+1", v: 2 },
            1: { v: "\t=HYPERLINK(1)" },
            2: { v: "+123" },
            3: { f: "=1+1" },
          },
        },
      })
    ).toBe('\uFEFF"2","\'\t=HYPERLINK(1)","\'+123"\r\n');
  });

  it("exports rich text without its terminal paragraph delimiter", () => {
    expect(
      worksheetToCSV({
        cellData: {
          0: {
            0: {
              p: {
                id: "rich-text",
                documentStyle: {},
                body: { dataStream: "line\r\nsecond\r\n" },
              },
            },
          },
        },
      })
    ).toBe('\uFEFF"line\r\nsecond"\r\n');
  });

  it("handles empty sheets and refuses excessive sparse ranges", () => {
    expect(worksheetToCSV({ cellData: {} })).toBe("\uFEFF\r\n");
    expect(() =>
      worksheetToCSV({
        cellData: {
          1000: { 1000: { v: "large" } },
        },
      })
    ).toThrow("too large");
  });
});
