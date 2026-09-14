import type { ICommandInfo, IRange, IWorkbookData } from "@univerjs/core";
import {
  action,
  computed,
  makeObservable,
  observable,
  runInAction,
} from "mobx";
import * as Y from "yjs";
import { z } from "zod";
import {
  captureTableChanges,
  decodeTableBytes,
  encodeTableBytes,
  getTableLayout,
  materializeTable,
  TableCollaborationResponseSchema,
  trackTableStructure,
  type TableCollaborationResponse,
  type TableLayout,
} from "@shared/utils/tableCollaboration";
import { toError } from "@shared/utils/error";
import {
  groupCollaborationMembers,
  type CollaborationMember,
} from "@shared/utils/collaborationPresence";
import type { UniverTable } from "@shared/utils/tableDocument";
import type {
  TablePresence,
  TableSelection,
} from "@shared/utils/tablePresence";
import { client } from "~/utils/ApiClient";
import { DocumentConflictError } from "~/utils/errors";
import { snapshotTable } from "~/utils/tableWorkbook";
import type { TableMetadataResult } from "./TableSaveCoordinator";

interface Options {
  documentId: string;
  title: string;
  revision: number;
  workbook: IWorkbookData;
  draftKey?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  request?: (
    method: string,
    body: Request
  ) => Promise<TableCollaborationResponse>;
}

interface Request {
  documentId: string;
  epoch?: string;
  vector?: string;
  update?: string;
  title?: string;
  baseRevision?: number;
  exclusiveRevision?: number;
}

const draftSchema = z.object({
  epoch: z.uuid(),
  state: z.string(),
  baseRevision: z.number(),
  title: z.string(),
  savedTitle: z.string(),
  exclusiveRevision: z.number().optional(),
});

/**
 * Owns a table's Yjs state and durable acknowledgements independently of MobX
 * document refreshes. Native coordinates remain stable until the view updates.
 */
export class TableCollaborationSession {
  @observable title: string;
  @observable.ref table: UniverTable;
  @observable baseRevision: number;
  @observable loaded = false;
  @observable isSaving = false;
  @observable conflict = false;
  @observable.ref error?: Error;
  @observable restored = false;
  @observable storageFailed = false;
  @observable.ref peers: TablePresence[] = [];
  doc = new Y.Doc();

  constructor(private readonly options: Options) {
    this.title = options.title;
    this.savedTitle = options.title;
    this.table = snapshotTable(options.workbook);
    this.view = this.table.workbook;
    this.baseRevision = options.revision;
    this.viewRevision = options.revision;
    makeObservable(this);
    this.doc.on("update", this.handleUpdate);
  }

  /** Whether a native operation or title change still needs a database acknowledgement. */
  @computed get dirty(): boolean {
    return this.sequence > this.acknowledged || this.title !== this.savedTitle;
  }

  /** Whether navigation or script execution must wait for a durable save. */
  @computed get hasPending(): boolean {
    return this.dirty || this.isSaving;
  }

  /** People viewing this workbook, with live cell addresses and deduplicated connections. */
  @computed get collaborators(): CollaborationMember[] {
    return groupCollaborationMembers(
      this.peers.map((peer) => {
        const selection = peer.selection;
        const range = selection ? this.selectionRange(selection) : undefined;
        const sheet = selection
          ? this.table.workbook.sheets[selection.sheetId]
          : undefined;
        let column = "";
        let index = (range?.startColumn ?? -1) + 1;
        while (index > 0) {
          index--;
          column = String.fromCharCode(65 + (index % 26)) + column;
          index = Math.floor(index / 26);
        }
        return {
          clientId: peer.clientId,
          userId: peer.userId,
          isEditing: !!range && !!selection?.editing,
          location:
            range && sheet
              ? `${sheet.name}!${column}${range.startRow + 1}`
              : undefined,
        };
      })
    );
  }

  /** The number of local shared transactions available to undo. */
  get undoCount(): number {
    return this.undoManager?.undoStack.length ?? 0;
  }

  /** The number of previously undone local transactions available to redo. */
  get redoCount(): number {
    return this.undoManager?.redoStack.length ?? 0;
  }

