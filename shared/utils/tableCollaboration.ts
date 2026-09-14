import type { IRange, IWorkbookData } from "@univerjs/core";
import {
  deserializeRangeWithSheet,
  LexerTreeBuilder,
  quoteSheetName,
  serializeRange,
} from "@univerjs/engine-formula";
import { v4 as uuid } from "uuid";
import * as Y from "yjs";
import { z } from "zod";
import { UniverTableSchema } from "./tableDocument";

/** The version of the open-source workbook collaboration representation. */
export const TABLE_COLLABORATION_VERSION = 1;

/** Bounds both wire updates and the materialized collaboration state. */
export const TABLE_COLLABORATION_LIMIT = 4 * 1024 * 1024;

/** Stable identities corresponding to the rows and columns displayed by Univer. */
export interface TableSheetLayout {
  rows: string[];
  columns: string[];
}

/** A view's coordinates, kept separate from incoming changes until applied. */
export interface TableLayout {
  [sheetId: string]: TableSheetLayout;
}

/** A committed state response; the update may be relative to a client vector. */
export const TableCollaborationResponseSchema = z.object({
  epoch: z.uuid(),
  revision: z.number().int().positive(),
  barrierRevision: z.number().int().nonnegative(),
  title: z.string(),
  update: z.string(),
  vector: z.string(),
});

/** The authenticated collaboration API's response data. */
export type TableCollaborationResponse = z.infer<
  typeof TableCollaborationResponseSchema
>;

/** JSON is the boundary between native plugin data and the shared map. */
export type TableJson =
  | string
  | number
  | boolean
  | null
  | TableJson[]
  | TableJsonObject;

/** A validated JSON object, including native extension fields. */
export interface TableJsonObject {
  [key: string]: TableJson;
}

const jsonSchema: z.ZodType<TableJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(
      z
        .string()
        .refine(
          (key) => !["__proto__", "prototype", "constructor"].includes(key)
        ),
      jsonSchema
    ),
  ])
);
const lexer = new LexerTreeBuilder();
const rangeMarker = "$outlineCollaborationRange";
const formulaMarker = "$outlineCollaborationFormula";
const literalMarker = "$outlineCollaborationLiteral";

interface AxisCoordinates {
  positions: Map<string, number>;
  next: number[];
  previous: number[];
  order: string[];
}

interface TableDecoder {
  doc: Y.Doc;
  layout: TableLayout;
  sheets: TableJsonObject;
  positions: Record<
    string,
    { rows: Map<string, number>; columns: Map<string, number> }
  >;
  axes: Map<string, AxisCoordinates>;
}

/**
 * Seeds a shared workbook exactly once, on the server under the document lock.
 *
 * @param workbook the native snapshot to preserve.
 * @returns the initialized shared document.
 */
export function createTableCollaboration(workbook: IWorkbookData): Y.Doc {
  const doc = new Y.Doc();
  const layout = createTableLayout(workbook);
  doc.transact(() => {
    const properties = doc.getMap<string>("properties");
    properties.set(key("version"), String(TABLE_COLLABORATION_VERSION));
    doc.getArray<string>("sheets").insert(0, workbook.sheetOrder);
    for (const [sheetId, axes] of Object.entries(layout)) {
      for (const axis of ["rows", "columns"] as const) {
        doc.getArray<string>(axisKey(sheetId, axis)).insert(0, axes[axis]);
      }
    }
    for (const [path, value] of flatten(workbook, layout)) {
      properties.set(path, value);
    }
  });
  return doc;
}

/**
 * Returns the stable coordinates currently visible in the shared workbook.
 *
 * @param doc the shared workbook.
 * @returns a detached layout, safe to retain while the user edits a cell.
 */
export function getTableLayout(doc: Y.Doc): TableLayout {
  const properties = doc.getMap<string>("properties");
  return Object.fromEntries(
    visibleSheets(doc).map((sheetId) => [
      sheetId,
      {
        rows: visibleAxis(doc, properties, sheetId, "rows"),
        columns: visibleAxis(doc, properties, sheetId, "columns"),
      },
    ])
  );
}

