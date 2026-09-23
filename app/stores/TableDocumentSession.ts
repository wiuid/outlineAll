import type { IWorkbookData } from "@univerjs/core";
import {
  action,
  computed,
  makeObservable,
  observable,
  runInAction,
} from "mobx";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { toError } from "@shared/utils/error";
import {
  type UniverTable,
  UniverTableSchema,
  tableDocumentToMarkdown,
} from "@shared/utils/tableDocument";
import { DocumentConflictError } from "~/utils/errors";
import { snapshotTable } from "~/utils/tableWorkbook";
import type { TableMetadataResult } from "./TableSaveCoordinator";

/** A guarded update sent by a table editing session. */
export interface TableSaveRequest {
  title: string;
  text: string;
  lastRevision: number;
}

interface SessionOptions {
  title: string;
  revision: number;
  workbook: IWorkbookData;
  save: (request: TableSaveRequest) => Promise<number>;
  draftKey?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/**
 * Owns an editing session's revision and draft independently of live store updates.
 * Saves are serialized, and a conflict never rebases or discards local content.
 */
export class TableDocumentSession {
  @observable title: string;
  @observable.ref table: UniverTable;
  @observable baseRevision: number;
  @observable isSaving = false;
  @observable conflict = false;
  @observable.ref error?: Error;
  @observable restored = false;
  @observable storageFailed = false;

  constructor(private readonly options: SessionOptions) {
    this.title = options.title;
    this.table = snapshotTable(options.workbook);
    this.baseRevision = options.revision;
    this.savedFingerprint = this.fingerprint;
    makeObservable(this);
    this.restoreDraft();
  }

  /** Whether local edits differ from the last acknowledged snapshot. */
  @computed get dirty(): boolean {
    return this.fingerprint !== this.savedFingerprint;
  }

  /** Whether navigation must wait for this session. */
  @computed get hasPending(): boolean {
    return this.dirty || this.isSaving;
  }

  /**
   * Accepts Univer's initial normalization without treating it as a user edit.
   *
   * @param workbook the first snapshot after mounting Univer.
   */
  @action initialize(workbook: IWorkbookData): void {
    const dirty = this.dirty;
    this.table = snapshotTable(workbook);
    if (!dirty) {
      this.savedFingerprint = this.fingerprint;
      return;
    }
    this.persistDraft();
    this.schedule();
  }

  /**
   * Captures a detached native snapshot after a workbook mutation.
   *
   * @param workbook the current workbook including native plugin resources.
   */
  @action capture(workbook: IWorkbookData): void {
    const next = snapshotTable(workbook);
    if (JSON.stringify(next) === JSON.stringify(this.table)) {
      return;
    }
    this.table = next;
    this.persistDraft();
    this.schedule();
  }

  /**
   * Renames the document in the same guarded save as workbook changes.
   *
   * @param title the local document title.
   */
  @action setTitle(title: string): void {
    if (this.title === title) {
      return;
    }
    this.title = title;
    this.persistDraft();
    this.schedule();
  }