  /**
   * Initializes from the server, restoring a draft only into its original epoch.
   *
   * @returns completion of the initial synchronization.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.loadInitial().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Fetches missing changes after a WebSocket notification or reconnection.
   *
   * @returns completion of the current reconciliation.
   */
  async refresh(): Promise<void> {
    if (this.conflict) {
      return;
    }
    if (!this.loaded) {
      return this.load();
    }
    if (this.inflight) {
      this.refreshPending = true;
      return this.inflight;
    }
    this.inflight = this.read().finally(() => {
      this.inflight = undefined;
      this.drainRefresh();
    });
    return this.inflight;
  }

  /**
   * Accepts native initialization and adopts the coordinates displayed by the view.
   *
   * @param workbook the initialized or remotely patched native snapshot.
   */
  @action initialize(workbook: IWorkbookData): void {
    this.view = snapshotTable(workbook).workbook;
    this.layout = getTableLayout(this.doc);
    this.viewLayout = structuredClone(this.layout);
    this.viewRevision = this.baseRevision;
    this.table = snapshotTable(workbook);
  }

  /**
   * Records native structural mutations before capturing their resulting snapshot.
   *
   * @param command the native data mutation executed by the current user.
   */
  track(command: Readonly<ICommandInfo>): void {
    trackTableStructure(this.layout, command.id, command.params);
    if (
      /\.(move-|reorder-|sort-|insert-range|delete-range)/.test(command.id) ||
      command.id.includes("worksheet-merge") ||
      [
        "sheet.mutation.set-worksheet-order",
        "sheet.mutation.set-worksheet-name",
        "sheet.mutation.set-worksheet-hidden",
        "sheet.mutation.insert-sheet",
        "sheet.mutation.remove-sheet",
      ].includes(command.id)
    ) {
      this.exclusiveRevision ??= this.viewRevision;
      this.exclusiveGeneration++;
    }
  }

  /**
   * Captures only local differences, even if remote changes are waiting behind IME.
   *
   * @param workbook the native snapshot after the user's command.
   */
  @action capture(workbook: IWorkbookData): void {
    if (!this.loaded) {
      this.table = snapshotTable(workbook);
      return;
    }
    const next = snapshotTable(workbook).workbook;
    if (
      JSON.stringify(this.view.resources) !== JSON.stringify(next.resources)
    ) {
      this.exclusiveRevision ??= this.viewRevision;
      this.exclusiveGeneration++;
    }
    this.undoManager?.addToScope([...this.doc.share.values()]);
    const undoCount = this.undoCount;
    captureTableChanges(
      this.doc,
      this.view,
      next,
      this.viewLayout,
      this.layout,
      this.origin
    );
    if (this.exclusiveRevision !== undefined && this.undoCount > undoCount) {
      this.undoManager?.undoStack.at(-1)?.meta.set("exclusive", true);
    }
    this.view = next;
    this.viewLayout = structuredClone(this.layout);
    this.table = snapshotTable(materializeTable(this.doc));
    this.persistDraft();
    this.schedule();
  }

  /**
   * Changes the Outline title without sending an unrelated workbook replacement.
   *
   * @param title the new document title.
   */
  @action setTitle(title: string): void {
    if (!this.loaded) {
      return;
    }
    this.title = title;
    this.persistDraft();
    this.schedule();
  }