/**
 * Creates identities for an initial native view or a newly inserted worksheet.
 *
 * @param workbook the native snapshot.
 * @returns stable coordinates for its existing rows and columns.
 */
export function createTableLayout(workbook: IWorkbookData): TableLayout {
  return Object.fromEntries(
    workbook.sheetOrder.map((sheetId) => {
      const sheet = workbook.sheets[sheetId];
      return [
        sheetId,
        {
          rows: Array.from(
            { length: sheet.rowCount ?? 1000 },
            (_, i) => `r${i}`
          ),
          columns: Array.from(
            { length: sheet.columnCount ?? 26 },
            (_, i) => `c${i}`
          ),
        },
      ];
    })
  );
}

/**
 * Tracks native insertion/deletion without changing any cell's stable address.
 * Other mutations are captured through the native snapshot diff.
 *
 * @param layout the view's mutable coordinate map.
 * @param id the executed native mutation identifier.
 * @param params its serializable parameters.
 */
export function trackTableStructure(
  layout: TableLayout,
  id: string,
  params?: object
): void {
  const parsed = z
    .object({
      subUnitId: z.string(),
      range: z.object({
        startRow: z.number().int(),
        endRow: z.number().int(),
        startColumn: z.number().int(),
        endColumn: z.number().int(),
      }),
    })
    .safeParse(params);
  if (!parsed.success) {
    return;
  }
  const { subUnitId, range } = parsed.data;
  const sheet = layout[subUnitId];
  if (!sheet) {
    return;
  }
  const rows =
    id === "sheet.mutation.insert-row" || id === "sheet.mutation.remove-rows";
  const columns =
    id === "sheet.mutation.insert-col" || id === "sheet.mutation.remove-col";
  if (!rows && !columns) {
    return;
  }
  const axis = rows ? sheet.rows : sheet.columns;
  const start = rows ? range.startRow : range.startColumn;
  const count = (rows ? range.endRow : range.endColumn) - start + 1;
  if (id.includes("insert")) {
    axis.splice(start, 0, ...Array.from({ length: count }, () => uuid()));
  } else {
    axis.splice(start, count);
  }
}

/**
 * Applies only this view's edits, preserving unrelated concurrent changes.
 * Removed rows retain their cell data so undo can restore concurrent edits.
 *
 * @param doc the shared workbook.
 * @param before the snapshot this view was displaying.
 * @param after the snapshot after the local native operation.
 * @param oldLayout the coordinates of the previous snapshot.
 * @param layout the coordinates after tracking native structural mutations.
 * @param origin the local origin tracked by the undo manager.
 */
