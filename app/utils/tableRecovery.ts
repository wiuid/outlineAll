import * as Y from "yjs";
import { z } from "zod";
import {
  decodeTableBytes,
  materializeTable,
} from "@shared/utils/tableCollaboration";
import {
  UniverTableSchema,
  type UniverTable,
} from "@shared/utils/tableDocument";

/**
 * Reads a legacy or collaborative recovery copy for an explicit local download.
 *
 * @param value the account-scoped stored draft, never sent to the server.
 * @returns a validated table and title, or undefined for an unreadable draft.
 */
export function readTableRecovery(
  value: string
): { title: string; table: UniverTable } | undefined {
  const doc = new Y.Doc();
  try {
    const draft = z
      .object({
        title: z.string(),
        state: z.string().optional(),
        table: UniverTableSchema.optional(),
      })
      .parse(JSON.parse(value));
    if (draft.table) {
      return { title: draft.title, table: draft.table };
    }
    if (!draft.state) {
      return undefined;
    }
    Y.applyUpdate(doc, decodeTableBytes(draft.state));
    return {
      title: draft.title,
      table: {
        format: "outline-table",
        version: 2,
        workbook: materializeTable(doc),
      },
    };
  } catch {
    return undefined;
  } finally {
    doc.destroy();
  }
}