  /**
   * Saves all edits, including edits made while another request was in flight.
   *
   * @returns a promise resolved only after all pending edits are acknowledged.
   * @throws {Error} if saving fails; the local draft remains available.
   */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.conflict) {
      throw this.error ?? new DocumentConflictError();
    }
    while (this.dirty || this.inflight) {
      if (!this.inflight) {
        this.inflight = this.saveSnapshot().finally(() => {
          this.inflight = undefined;
        });
      }
      await this.inflight;
    }
  }

  /**
   * Runs an Outline metadata change between workbook saves using the same revision.
   *
   * @param send the guarded metadata request and its unmodified response.
   * @returns the original response after acknowledging its revision.
   * @throws {Error} if the metadata update is rejected.
   */
  async updateMetadata<T>(
    send: (revision: number) => Promise<TableMetadataResult<T>>
  ): Promise<T> {
    do {
      await this.flush();
    } while (this.dirty || this.inflight);
    const pending = this.saveMetadata(send).finally(() => {
      this.inflight = undefined;
    });
    this.inflight = pending;
    return pending;
  }

  /**
   * Releases the local draft after the user explicitly chooses to discard it.
   */
  @action discard(): void {
    clearTimeout(this.timer);
    this.savedFingerprint = this.fingerprint;
    this.conflict = false;
    this.error = undefined;
    this.removeDraft();
  }

  /** Stops deferred saves; pending data remains in browser storage. */
  dispose(): void {
    clearTimeout(this.timer);
  }

  @observable private savedFingerprint: string;
  private timer?: ReturnType<typeof setTimeout>;
  private inflight?: Promise<unknown>;

  private get fingerprint(): string {
    return JSON.stringify({ title: this.title, table: this.table });
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.dirty || this.conflict) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {
        // The error and recoverable draft are already exposed by saveSnapshot.
      });
    }, 800);
  }

  private async saveSnapshot(): Promise<void> {
    const fingerprint = this.fingerprint;
    runInAction(() => {
      this.isSaving = true;
    });
    try {
      const revision = await this.options.save({
        title: this.title,
        text: tableDocumentToMarkdown(this.table),
        lastRevision: this.baseRevision,
      });
      runInAction(() => {
        this.baseRevision = revision;
        this.savedFingerprint = fingerprint;
        this.error = undefined;
        this.restored = false;
        this.persistDraft();
      });
    } catch (error) {
      runInAction(() => {
        this.error = toError(error);
        this.conflict = error instanceof DocumentConflictError;
        this.persistDraft();
      });
      throw error;
    } finally {
      runInAction(() => {
        this.isSaving = false;
      });
    }
  }

  private async saveMetadata<T>(
    send: (revision: number) => Promise<TableMetadataResult<T>>
  ): Promise<T> {
    const title = this.title;
    const table = this.table;
    runInAction(() => {
      this.isSaving = true;
    });
    try {
      const result = await send(this.baseRevision);
      runInAction(() => {
        this.baseRevision = result.revision;
        if (this.title === title) {
          this.title = result.title;
        }
        this.savedFingerprint = JSON.stringify({ title: result.title, table });
        this.error = undefined;
        this.persistDraft();
      });
      return result.value;
    } catch (error) {
      runInAction(() => {
        this.error = toError(error);
        this.conflict = error instanceof DocumentConflictError;
        this.persistDraft();
      });
      throw error;
    } finally {
      runInAction(() => {
        this.isSaving = false;
      });
    }
  }

  private restoreDraft(): void {
    const { draftKey, storage } = this.options;
    if (!draftKey || !storage) {
      return;
    }
    try {
      const value = storage.getItem(draftKey);
      if (!value) {
        return;
      }
      const draft = draftSchema.parse(JSON.parse(value));
      this.title = draft.title;
      this.table = draft.table;
      this.baseRevision = draft.baseRevision;
      this.restored = this.dirty;
      this.conflict =
        this.dirty && draft.baseRevision !== this.options.revision;
      if (this.conflict) {
        this.error = new DocumentConflictError();
      }
    } catch {
      this.storageFailed = true;
    }
  }

  private persistDraft(): void {
    const { draftKey, storage } = this.options;
    if (!draftKey || !storage) {
      return;
    }
    if (!this.dirty) {
      this.removeDraft();
      return;
    }
    try {
      storage.setItem(
        draftKey,
        JSON.stringify({
          title: this.title,
          table: this.table,
          baseRevision: this.baseRevision,
        })
      );
      this.storageFailed = false;
    } catch {
      this.storageFailed = true;
    }
  }

  private removeDraft(): void {
    try {
      if (this.options.draftKey) {
        this.options.storage?.removeItem(this.options.draftKey);
      }
      this.storageFailed = false;
    } catch {
      this.storageFailed = true;
    }
  }
}

/**
 * Scopes recoverable drafts to the account, document and browser tab.
 *
 * @param teamId the authenticated team identifier.
 * @param userId the authenticated user identifier.
 * @param documentId the edited document identifier.
 * @returns a storage key, or undefined when browser storage is unavailable.
 */
export function getTableDraftKey(
  teamId: string,
  userId: string,
  documentId: string
): string | undefined {
  try {
    const tabKey = "outline-table-editor-tab";
    const tabId = sessionStorage.getItem(tabKey) ?? uuid();
    sessionStorage.setItem(tabKey, tabId);
    return `outline-table-draft:${teamId}:${userId}:${documentId}:${tabId}`;
  } catch {
    return undefined;
  }
}

const draftSchema = z.object({
  title: z.string(),
  baseRevision: z.number().int().nonnegative(),
  table: UniverTableSchema,
});