export function captureTableChanges(
  doc: Y.Doc,
  before: IWorkbookData,
  after: IWorkbookData,
  oldLayout: TableLayout,
  layout: TableLayout,
  origin: object
): void {
  reconcileLayout(after, layout);
  const previous = flatten(before, oldLayout);
  const next = flatten(after, layout);
  const properties = doc.getMap<string>("properties");
  const structureChanged = JSON.stringify(oldLayout) !== JSON.stringify(layout);
  doc.transact(() => {
    syncOrder(
      doc.getArray<string>("sheets"),
      before.sheetOrder,
      after.sheetOrder
    );
    for (const sheetId of before.sheetOrder) {
      if (!after.sheets[sheetId]) {
        properties.set(key("deletedSheet", sheetId), "true");
      }
    }
    for (const sheetId of after.sheetOrder) {
      if (!before.sheets[sheetId]) {
        properties.delete(key("deletedSheet", sheetId));
      }
      for (const axis of ["rows", "columns"] as const) {
        const oldIds = oldLayout[sheetId]?.[axis] ?? [];
        const ids = layout[sheetId][axis];
        const list = doc.getArray<string>(axisKey(sheetId, axis));
        syncOrder(list, oldIds, ids);
        const remaining = new Set(ids);
        for (const id of oldIds) {
          if (!remaining.has(id)) {
            properties.set(key("deleted", sheetId, axis, id), "true");
          }
        }
      }
    }
    const currentLayout = structureChanged ? getTableLayout(doc) : layout;
    const names: TableJsonObject = Object.fromEntries(
      Object.keys(currentLayout).map((id) => [
        id,
        { name: after.sheets[id]?.name ?? "" },
      ])
    );
    const decoder = createDecoder(doc, currentLayout, names);
    for (const [path, value] of next) {
      if (previous.get(path) !== value) {
        const original = previous.get(path);
        if (original && structureChanged) {
          // Native commands rewrite formula/range coordinates after inserting
          // or deleting rows. Preserve the anchored value when its meaning did
          // not change, so this derived rewrite cannot overwrite a peer's edit.
          if (
            JSON.stringify(
              decodeValue(jsonSchema.parse(JSON.parse(original)), decoder)
            ) ===
            JSON.stringify(
              decodeValue(jsonSchema.parse(JSON.parse(value)), decoder)
            )
          ) {
            continue;
          }
        }
        properties.set(path, value);
      }
    }
    for (const path of previous.keys()) {
      if (next.has(path)) {
        continue;
      }
      const [kind, sheetId, rowId, columnId] = parseKey(path);
      if (sheetId && !after.sheets[sheetId] && kind !== "workbook") {
        continue;
      }
      if (
        kind === "cell" &&
        (!layout[sheetId]?.rows.includes(rowId) ||
          !layout[sheetId]?.columns.includes(columnId))
      ) {
        continue;
      }
      if (kind === "row" && !layout[sheetId]?.rows.includes(rowId)) {
        continue;
      }
      if (kind === "column" && !layout[sheetId]?.columns.includes(rowId)) {
        continue;
      }
      properties.delete(path);
    }
  }, origin);
}

/**
 * Materializes a validated native workbook for rendering, export and storage.
 * Formula and range references follow stable identities through structural edits.
 *
 * @param doc the shared document to validate and materialize.
 * @returns a complete native snapshot with extension fields preserved.
 * @throws {Error} if the shared representation is invalid or too large.
 */
export function materializeTable(doc: Y.Doc): IWorkbookData {
  const properties = doc.getMap<string>("properties");
  if (properties.get(key("version")) !== String(TABLE_COLLABORATION_VERSION)) {
    throw new Error("Unsupported table collaboration version");
  }
  const layout = getTableLayout(doc);
  const sheetOrder = visibleSheets(doc);
  const workbook: TableJsonObject = { sheets: {}, sheetOrder, styles: {} };
  const sheets: TableJsonObject = {};
  const decoder = createDecoder(doc, layout, sheets);
  workbook.sheets = sheets;
  for (const sheetId of sheetOrder) {
    const axes = layout[sheetId];
    if (
      !axes.rows.length ||
      !axes.columns.length ||
      axes.rows.length + axes.columns.length > 100000
    ) {
      throw new Error("Invalid table dimensions");
    }
    sheets[sheetId] = {
      id: sheetId,
      rowCount: axes.rows.length,
      columnCount: axes.columns.length,
      cellData: {},
      rowData: {},
      columnData: {},
    };
  }
  // Names must be available before rendering cross-sheet references.
  for (const sheetId of sheetOrder) {
    const value = properties.get(key("sheet", sheetId, "name"));
    if (value) {
      const sheet = asObject(sheets[sheetId]);
      sheet.name = jsonSchema.parse(JSON.parse(value));
    }
  }
  for (const [path, text] of properties) {
    const [kind, sheetId, first, second, field] = parseKey(path);
    if (
      !["workbook", "style", "sheet", "cell", "row", "column"].includes(kind)
    ) {
      continue;
    }
    const raw = jsonSchema.parse(JSON.parse(text));
    const value = decodeValue(raw, decoder);
    if (kind === "style") {
      asObject(workbook.styles)[sheetId] = value;
      continue;
    }
    if (kind === "workbook") {
      workbook[sheetId] = value;
      continue;
    }
    const sheet = sheets[sheetId];
    if (!sheet) {
      continue;
    }
    const target = asObject(sheet);
    if (kind === "sheet") {
      target[first] = value;
      continue;
    }
    const row = decoder.positions[sheetId].rows.get(first) ?? -1;
    const col =
      decoder.positions[sheetId].columns.get(
        kind === "cell" ? second : first
      ) ?? -1;
    if (kind === "cell" && row >= 0 && col >= 0) {
      const rows = asObject(target.cellData);
      const cells = asObject(rows[row] ?? (rows[row] = {}));
      const cell = asObject(cells[col] ?? (cells[col] = {}));
      if (field === "content") {
        Object.assign(cell, asObject(value));
      } else {
        cell[field] = value;
      }
    } else if (kind === "row" && row >= 0) {
      asObject(target.rowData)[row] = value;
    } else if (kind === "column" && col >= 0) {
      asObject(target.columnData)[col] = value;
    }
  }
  const result = UniverTableSchema.parse({
    format: "outline-table",
    version: 2,
    workbook,
  });
  const visible = Object.values(result.workbook.sheets);
  const names = visible
    .map((sheet) => sheet.name?.toLocaleLowerCase())
    .filter(Boolean);
  if (
    !visible.some((sheet) => sheet.hidden !== 1) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(
      "A workbook needs a visible sheet and unique worksheet names"
    );
  }
  return result.workbook;
}

