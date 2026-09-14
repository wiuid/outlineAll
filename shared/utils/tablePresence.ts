import { z } from "zod";

const identity = z.string().min(1).max(255);

/** A selection uses stable coordinates, so inserting a row cannot move a peer's cursor to another cell. */
export const TableSelectionSchema = z.object({
  epoch: z.uuid(),
  sheetId: identity,
  startRow: identity,
  endRow: identity,
  startColumn: identity,
  endColumn: identity,
  editing: z.boolean(),
});

/** The current cell or selected range advertised by a connected table view. */
export type TableSelection = z.infer<typeof TableSelectionSchema>;

/** The server supplies identity and display fields; clients only supply their selection. */
export const TablePresenceSchema = z.object({
  documentId: z.uuid(),
  clientId: identity,
  userId: z.uuid(),
  name: z.string().max(100),
  avatarUrl: z.string().max(4096).nullable().default(null),
  color: z.string().regex(/^#[\da-f]{6}$/i),
  selection: TableSelectionSchema.nullable(),
  updatedAt: z.number().finite(),
});

/** Authenticated, temporary presence; it is never part of workbook persistence or undo. */
export type TablePresence = z.infer<typeof TablePresenceSchema>;

/** The roster sent only to members who can currently read this table. */
export const TableRosterSchema = z.object({
  documentId: z.uuid(),
  peers: z.array(TablePresenceSchema).max(200),
});
