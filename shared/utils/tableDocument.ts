import type { IWorkbookData } from "@univerjs/core";
import { z } from "zod";
import type { ProsemirrorData } from "../types";
import { DocumentValidation } from "../validations";
import {
  getTableSource,
  LightweightTableSchema,
  tableSourceToMarkdown,
} from "./lightweightTable";

/** A native Univer workbook transported through Outline's Markdown document. */
export const UniverTableSchema = z.strictObject({
  format: z.literal("outline-table"),
  version: z.literal(2),
  workbook: z.custom<IWorkbookData>(isWorkbook, {
    message: "Invalid Univer workbook snapshot",
  }),
});

/** Both stored formats remain readable; new edits use native Univer snapshots. */
export const TableDocumentSchema = z
  .union([LightweightTableSchema, UniverTableSchema])
  .refine(
    (table) =>
      tableSourceToMarkdown(JSON.stringify(table, null, 2)).length <=
      DocumentValidation.maxLength,
    { message: "Table source is too large" }
  );

/** Native workbook document content, including extension resources. */
export type UniverTable = z.infer<typeof UniverTableSchema>;
/** A supported table document in either version. */
export type TableDocumentContent = z.infer<typeof TableDocumentSchema>;

/**
 * Serializes a table without removing native worksheet, style or plugin fields.
 *
 * @param table the supported table document.
 * @returns Markdown suitable for the existing create, update and export APIs.
 * @throws {z.ZodError} if the table is invalid or exceeds the document limit.
 */
export function tableDocumentToMarkdown(table: TableDocumentContent): string {
  return tableSourceToMarkdown(
    JSON.stringify(TableDocumentSchema.parse(table), null, 2)
  );
}

/**
 * Recognizes a supported whole-document table without changing ordinary Markdown.
 *
 * @param data the persisted ProseMirror document.
 * @returns the table, or undefined for ordinary, annotated or unsupported content.
 */
export function getTableDocument(
  data?: ProsemirrorData
): TableDocumentContent | undefined {
  const source = getTableSource(data);
  if (source === undefined || source.length > DocumentValidation.maxLength) {
    return undefined;
  }
  try {
    const result = TableDocumentSchema.safeParse(JSON.parse(source));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

// Validate the native envelope and structural fields, while leaving Univer's
// styles and plugin resources intact. Rebuilding its entire model here would
// discard capabilities whenever Univer adds fields. The JSON walk also rejects
// prototype keys, non-JSON values and excessive nesting before library use.
const workbookShape = z.object({
  id: z.string().min(1).max(255),
  name: z.string(),
  appVersion: z.string().min(1),
  locale: z.enum([
    "enUS",
    "frFR",
    "zhCN",
    "ruRU",
    "zhTW",
    "zhHK",
    "viVN",
    "faIR",
    "jaJP",
    "koKR",
    "esES",
    "caES",
    "skSK",
    "ptBR",
    "deDE",
    "itIT",
    "idID",
    "plPL",
    "arSA",
  ]),
  styles: z.record(z.string(), z.record(z.string(), z.unknown()).nullable()),
  sheetOrder: z.array(z.string().min(1)).min(1),
  sheets: z.record(
    z.string(),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      rowCount: z.number().int().positive().optional(),
      columnCount: z.number().int().positive().optional(),
      cellData: z
        .record(
          z.string().regex(/^\d+$/),
          z.record(
            z.string().regex(/^\d+$/),
            z
              .object({
                v: z.union([z.string(), z.number(), z.boolean()]).nullish(),
                f: z.string().nullish(),
                s: z
                  .union([z.string(), z.record(z.string(), z.unknown())])
                  .nullish(),
                p: z.record(z.string(), z.unknown()).nullish(),
                t: z.number().int().nullish(),
              })
              .nullable()
          )
        )
        .optional(),
      mergeData: z
        .array(
          z
            .object({
              startRow: z.number().int().nonnegative(),
              endRow: z.number().int().nonnegative(),
              startColumn: z.number().int().nonnegative(),
              endColumn: z.number().int().nonnegative(),
            })
            .refine(
              (range) =>
                range.endRow >= range.startRow &&
                range.endColumn >= range.startColumn
            )
        )
        .optional(),
      rowData: z
        .record(z.string(), z.record(z.string(), z.unknown()).nullable())
        .optional(),
      columnData: z
        .record(z.string(), z.record(z.string(), z.unknown()).nullable())
        .optional(),
    })
  ),
  resources: z
    .array(z.object({ name: z.string(), data: z.string() }))
    .optional(),
});

function isWorkbook(value: unknown): value is IWorkbookData {
  if (!isJsonValue(value, new Set(), 0)) {
    return false;
  }
  const result = workbookShape.safeParse(value);
  if (!result.success) {
    return false;
  }
  const { sheets, sheetOrder } = result.data;
  return (
    new Set(sheetOrder).size === sheetOrder.length &&
    Object.keys(sheets).length === sheetOrder.length &&
    sheetOrder.every(
      (id) =>
        Object.prototype.hasOwnProperty.call(sheets, id) &&
        (!sheets[id].id || sheets[id].id === id)
    )
  );
}

function isJsonValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number
): boolean {
  if (depth > 64) {
    return false;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  ancestors.add(value);
  const valid = Object.entries(value).every(
    ([key, child]) =>
      !["__proto__", "prototype", "constructor"].includes(key) &&
      isJsonValue(child, ancestors, depth + 1)
  );
  ancestors.delete(value);
  return valid;
}