/**
 * Validates a decoded Yjs update before it can affect the authoritative document.
 *
 * @param doc the candidate state.
 * @throws {Error} if the state contains unsupported roots, pending structs or excessive data.
 */
export function validateTableCollaboration(doc: Y.Doc): void {
  if (doc.store.pendingStructs || doc.store.pendingDs) {
    throw new Error("Incomplete table update; synchronize before submitting");
  }
  for (const name of doc.share.keys()) {
    if (name === "properties") {
      const properties = doc.getMap<string>(name);
      if (!(properties instanceof Y.Map) || properties.size > 100000) {
        throw new Error("Invalid table properties");
      }
      for (const item of properties.values()) {
        if (typeof item !== "string") {
          throw new Error("Invalid table property");
        }
      }
    } else if (name === "sheets" || name.startsWith("axis:")) {
      const axis = doc.getArray<string>(name);
      if (
        !(axis instanceof Y.Array) ||
        axis.length > 100000 ||
        !axis
          .toArray()
          .every((item) => typeof item === "string" && item.length <= 255)
      ) {
        throw new Error("Invalid table identities");
      }
    } else {
      throw new Error("Unexpected table collaboration root");
    }
  }
  if (Y.encodeStateAsUpdate(doc).byteLength > TABLE_COLLABORATION_LIMIT) {
    throw new Error("Table collaboration state is too large");
  }
}

/**
 * Encodes bytes for the authenticated JSON transport and durable browser draft.
 *
 * @param bytes the Yjs update or state vector.
 * @returns base64 without spreading large buffers onto the call stack.
 */
export function encodeTableBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/**
 * Decodes a bounded update without accepting malformed base64.
 *
 * @param value the wire or draft representation.
 * @returns the decoded bytes.
 * @throws {Error} if the input is invalid or too large.
 */
