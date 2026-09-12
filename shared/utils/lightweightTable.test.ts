import { parser, serializer } from "../test/editor";
import {
  getLightweightTable,
  LightweightTableSchema,
  serializeLightweightTable,
  tableToMarkdown,
  type LightweightTable,
} from "./lightweightTable";

const table: LightweightTable = {
  format: "outline-table",
  version: 1,
  columns: [{ width: 220 }, {}],
  rows: [
    {
      height: 80,
      cells: [
        {
          value: "第一行\n第二行\r\n``` <script>alert(1)</script>",
          style: { bold: true, color: "#123456", wrap: true },
        },
        { formula: "=SUM(A2:B2)" },
      ],
    },
    { cells: [{ value: 2 }, { value: 3 }] },
  ],
};

describe("lightweight table Markdown contract", () => {
  it("round trips canonical JSON through the existing Markdown parser and serializer", () => {
    const document = parser.parse(tableToMarkdown(table));
    expect(getLightweightTable(document.toJSON())).toEqual(table);
    expect(
      getLightweightTable(parser.parse(serializer.serialize(document)).toJSON())
    ).toEqual(table);

    const reordered = {
      rows: table.rows,
      columns: table.columns,
      version: table.version,
      format: table.format,
    };
    expect(serializeLightweightTable(reordered)).toBe(
      serializeLightweightTable(table)
    );
  });

  it.each([
    "Ordinary Markdown",
    "| A | B |\n| --- | --- |\n| 1 | 2 |",
    `${tableToMarkdown(table)}\n\nOther document content`,
    "```outline-table\nnot JSON\n```",
    `\`\`\`outline-table\n${JSON.stringify({ ...table, version: 2 })}\n\`\`\``,
    `\`\`\`json\n${serializeLightweightTable(table)}\n\`\`\``,
  ])(
    "leaves ordinary, mixed, and unsupported documents unchanged (%#)",
    (text) => {
      const document = parser.parse(text).toJSON();
      const original = structuredClone(document);

      expect(getLightweightTable(document)).toBeUndefined();
      expect(document).toEqual(original);
    }
  );

  it("does not interpret annotated code blocks as editable tables", () => {
    const marks = [{ type: "comment", attrs: { id: "comment-id" } }];
    const text = { type: "text", text: serializeLightweightTable(table) };
    const block = {
      type: "code_block",
      attrs: { language: "outline-table" },
      content: [text],
    };

    for (const data of [
      { type: "doc", content: [{ ...block, content: [{ ...text, marks }] }] },
      { type: "doc", content: [{ ...block, marks }] },
      { type: "doc", content: [block], marks },
    ]) {
      expect(getLightweightTable(data)).toBeUndefined();
    }
  });

  it.each([
    { ...table, version: 2 },
    { ...table, cachedResults: [] },
    { ...table, columns: [] },
    { ...table, rows: [{ cells: [{ value: 1 }] }] },
    {
      ...table,
      rows: [{ cells: [{ formula: "=" }, { value: null }] }],
    },
    {
      ...table,
      rows: [{ cells: [{ value: 1, formula: "=A1" }, { value: null }] }],
    },
    {
      ...table,
      rows: [
        { cells: [{ value: 1, style: { color: "red" } }, { value: null }] },
      ],
    },
  ])("rejects unsupported or malformed table data (%#)", (input) => {
    expect(LightweightTableSchema.safeParse(input).success).toBe(false);
  });

  it("enforces the source size limit for structured and Markdown input", () => {
    const oversized = {
      ...table,
      columns: [{}],
      rows: Array.from({ length: 51 }, () => ({
        cells: [{ value: "x".repeat(10_000) }],
      })),
    };

    expect(() => serializeLightweightTable(oversized)).toThrow(
      "Table source is too large"
    );
    expect(
      getLightweightTable({
        type: "doc",
        content: [
          {
            type: "code_block",
            attrs: { language: "outline-table" },
            content: [{ type: "text", text: JSON.stringify(oversized) }],
          },
        ],
      })
    ).toBeUndefined();
  });

  it("round trips sources with many separate backtick runs", () => {
    const manyBackticks: LightweightTable = {
      format: "outline-table",
      version: 1,
      columns: [{}],
      rows: Array.from({ length: 40 }, () => ({
        cells: [{ value: "`x".repeat(5_000) }],
      })),
    };

    expect(
      getLightweightTable(parser.parse(tableToMarkdown(manyBackticks)).toJSON())
    ).toEqual(manyBackticks);
  });
});