  /**
   * Waits for all local changes, including those made during a request, to commit.
   *
   * @returns completion after the database has acknowledged the current changes.
   * @throws {Error} if a save fails; the local recovery copy remains available.
   */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    await this.load();
    if (this.conflict) {
      throw this.error ?? new DocumentConflictError();
    }
    while (this.dirty || this.inflight) {
      if (!this.inflight) {
        this.inflight = this.save().finally(() => {
          this.inflight = undefined;
          this.drainRefresh();
        });
      }
      await this.inflight;
    }
  }

  /**
   * Coordinates metadata APIs with the latest durable collaborative revision.
   *
   * @param send the metadata request receiving the current revision.
   * @returns the unmodified API result.
   */
  async updateMetadata<T>(
    send: (revision: number) => Promise<TableMetadataResult<T>>
  ): Promise<T> {
    await this.flush();
    await this.refresh();
    const title = this.title;
    const pending = send(this.baseRevision).then((response) => {
      runInAction(() => {
        this.baseRevision = response.revision;
        this.savedTitle = response.title;
        if (this.title === title) {
          this.title = response.title;
        }
      });
      return response.value;
    });
    this.inflight = pending.then(
      () => undefined,
      () => undefined
    );
    try {
      return await pending;
    } finally {
      this.inflight = undefined;
      this.drainRefresh();
    }
  }

  /** Undoes the most recent local transaction without undoing peer edits. */
  undo(): void {
    this.changeHistory("undo");
  }

  /** Redoes a previously undone local transaction. */
  redo(): void {
    this.changeHistory("redo");
  }

  /**
   * Registers a native view for shared changes; application waits for cell editing.
   *
   * @param listener the callback scheduling a native view update.
   * @returns a function removing the subscription.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns the merged snapshot, leaving displayed coordinates unchanged.
   *
   * @returns the current native workbook projection.
   */
  snapshot(): IWorkbookData {
    return materializeTable(this.doc);
  }

  /**
   * Captures a native selection using this view's stable coordinates.
   *
   * @param sheetId the selected worksheet.
   * @param range the native selection.
   * @param editing whether the native cell editor is active.
   * @returns the anchored selection, or undefined before synchronization.
   */
  selection(
    sheetId: string,
    range: IRange,
    editing: boolean
  ): TableSelection | undefined {
    const axes = this.layout[sheetId];
    if (!axes || !this.epoch) {
      return undefined;
    }
    return {
      epoch: this.epoch,
      sheetId,
      editing,
      startRow: axes.rows[Math.min(range.startRow, axes.rows.length - 1)],
      endRow: axes.rows[Math.min(range.endRow, axes.rows.length - 1)],
      startColumn:
        axes.columns[Math.min(range.startColumn, axes.columns.length - 1)],
      endColumn:
        axes.columns[Math.min(range.endColumn, axes.columns.length - 1)],
    };
  }

  /**
   * Projects a peer's selection into the currently displayed workbook.
   *
   * @param selection the authenticated peer's anchored selection.
   * @returns a visible native range, or undefined for a removed or replaced cell.
   */
  selectionRange(selection: TableSelection): IRange | undefined {
    const axes = this.viewLayout[selection.sheetId];
    if (!axes || this.epoch !== selection.epoch) {
      return undefined;
    }
    const range = {
      startRow: axes.rows.indexOf(selection.startRow),
      endRow: axes.rows.indexOf(selection.endRow),
      startColumn: axes.columns.indexOf(selection.startColumn),
      endColumn: axes.columns.indexOf(selection.endColumn),
    };
    return Object.values(range).some((value) => value < 0) ? undefined : range;
  }

  /**
   * Replaces temporary peer presence without adding workbook changes or undo history.
   *
   * @param peers the server-verified roster including this browser connection.
   */
  @action updatePeers(peers: TablePresence[]): void {
    this.peers = peers;
  }

  /**
   * Maps a displayed cell into the shared layout after remote structural changes.
   *
   * @param sheetId the active sheet.
   * @param row the displayed row index.
   * @param column the displayed column index.
   * @returns the corresponding live cell, falling back to the nearest valid cell.
   */
  locate(
    sheetId: string,
    row: number,
    column: number
  ): { row: number; column: number } {
    const current = getTableLayout(this.doc)[sheetId];
    const previous = this.viewLayout[sheetId];
    return {
      row: Math.max(0, current?.rows.indexOf(previous?.rows[row]) ?? row),
      column: Math.max(
        0,
        current?.columns.indexOf(previous?.columns[column]) ?? column
      ),
    };
  }

  /**
   * Exposes a save failure while preserving the local workbook and shared draft.
   *
   * @param error the failure to display.
   */
  @action reportError(error: unknown): void {
    this.error = toError(error);
    if (error instanceof DocumentConflictError) {
      this.conflict = true;
    }
    this.persistDraft();
  }

  /** Removes a draft only after explicit discard or saving it as a separate table. */
  @action discard(): void {
    this.acknowledged = this.sequence;
    this.savedTitle = this.title;
    this.conflict = false;
    this.error = undefined;
    this.removeDraft();
  }

  /** Stops background scheduling; an inflight final save may still complete. */
  dispose(): void {
    clearTimeout(this.timer);
    this.refreshPending = false;
  }

  @observable private sequence = 0;
  @observable private acknowledged = 0;
  @observable private savedTitle: string;
  private epoch?: string;
  private serverVector?: string;
  private view: IWorkbookData;
  private layout: TableLayout = {};
  private viewLayout: TableLayout = {};
  private viewRevision: number;
  private pendingRevision?: number;
  private exclusiveRevision?: number;
  private exclusiveGeneration = 0;
  private readonly origin = {};
  private undoManager?: Y.UndoManager;
  private inflight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshPending = false;
  private readonly listeners = new Set<() => void>();

  private changeHistory(direction: "undo" | "redo"): void {
    const manager = this.undoManager;
    if (!manager || this.conflict) {
      return;
    }
    const stack = direction === "undo" ? manager.undoStack : manager.redoStack;
    const exclusive = stack.at(-1)?.meta.get("exclusive") === true;
    if (exclusive) {
      this.exclusiveRevision ??= this.viewRevision;
      this.exclusiveGeneration++;
    }
    manager[direction]();
    if (exclusive) {
      const target =
        direction === "undo" ? manager.redoStack : manager.undoStack;
      target.at(-1)?.meta.set("exclusive", true);
    }
  }

  private handleUpdate = (_update: Uint8Array, origin: object): void => {
    if (origin === this.origin || origin === this.undoManager) {
      runInAction(() => {
        this.sequence++;
        this.pendingRevision ??= this.viewRevision;
      });
      this.persistDraft();
      this.schedule();
    }
    for (const listener of this.listeners) {
      listener();
    }
  };

  private async request(
    method: string,
    body: Request
  ): Promise<TableCollaborationResponse> {
    if (this.options.request) {
      return this.options.request(method, body);
    }
    const result = await client.post(
      `/tableCollaboration.${method}`,
      { ...body },
      { tableSave: true, retry: false }
    );
    return TableCollaborationResponseSchema.parse(result.data);
  }

  private async loadInitial(): Promise<void> {
    try {
      const response = await this.request("info", {
        documentId: this.options.documentId,
      });
      const stored = this.options.storage?.getItem(this.draftKey);
      const draft = stored ? draftSchema.parse(JSON.parse(stored)) : undefined;
      if (
        draft &&
        (draft.epoch !== response.epoch ||
          draft.baseRevision < response.barrierRevision)
      ) {
        // Keep both the original epoch and its draft; do not overwrite recovery
        // storage with the new server workbook when reporting this conflict.
        this.epoch = draft.epoch;
        this.pendingRevision = draft.baseRevision;
        this.exclusiveRevision = draft.exclusiveRevision;
        Y.applyUpdate(this.doc, decodeTableBytes(draft.state));
        runInAction(() => {
          this.table = snapshotTable(materializeTable(this.doc));
          this.title = draft.title;
          this.savedTitle = draft.savedTitle;
          this.sequence++;
          this.restored = true;
        });
        throw new DocumentConflictError();
      }
      this.receive(response);
      if (draft) {
        Y.applyUpdate(this.doc, decodeTableBytes(draft.state));
        runInAction(() => {
          this.sequence++;
          this.title = draft.title;
          this.savedTitle = draft.savedTitle;
          this.restored = true;
        });
        this.pendingRevision = draft.baseRevision;
        this.exclusiveRevision = draft.exclusiveRevision;
      }
      this.undoManager = new Y.UndoManager([...this.doc.share.values()], {
        trackedOrigins: new Set([this.origin]),
        captureTimeout: 0,
      });
      runInAction(() => {
        this.table = snapshotTable(materializeTable(this.doc));
        this.loaded = true;
        this.error = undefined;
      });
      this.layout = getTableLayout(this.doc);
      this.viewLayout = structuredClone(this.layout);
      this.schedule();
    } catch (error) {
      this.reportError(error);
      if (this.conflict) {
        runInAction(() => {
          this.loaded = true;
        });
      }
      throw error;
    }
  }

  private async read(): Promise<void> {
    try {
      const response = await this.request("info", {
        documentId: this.options.documentId,
        epoch: this.epoch,
        vector: encodeTableBytes(Y.encodeStateVector(this.doc)),
      });
      this.receive(response);
      runInAction(() => {
        this.error = undefined;
      });
      this.schedule();
    } catch (error) {
      this.reportError(error);
      throw error;
    }
  }

  private receive(
    response: TableCollaborationResponse,
    acknowledged = false
  ): void {
    const replaced = this.epoch !== undefined && this.epoch !== response.epoch;
    if (
      (replaced && this.dirty) ||
      (!acknowledged &&
        this.dirty &&
        (this.pendingRevision ?? this.baseRevision) < response.barrierRevision)
    ) {
      throw new DocumentConflictError();
    }
    if (replaced) {
      this.undoManager?.destroy();
      this.doc.off("update", this.handleUpdate);
      this.doc.destroy();
      this.doc = new Y.Doc();
      this.doc.on("update", this.handleUpdate);
      this.exclusiveRevision = undefined;
    }
    const renamePending = this.title !== this.savedTitle;
    this.epoch = response.epoch;
    this.serverVector = response.vector;
    runInAction(() => {
      this.baseRevision = response.revision;
      if (!renamePending) {
        this.title = response.title;
        this.savedTitle = response.title;
      }
    });
    Y.applyUpdate(this.doc, decodeTableBytes(response.update));
    // Deletes can change the visible workbook without adding state-vector clocks.
    // Notify after every reply so reconnect and title-only changes are rendered.
    for (const listener of this.listeners) {
      listener();
    }
    if (replaced) {
      materializeTable(this.doc);
      this.undoManager = new Y.UndoManager([...this.doc.share.values()], {
        trackedOrigins: new Set([this.origin]),
        captureTimeout: 0,
      });
    }
  }

  private async save(): Promise<void> {
    const sequence = this.sequence;
    const title = this.title;
    const exclusiveRevision = this.exclusiveRevision;
    const exclusiveGeneration = this.exclusiveGeneration;
    runInAction(() => {
      this.isSaving = true;
    });
    try {
      const response = await this.request("update", {
        documentId: this.options.documentId,
        epoch: this.epoch,
        vector: encodeTableBytes(Y.encodeStateVector(this.doc)),
        update: encodeTableBytes(
          Y.encodeStateAsUpdate(
            this.doc,
            this.serverVector ? decodeTableBytes(this.serverVector) : undefined
          )
        ),
        ...(title !== this.savedTitle && { title }),
        baseRevision: this.pendingRevision ?? this.baseRevision,
        exclusiveRevision,
      });
      this.receive(response, true);
      runInAction(() => {
        this.acknowledged = sequence;
        this.savedTitle = response.title;
        if (this.title === title) {
          this.title = response.title;
        }
        this.error = undefined;
        this.restored = false;
      });
      if (this.exclusiveGeneration === exclusiveGeneration) {
        this.exclusiveRevision = undefined;
      }
      this.pendingRevision = this.dirty ? response.revision : undefined;
      this.persistDraft();
    } catch (error) {
      this.reportError(error);
      throw error;
    } finally {
      runInAction(() => {
        this.isSaving = false;
      });
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.loaded || !this.dirty || this.conflict) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {
        /* The editor displays recoverable failures. */
      });
    }, 250);
  }

  private drainRefresh(): void {
    if (!this.refreshPending || this.conflict) {
      return;
    }
    this.refreshPending = false;
    queueMicrotask(() => {
      void this.refresh().catch(() => {
        /* The editor displays the error. */
      });
    });
  }

  private get draftKey(): string {
    return `${this.options.draftKey}:collaboration`;
  }

  private persistDraft(): void {
    if (!this.options.storage || !this.options.draftKey || !this.epoch) {
      return;
    }
    try {
      if (!this.dirty && !this.conflict) {
        this.removeDraft();
        return;
      }
      this.options.storage.setItem(
        this.draftKey,
        JSON.stringify({
          epoch: this.epoch,
          state: encodeTableBytes(Y.encodeStateAsUpdate(this.doc)),
          baseRevision: this.pendingRevision ?? this.baseRevision,
          title: this.title,
          savedTitle: this.savedTitle,
          exclusiveRevision: this.exclusiveRevision,
        })
      );
    } catch {
      runInAction(() => {
        this.storageFailed = true;
      });
    }
  }

  private removeDraft(): void {
    try {
      this.options.storage?.removeItem(this.draftKey);
    } catch {
      runInAction(() => {
        this.storageFailed = true;
      });
    }
  }
}