export function decodeTableBytes(value: string): Uint8Array {
  if (
    value.length > (TABLE_COLLABORATION_LIMIT * 4) / 3 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new Error("Invalid table update encoding");
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function key(...parts: string[]): string {
  return JSON.stringify(parts);
}
function parseKey(path: string): string[] {
  return z
    .array(
      z
        .string()
        .refine(
          (value) => !["__proto__", "prototype", "constructor"].includes(value)
        )
    )
    .parse(JSON.parse(path));
}
function axisKey(sheetId: string, axis: string): string {
  return `axis:${key(sheetId, axis)}`;
}
function asObject(value: TableJson): TableJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected table object");
  }
  return value;
}
function json(value: object): TableJsonObject {
  return asObject(jsonSchema.parse(JSON.parse(JSON.stringify(value))));
}
function visibleSheets(doc: Y.Doc): string[] {
  const properties = doc.getMap<string>("properties");
  return [...new Set(doc.getArray<string>("sheets").toArray())].filter(
    (id) => !properties.has(key("deletedSheet", id))
  );
}
function visibleAxis(
  doc: Y.Doc,
  properties: Y.Map<string>,
  sheetId: string,
  axis: string
): string[] {
  return [
    ...new Set(doc.getArray<string>(axisKey(sheetId, axis)).toArray()),
  ].filter((id) => !properties.has(key("deleted", sheetId, axis, id)));
}
function syncOrder(
  list: Y.Array<string>,
  before: string[],
  after: string[]
): void {
  const old = new Set(before);
  for (let i = 0; i < after.length; i++) {
    const id = after[i];
    if (old.has(id)) {
      continue;
    }
    const values = list.toArray();
    const next = after.slice(i + 1).find((item) => values.includes(item));
    const index = next === undefined ? values.length : values.indexOf(next);
    list.insert(index, [id]);
  }
  const commonBefore = before.filter((id) => after.includes(id));
  const commonAfter = after.filter((id) => old.has(id));
  if (JSON.stringify(commonBefore) !== JSON.stringify(commonAfter)) {
    // The API guards native reorder operations with their source revision.
    const retained = list.toArray().filter((id) => !after.includes(id));
    list.delete(0, list.length);
    list.insert(0, [...after, ...retained]);
  }
}
function reconcileLayout(workbook: IWorkbookData, layout: TableLayout): void {
  for (const sheetId of Object.keys(layout)) {
    if (!workbook.sheets[sheetId]) {
      delete layout[sheetId];
    }
  }
  for (const sheetId of workbook.sheetOrder) {
    const sheet = workbook.sheets[sheetId];
    layout[sheetId] ??= { rows: [], columns: [] };
    for (const [axis, count] of [
      ["rows", sheet.rowCount ?? 1000],
      ["columns", sheet.columnCount ?? 26],
    ] as const) {
      const ids = layout[sheetId][axis];
      if (ids.length > count) {
        ids.length = count;
      }
      while (ids.length < count) {
        ids.push(uuid());
      }
    }
  }
}
function flatten(
  workbook: IWorkbookData,
  layout: TableLayout
): Map<string, string> {
  const result = new Map<string, string>();
  const source = json(workbook);
  const put = (path: string, value: TableJson, sheetId: string) =>
    result.set(path, JSON.stringify(encodeValue(value, sheetId, layout)));
  for (const [field, value] of Object.entries(source)) {
    if (!["sheets", "sheetOrder", "styles", "rev"].includes(field)) {
      put(key("workbook", field), value, workbook.sheetOrder[0]);
    }
  }
  for (const [id, style] of Object.entries(workbook.styles ?? {})) {
    put(key("style", id), style ? json(style) : null, workbook.sheetOrder[0]);
  }
  for (const sheetId of workbook.sheetOrder) {
    const sheet = asObject(asObject(source.sheets)[sheetId]);
    const axes = layout[sheetId];
    for (const [field, value] of Object.entries(sheet)) {
      if (
        ![
          "cellData",
          "rowData",
          "columnData",
          "rowCount",
          "columnCount",
        ].includes(field)
      ) {
        put(key("sheet", sheetId, field), value, sheetId);
      }
    }
    for (const [row, cells] of Object.entries(asObject(sheet.cellData ?? {}))) {
      const rowId = axes.rows[Number(row)];
      if (!rowId) {
        continue;
      }
      for (const [col, value] of Object.entries(asObject(cells))) {
        const columnId = axes.columns[Number(col)];
        if (!value || !columnId) {
          continue;
        }
        const cell = asObject(value);
        const content: TableJsonObject = {};
        for (const [field, data] of Object.entries(cell)) {
          if (["v", "f", "p", "t", "si"].includes(field)) {
            if (cell.f && ["v", "t"].includes(field)) {
              continue;
            }
            content[field] =
              field === "f" && typeof data === "string"
                ? encodeFormula(data, sheetId, workbook, layout)
                : encodeValue(data, sheetId, layout);
          } else {
            put(key("cell", sheetId, rowId, columnId, field), data, sheetId);
          }
        }
        if (Object.keys(content).length) {
          result.set(
            key("cell", sheetId, rowId, columnId, "content"),
            JSON.stringify(content)
          );
        }
      }
    }
    for (const [field, kind, axis] of [
      ["rowData", "row", "rows"],
      ["columnData", "column", "columns"],
    ] as const) {
      for (const [index, value] of Object.entries(
        asObject(sheet[field] ?? {})
      )) {
        const id = axes[axis][Number(index)];
        if (id && value) {
          put(key(kind, sheetId, id), value, sheetId);
        }
      }
    }
  }
  return result;
}
function encodeValue(
  value: TableJson,
  sheetId: string,
  layout: TableLayout
): TableJson {
  if (Array.isArray(value)) {
    return value.map((item) => encodeValue(item, sheetId, layout));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (
    [rangeMarker, formulaMarker, literalMarker].some(
      (marker) => marker in value
    )
  ) {
    return { [literalMarker]: value };
  }
  if (
    ["startRow", "endRow", "startColumn", "endColumn"].every(
      (field) => typeof value[field] === "number"
    )
  ) {
    return encodeRange(value, sheetId, layout);
  }
  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => [
      field,
      encodeValue(item, sheetId, layout),
    ])
  );
}
function encodeRange(
  range: TableJsonObject,
  sheetId: string,
  layout: TableLayout
): TableJsonObject {
  const axes = layout[sheetId];
  if (!axes) {
    return range;
  }
  const coordinates = { ...range };
  const anchors: TableJsonObject = { sheetId, range: coordinates };
  for (const [field, axis] of [
    ["startRow", "rows"],
    ["endRow", "rows"],
    ["startColumn", "columns"],
    ["endColumn", "columns"],
  ] as const) {
    const index = range[field];
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
      anchors[field] = axes[axis][index] ?? {
        offset: index - axes[axis].length,
      };
      coordinates[field] = null;
    }
  }
  return { [rangeMarker]: anchors };
}
function encodeFormula(
  formula: string,
  sheetId: string,
  workbook: IWorkbookData,
  layout: TableLayout
): TableJson {
  const nodes = lexer.sequenceNodesBuilder(formula);
  if (!nodes) {
    return formula;
  }
  const tokens: TableJson[] = nodes.map((node) => {
    if (typeof node === "string") {
      return node;
    }
    if (node.nodeType !== 4) {
      return node.token;
    }
    const ref = deserializeRangeWithSheet(node.token);
    if (ref.unitId) {
      return node.token;
    }
    const target = ref.sheetName
      ? workbook.sheetOrder.find(
          (id) =>
            workbook.sheets[id].name?.toLocaleLowerCase() ===
            ref.sheetName.toLocaleLowerCase()
        )
      : sheetId;
    if (!target) {
      return node.token;
    }
    return {
      reference: encodeRange(json(ref.range), target, layout),
      named: !!ref.sheetName,
    };
  });
  return { [formulaMarker]: tokens };
}
function decodeValue(value: TableJson, decoder: TableDecoder): TableJson {
  if (Array.isArray(value)) {
    return value.map((item) => decodeValue(item, decoder));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value[literalMarker] !== undefined) {
    return value[literalMarker];
  }
  if (value[formulaMarker]) {
    const tokens = z.array(jsonSchema).parse(value[formulaMarker]);
    return (
      "=" +
      tokens
        .map((token) => {
          if (typeof token === "string") {
            return token;
          }
          const item = asObject(token);
          const decoded = decodeRange(
            asObject(asObject(item.reference)[rangeMarker]),
            decoder
          );
          if (!decoded) {
            return "#REF!";
          }
          const anchor = asObject(asObject(item.reference)[rangeMarker]);
          const sheet =
            typeof anchor.sheetId === "string"
              ? decoder.sheets[anchor.sheetId]
              : undefined;
          if (!sheet) {
            return "#REF!";
          }
          const range = z
            .object({
              startRow: z.number().nullable(),
              endRow: z.number().nullable(),
              startColumn: z.number().nullable(),
              endColumn: z.number().nullable(),
            })
            .passthrough()
            .parse(decoded);
          const native: IRange = {
            ...range,
            startRow: range.startRow ?? NaN,
            endRow: range.endRow ?? NaN,
            startColumn: range.startColumn ?? NaN,
            endColumn: range.endColumn ?? NaN,
          };
          return (
            (item.named
              ? `${quoteSheetName(z.string().parse(asObject(sheet).name))}!`
              : "") + serializeRange(native)
          );
        })
        .join("")
    );
  }
  if (value[rangeMarker]) {
    return (
      decodeRange(asObject(value[rangeMarker]), decoder) ??
      asObject(value[rangeMarker]).range
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => [
      field,
      decodeValue(item, decoder),
    ])
  );
}
function decodeRange(
  anchor: TableJsonObject,
  decoder: TableDecoder
): TableJsonObject | undefined {
  const sheetId = z.string().parse(anchor.sheetId);
  const axes = decoder.layout[sheetId];
  if (!axes) {
    return undefined;
  }
  const range = { ...asObject(anchor.range) };
  for (const [start, end, axis] of [
    ["startRow", "endRow", "rows"],
    ["startColumn", "endColumn", "columns"],
  ] as const) {
    const first = anchor[start];
    const last = anchor[end];
    if (typeof first !== "string" || typeof last !== "string") {
      for (const field of [start, end]) {
        const point = anchor[field];
        if (typeof point === "string") {
          const index = decoder.positions[sheetId][axis].get(point);
          if (index === undefined) {
            return undefined;
          }
          range[field] = index;
        } else if (
          point &&
          typeof point === "object" &&
          !Array.isArray(point)
        ) {
          range[field] =
            axes[axis].length +
            z.number().int().nonnegative().parse(point.offset);
        }
      }
      continue;
    }
    const coordinates = getAxisCoordinates(decoder, sheetId, axis);
    const from = coordinates.positions.get(first);
    const to = coordinates.positions.get(last);
    if (from === undefined || to === undefined) {
      return undefined;
    }
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    const liveStart = coordinates.next[low];
    const liveEnd = coordinates.previous[high];
    if (liveStart > high || liveEnd < low) {
      return undefined;
    }
    range[start] =
      decoder.positions[sheetId][axis].get(coordinates.order[liveStart]) ??
      null;
    range[end] =
      decoder.positions[sheetId][axis].get(coordinates.order[liveEnd]) ?? null;
  }
  return range;
}

