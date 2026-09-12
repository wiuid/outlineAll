import { TextEditMode } from "@shared/types";
import {
  getLightweightTable,
  tableToMarkdown,
  type LightweightTable,
} from "@shared/utils/lightweightTable";
import { parser } from "@server/editor";
import { DocumentsCreateSchema, DocumentsUpdateSchema } from "./schema";

const table: LightweightTable = {
  format: "outline-table",
  version: 1,
  columns: [{ width: 180 }, {}],
  rows: [
    {
      cells: [
        { value: "第一行\n``` <script>alert(1)</script>" },
        { formula: "=A2" },
      ],
    },
  ],
};

describe("lightweight table request schemas (no database)", () => {
  it("requires lastRevision for structured table updates", () => {
    const result = DocumentsUpdateSchema.safeParse({
      body: { id: "8faeb5da-bb7d-4f7d-aa0b-34047073d1ac", table },
      query: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["body", "lastRevision"] })
      );
    }
  });

  it("converts a revision-checked table update to Markdown without losing cells", () => {
    const request = DocumentsUpdateSchema.parse({
      body: {
        id: "8faeb5da-bb7d-4f7d-aa0b-34047073d1ac",
        table,
        lastRevision: 0,
      },
      query: {},
    });

    expect(request.body.text).toBe(tableToMarkdown(table));
    expect(request.body.lastRevision).toBe(0);
    expect(
      getLightweightTable(parser.parse(request.body.text ?? "").toJSON())
    ).toEqual(table);
  });

  it("converts structured create input to the existing Markdown persistence contract", () => {
    const request = DocumentsCreateSchema.parse({
      body: { title: "Table", table },
      query: {},
    });

    expect(request.body.text).toBe(tableToMarkdown(table));
    expect(
      getLightweightTable(parser.parse(request.body.text ?? "").toJSON())
    ).toEqual(table);
  });

  it.each(["Conflicting Markdown", ""])(
    "rejects simultaneous table and text input (%#)",
    (text) => {
      const input = {
        body: {
          id: "8faeb5da-bb7d-4f7d-aa0b-34047073d1ac",
          table,
          text,
          lastRevision: 0,
        },
        query: {},
      };

      for (const schema of [DocumentsCreateSchema, DocumentsUpdateSchema]) {
        const result = schema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toContainEqual(
            expect.objectContaining({ path: ["body", "table"] })
          );
        }
      }
    }
  );

  it.each([
    { editMode: TextEditMode.Append },
    { editMode: TextEditMode.Prepend },
    { editMode: TextEditMode.Patch, findText: "Original" },
    { append: true },
  ])("rejects partial edit modes for structured tables (%#)", (input) => {
    const result = DocumentsUpdateSchema.safeParse({
      body: {
        id: "8faeb5da-bb7d-4f7d-aa0b-34047073d1ac",
        table,
        lastRevision: 0,
        ...input,
      },
      query: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["body", "editMode"] })
      );
    }
  });

  it("accepts an explicit replace mode and revision zero", () => {
    const request = DocumentsUpdateSchema.parse({
      body: {
        id: "8faeb5da-bb7d-4f7d-aa0b-34047073d1ac",
        table,
        lastRevision: 0,
        editMode: TextEditMode.Replace,
        append: false,
      },
      query: {},
    });

    expect(request.body.text).toBe(tableToMarkdown(table));
    expect(request.body.lastRevision).toBe(0);
    expect(request.body.editMode).toBe(TextEditMode.Replace);
  });

  it("reports oversized tables as validation errors without throwing from the transform", () => {
    const oversized = {
      ...table,
      columns: [{}],
      rows: Array.from({ length: 51 }, () => ({
        cells: [{ value: "x".repeat(10_000) }],
      })),
    };

    for (const schema of [DocumentsCreateSchema, DocumentsUpdateSchema]) {
      const result = schema.safeParse({
        body: {
          id: "8faeb5da-bb7d-4f7d-aa0b-34047073d1ac",
          table: oversized,
          lastRevision: 0,
        },
        query: {},
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["body", "table"],
            message: "Table source is too large",
          })
        );
      }
    }
  });
});
