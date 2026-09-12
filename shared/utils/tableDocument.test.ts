import { parser, serializer } from "../test/editor";
import { DocumentValidation } from "../validations";
import { tableToMarkdown } from "./lightweightTable";
import {
  getTableDocument,
  TableDocumentSchema,
  tableDocumentToMarkdown,
  UniverTableSchema,
} from "./tableDocument";

const table = UniverTableSchema.parse({
  format: "outline-table",
  version: 2,
  workbook: {
    id: "workbook",
    name: "原生工作簿",
    appVersion: "0.25.1",
    locale: "zhCN",
    styles: { heading: { bl: 1, bg: { rgb: "#abcdef" } } },
    sheetOrder: ["first", "second"],
    sheets: {
      first: {
        id: "first",
        name: "预算",
        rowCount: 1000,
        columnCount: 30,
        cellData: {
          0: {
            0: { v: "``` <script>text</script>", s: "heading" },
            1: { f: "=SUM(A2:A3)", v: 36 },
          },
        },
        mergeData: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 2 }],
        freeze: { startRow: 1, startColumn: -1, xSplit: 0, ySplit: 1 },
      },
      second: { id: "second", name: "结果", custom: { source: "preserved" } },
    },
    resources: [{ name: "SHEET_CUSTOM_RESOURCE", data: '{"value":true}' }],
    custom: { version: "plugin-data" },
  },
});

describe("native table Markdown contract", () => {
  it("preserves sheets, formulas, formatting, merges and plugin resources through Markdown", () => {
    const document = parser.parse(tableDocumentToMarkdown(table));
    expect(getTableDocument(document.toJSON())).toEqual(table);
    const exported = serializer.serialize(document);
    expect(getTableDocument(parser.parse(exported).toJSON())).toEqual(table);
  });

  it("continues to recognize the original format", () => {
    const legacy = {
      format: "outline-table",
      version: 1,
      columns: [{}],
      rows: [{ cells: [{ value: 5 }] }],
    } as const;
    const text = tableToMarkdown({
      ...legacy,
      columns: [{}],
      rows: [{ cells: [{ value: 5 }] }],
    });
    expect(getTableDocument(parser.parse(text).toJSON())?.version).toBe(1);
  });

  it.each([
    { sheetOrder: ["first", "first"] },
    { sheetOrder: ["missing"] },
    { sheets: { first: { id: "other" }, second: {} } },
    { sheets: { first: { cellData: { 0: { 0: { f: 42 } } } }, second: {} } },
    { sheets: { first: { rowCount: -1 }, second: {} } },
    { resources: [{ name: "resource", data: {} }] },
    { styles: [] },
    { custom: JSON.parse('{"__proto__":{"polluted":true}}') },
    { custom: { value: Infinity } },
  ])("rejects malformed native snapshots (%#)", (patch) => {
    expect(
      TableDocumentSchema.safeParse({
        ...table,
        workbook: { ...table.workbook, ...patch },
      }).success
    ).toBe(false);
  });

  it("rejects cycles but allows shared style references and absent optional values", () => {
    const style = { bl: 1 };
    expect(
      TableDocumentSchema.safeParse({
        ...table,
        workbook: {
          ...table.workbook,
          styles: { one: style, two: style },
          custom: undefined,
        },
      }).success
    ).toBe(true);
    const cycle: { self?: object } = {};
    cycle.self = cycle;
    expect(
      TableDocumentSchema.safeParse({
        ...table,
        workbook: { ...table.workbook, custom: cycle },
      }).success
    ).toBe(false);
  });

  it("applies the existing document size limit to native snapshots", () => {
    expect(
      TableDocumentSchema.safeParse({
        ...table,
        workbook: {
          ...table.workbook,
          name: "x".repeat(DocumentValidation.maxLength),
        },
      }).success
    ).toBe(false);
  });

  it("leaves mixed Markdown and unsupported versions in the Markdown editor", () => {
    for (const text of [
      "# 普通文档\n\n" + tableDocumentToMarkdown(table),
      "```outline-table\n" + JSON.stringify({ ...table, version: 3 }) + "\n```",
    ]) {
      expect(getTableDocument(parser.parse(text).toJSON())).toBeUndefined();
    }
  });
});