function createDecoder(
  doc: Y.Doc,
  layout: TableLayout,
  sheets: TableJsonObject
): TableDecoder {
  return {
    doc,
    layout,
    sheets,
    axes: new Map(),
    positions: Object.fromEntries(
      Object.entries(layout).map(([id, axes]) => [
        id,
        {
          rows: new Map(axes.rows.map((value, index) => [value, index])),
          columns: new Map(axes.columns.map((value, index) => [value, index])),
        },
      ])
    ),
  };
}

function getAxisCoordinates(
  decoder: TableDecoder,
  sheetId: string,
  axis: "rows" | "columns"
): AxisCoordinates {
  const path = axisKey(sheetId, axis);
  const cached = decoder.axes.get(path);
  if (cached) {
    return cached;
  }
  const order = [...new Set(decoder.doc.getArray<string>(path).toArray())];
  const active = decoder.positions[sheetId][axis];
  const next = Array.from({ length: order.length }, () => order.length);
  const previous = Array.from({ length: order.length }, () => -1);
  let nearest = order.length;
  for (let i = order.length - 1; i >= 0; i--) {
    if (active.has(order[i])) {
      nearest = i;
    }
    next[i] = nearest;
  }
  nearest = -1;
  for (let i = 0; i < order.length; i++) {
    if (active.has(order[i])) {
      nearest = i;
    }
    previous[i] = nearest;
  }
  const result = {
    order,
    positions: new Map(order.map((id, index) => [id, index])),
    next,
    previous,
  };
  decoder.axes.set(path, result);
  return result;
}
