import { z } from "zod";
import type { ProsemirrorData } from "../types";

/** Renderer-independent cell formatting; omitted colors follow the Outline theme. */
export const TableCellStyleSchema = z.strictObject({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  wrap: z.boolean().optional(),
});

/** A cell stores either a typed literal or a formula, never a cached result. */
export const TableCellSchema = z.union([
  z.strictObject({
    value: z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]),
    style: TableCellStyleSchema.optional(),
  }),
  z.strictObject({
    formula: z.string().startsWith("=").min(2).max(256),
    style: TableCellStyleSchema.optional(),
  }),
]);

/** Versioned, bounded canonical JSON for a single lightweight worksheet. */
export const LightweightTableSchema = z
  .strictObject({
    format: z.literal("outline-table"),
    version: z.literal(1),
    columns: z
      .array(
        z.strictObject({ width: z.number().int().min(60).max(600).optional() })
      )
      .min(1)
      .max(26),
    rows: z
      .array(
        z.strictObject({
          height: z.number().int().min(32).max(600).optional(),
          cells: z.array(TableCellSchema).min(1).max(26),
        })
      )
      .min(1)
      .max(100),
  })
  .refine(
    (table) =>
      table.rows.every((row) => row.cells.length === table.columns.length),
    { message: "Every row must have one cell per column" }
  )
  .refine((table) => JSON.stringify(table, null, 2).length <= maxSourceLength, {
    message: "Table source is too large",
  });

/** The portable source of truth, shared by browser and headless callers. */
export type LightweightTable = z.infer<typeof LightweightTableSchema>;
/** A literal or formula cell. */
export type TableCell = z.infer<typeof TableCellSchema>;
/** A partial set of cell formatting properties. */
export type TableCellStyle = z.infer<typeof TableCellStyleSchema>;

/**
 * Validates and serializes a worksheet with stable schema-defined key order.
 *
 * @param table the untrusted JSON input.
 * @returns canonical JSON without computed formula results.
 * @throws {Error} if the table is invalid or exceeds the source size limit.
 */
export function serializeLightweightTable(table: unknown): string {
  return JSON.stringify(LightweightTableSchema.parse(table), null, 2);
}

/**
 * Wraps canonical JSON in an explicit Markdown transport understood by Outline.
 *
 * @param table the worksheet to serialize.
 * @returns Markdown that can be created, updated, imported, or exported normally.
 * @throws {Error} if the table is invalid or exceeds the source size limit.
 */
export function tableToMarkdown(table: LightweightTable): string {
  return tableSourceToMarkdown(serializeLightweightTable(table));
}

/**
 * Wraps table JSON in a Markdown fence that cannot be closed by its contents.
 *
 * @param json the serialized table source.
 * @returns the fenced Markdown source.
 */
export function tableSourceToMarkdown(json: string): string {
  let fenceLength = 3;
  for (const [run] of json.matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, run.length + 1);
  }
  const fence = "`".repeat(fenceLength);
  return `${fence}outline-table\n${json}\n${fence}`;
}

/**
 * Recognizes only a whole-document, valid outline-table fence. Ordinary Markdown,
 * mixed content, annotations, and unknown versions stay in the standard editor.
 *
 * @param data the document's existing ProseMirror JSON.
 * @returns the validated table, or undefined without modifying the source.
 */
export function getLightweightTable(
  data?: ProsemirrorData
): LightweightTable | undefined {
  const source = getTableSource(data);
  if (source === undefined || source.length > maxSourceLength) {
    return undefined;
  }
  try {
    const result = LightweightTableSchema.safeParse(JSON.parse(source));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads an unannotated table fence occupying an entire document.
 *
 * @param data the document's ProseMirror JSON.
 * @returns the source without interpreting its format version.
 */
export function getTableSource(data?: ProsemirrorData): string | undefined {
  if (
    data?.type !== "doc" ||
    data.content?.length !== 1 ||
    data.marks?.length
  ) {
    return undefined;
  }
  const block = data.content[0];
  if (
    !["code_fence", "code_block"].includes(block.type) ||
    block.attrs?.language !== "outline-table" ||
    block.marks?.length ||
    !block.content?.every((node) => node.type === "text" && !node.marks?.length)
  ) {
    return undefined;
  }
  return block.content.map((node) => node.text ?? "").join("");
}

const maxSourceLength = 500_000;
