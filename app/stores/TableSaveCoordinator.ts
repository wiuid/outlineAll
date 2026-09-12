import { z } from "zod";

/** A metadata response acknowledged by the server without changing table contents. */
export interface TableMetadataResult<T> {
  value: T;
  revision: number;
  title: string;
}

interface TableSaveEntry {
  documentId: string;
  hasPending: () => boolean;
  flush: () => Promise<void>;
  updateMetadata?: <T>(
    send: (revision: number) => Promise<TableMetadataResult<T>>
  ) => Promise<T>;
}

/** Coordinates active table editors at navigation and document-action boundaries. */
export class TableSaveCoordinator {
  /**
   * Registers an editor without storing its workbook data globally.
   *
   * @param entry the editor callbacks, including active cell editing state.
   * @returns a function that unregisters the editor.
   */
  register(entry: TableSaveEntry): () => void {
    this.entries.add(entry);
    return () => {
      this.entries.delete(entry);
    };
  }

  /** Whether any mounted table has unacknowledged edits. */
  get hasPending(): boolean {
    return [...this.entries].some((entry) => entry.hasPending());
  }

  /**
   * Commits active cells and saves affected workbooks before an action proceeds.
   *
   * @param documentId an optional document to flush; omitted for subtree actions.
   * @returns a promise resolved after every affected editor is saved.
   * @throws {Error} if any editor cannot save, preventing the dependent action.
   */
  async flush(documentId?: string): Promise<void> {
    for (const entry of this.entries) {
      if (!documentId || entry.documentId === documentId) {
        await entry.flush();
      }
    }
  }

  /**
   * Serializes an ordinary document metadata update with its table's saves.
   *
   * @param documentId the document being updated.
   * @param send the API request, accepting the editor's captured revision.
   * @returns the original API response after updating the editor's revision.
   * @throws {Error} if the editor or the metadata request cannot be saved.
   */
  async updateMetadata<T>(
    documentId: string,
    send: (revision?: number) => Promise<T>
  ): Promise<T> {
    await this.flush(documentId);
    const entry = [...this.entries].find(
      (item) => item.documentId === documentId && item.updateMetadata
    );
    if (!entry?.updateMetadata) {
      return send();
    }
    return entry.updateMetadata(async (revision) => {
      const value = await send(revision);
      const { data } = metadataResponseSchema.parse(value);
      return { value, revision: data.revision, title: data.title };
    });
  }

  private entries = new Set<TableSaveEntry>();
}

/** Mounted editors share action coordination, but keep drafts and revisions private. */
export const tableSaves = new TableSaveCoordinator();

/** Internal router message that waits for table saves before completing navigation. */
export const TABLE_SAVE_PROMPT = "outline:save-tables-before-navigation";

const metadataResponseSchema = z.object({
  data: z.object({
    revision: z.number().int().nonnegative(),
    title: z.string(),
  }),
});
