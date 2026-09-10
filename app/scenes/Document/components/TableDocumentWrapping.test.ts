import { normalizeDailyTableWrapping } from "./TableDocument";

describe("normalizeDailyTableWrapping", () => {
  it("preserves wrapping after an edited daily work cell is saved", () => {
    const snapshot = {
      styles: { "77MOo9": { bg: { rgb: "#fff" } } },
      sheets: {
        daily: {
          name: "日报",
          cellData: {
            "1": { "1": { v: "第一行\n第二行", s: "77MOo9" } },
          },
        },
      },
    };

    const result = normalizeDailyTableWrapping(snapshot);
    expect(result.styles?.["daily-wrap"]).toMatchObject({
      tb: 3,
      vt: 1,
      ht: 1,
    });
    expect(result.sheets?.daily.cellData?.["1"]["1"]).toMatchObject({
      v: "第一行\n第二行",
      s: "daily-wrap",
    });
    expect(result.sheets?.daily.rowData?.["1"]?.h).toBe(48);
  });
});
