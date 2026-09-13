import {
  action,
  computed,
  makeObservable,
  observable,
  runInAction,
} from "mobx";
import type { JSONObject } from "@shared/types";
import {
  defaultTableScript,
  type TableScriptCapabilities,
  type TableScriptDetails,
  type TableScriptExecution,
  type TableScriptSummary,
} from "@shared/types/tableScript";
import { client } from "~/utils/ApiClient";
import { TableScriptConflictError } from "~/utils/errors";
import { tableSaves } from "./TableSaveCoordinator";

/** Views offered by the desktop spreadsheet development panel. */
export type TableScriptPanelMode = "development" | "schedule";

/** Keeps source drafts in memory; code is never persisted to browser storage. */
export class TableScriptSession {
  @observable.ref capabilities: TableScriptCapabilities | undefined = undefined;
  @observable.ref scripts: TableScriptSummary[] = [];
  @observable.ref selected: TableScriptDetails | undefined = undefined;
  @observable.ref runs: TableScriptExecution[] = [];
  @observable mode: TableScriptPanelMode | undefined = undefined;
  @observable name = "";
  @observable source = "";
  @observable cron = "0 9 * * *";
  @observable timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  @observable scheduleEnabled = false;
  @observable busy = false;
  @observable error = "";
  @observable conflict = false;
  @observable selectedRunId: string | undefined = undefined;
  @observable hasMoreRuns = false;

  /**
   * Creates one editor session scoped to a spreadsheet document.
   *
   * @param documentId the containing document UUID.
   */
  constructor(public readonly documentId: string) {
    makeObservable(this);
  }

  /** Whether the displayed source differs from the acknowledged revision. */
  @computed get codeDirty(): boolean {
    return (
      !!this.selected &&
      (this.name !== this.selected.name || this.source !== this.selected.source)
    );
  }

  /** Whether the schedule has unacknowledged edits. */
  @computed get scheduleDirty(): boolean {
    return (
      !!this.selected &&
      (this.cron !== (this.selected.cron ?? "0 9 * * *") ||
        this.timezone !== this.loadedTimezone ||
        this.scheduleEnabled !== this.selected.scheduleEnabled)
    );
  }

  /** Whether navigation would discard code or scheduling edits. */
  @computed get dirty(): boolean {
    return this.codeDirty || this.scheduleDirty;
  }

  /** The selected script's execution that can still be stopped. */
  @computed get activeRun(): TableScriptExecution | undefined {
    return this.runs.find((run) =>
      ["queued", "running", "stopping"].includes(run.status)
    );
  }

  /** The console record chosen from history, defaulting to the latest run. */
  @computed get selectedRun(): TableScriptExecution | undefined {
    return (
      this.runs.find((run) => run.id === this.selectedRunId) ?? this.runs[0]
    );
  }

  /**
   * Reads availability without loading source into the browser.
   *
   * @returns the server-authorized development capability.
   */
  async loadCapabilities(): Promise<void> {
    const data = await request<TableScriptCapabilities>("capabilities", {
      documentId: this.documentId,
    });
    if (this.disposed) {
      return;
    }
    runInAction(() => {
      this.capabilities = data;
      if (!data.canDevelop) {
        this.mode = undefined;
        this.source = this.name = "";
        this.selected = undefined;
        this.scripts = [];
        this.runs = [];
        this.selectedRunId = undefined;
        this.hasMoreRuns = false;
        this.scheduleEnabled = false;
        this.conflict = false;
      }
    });
  }

  /**
   * Opens a panel and loads the document's script list.
   *
   * @param mode the editor or scheduling view.
   * @returns when the selected source is available.
   */
  async open(mode: TableScriptPanelMode): Promise<void> {
    runInAction(() => {
      this.mode = mode;
    });
    await this.perform(async () => {
      await this.loadCapabilities();
      if (!this.capabilities?.canDevelop) {
        throw new Error(
          "Script development is not available for this account."
        );
      }
      const scripts = await request<TableScriptSummary[]>("list", {
        documentId: this.documentId,
      });
      if (this.disposed) {
        return;
      }
      runInAction(() => {
        this.scripts = scripts;
      });
      if (!this.selected && scripts[0]) {
        await this.loadSelected(scripts[0].id);
      }
    });
  }

  /**
   * Changes the view without discarding an in-memory draft.
   *
   * @param mode the next panel view, or undefined to close it.
   */
  @action setMode(mode?: TableScriptPanelMode): void {
    this.mode = mode;
  }

  /**
   * Edits source locally without an automatic save or external request.
   *
   * @param source the Python editor contents.
   */
  @action setSource(source: string): void {
    this.source = source;
  }

  /**
   * Updates local editor metadata.
   *
   * @param values the changed name or schedule fields.
   */
  @action edit(values: {
    name?: string;
    cron?: string;
    timezone?: string;
    scheduleEnabled?: boolean;
  }): void {
    Object.assign(this, values);
  }

  /**
   * Loads a selected script after the caller confirms discarding dirty edits.
   *
   * @param id the script UUID.
   */
  async select(id: string): Promise<void> {
    await this.perform(() => this.loadSelected(id));
  }

  /**
   * Creates an example that only prints data until the developer adds a webhook.
   *
   * @returns when the new saved script is selected.
   */
  async create(): Promise<void> {
    await this.perform(async () => {
      const data = await request<TableScriptDetails>("create", {
        documentId: this.documentId,
        name: `script-${this.scripts.length + 1}.py`,
        source: defaultTableScript,
      });
      if (!this.disposed) {
        this.acceptSelection(data);
      }
    });
  }

  /**
   * Saves the visible code using its original revision, preserving concurrent typing.
   *
   * @returns when the server acknowledges the submitted code.
   */
  async save(): Promise<void> {
    await this.perform(() => this.saveSource());
  }

  /**
   * Saves code and the workbook before submitting exactly one manual execution.
   *
   * @returns when the execution is queued; it is never automatically retried.
   */
  async run(): Promise<void> {
    await this.perform(async () => {
      await this.saveSource();
      await tableSaves.flush(this.documentId);
      const selected = this.requireSelected();
      if (this.codeDirty) {
        throw new Error("Code changed while saving. Save and run again.");
      }
      const run = await request<TableScriptExecution>("run", {
        id: selected.id,
        lastRevision: selected.revision,
      });
      if (this.disposed) {
        return;
      }
      runInAction(() => {
        this.runs = [run, ...this.runs];
        this.selectedRunId = run.id;
      });
    });
  }

  /**
   * Requests termination of the active execution once.
   *
   * @returns when the server acknowledges the stop request.
   */
  async stop(): Promise<void> {
    await this.perform(async () => {
      const active = this.activeRun;
      if (!active) {
        return;
      }
      const run = await request<TableScriptExecution>("stop", {
        id: active.id,
      });
      if (this.disposed) {
        return;
      }
      runInAction(() => {
        this.runs = this.runs.map((item) => (item.id === run.id ? run : item));
      });
    });
  }

  /**
   * Saves the schedule while keeping unsaved source in the editor.
   *
   * @returns when the schedule's revision is acknowledged.
   */
  async saveSchedule(): Promise<void> {
    await this.perform(async () => {
      const selected = this.requireSelected();
      const data = await request<TableScriptDetails>("schedule", {
        id: selected.id,
        lastRevision: selected.revision,
        cron: this.cron,
        timezone: this.timezone,
        enabled: this.scheduleEnabled,
      });
      if (this.disposed) {
        return;
      }
      runInAction(() => {
        this.selected = data;
        this.loadedTimezone = data.timezone;
        this.replaceSummary(data);
      });
    });
  }

  /**
   * Deletes the saved script after an explicit UI confirmation.
   *
   * @returns when deletion and local selection cleanup finish.
   */
  async remove(): Promise<void> {
    await this.perform(async () => {
      const selected = this.requireSelected();
      await request<boolean>("delete", {
        id: selected.id,
        lastRevision: selected.revision,
      });
      if (this.disposed) {
        return;
      }
      runInAction(() => {
        this.scripts = this.scripts.filter(
          (script) => script.id !== selected.id
        );
        this.selected = undefined;
        this.source = this.name = "";
        this.runs = [];
      });
      if (this.scripts[0]) {
        await this.loadSelected(this.scripts[0].id);
      }
    });
  }

  /**
   * Refreshes execution records without changing source or its base revision.
   *
   * @param more whether to append an older page instead of refreshing the latest.
   */
  async refreshRuns(more = false): Promise<void> {
    const id = this.selected?.id;
    if (!id || this.polling || this.disposed) {
      return;
    }
    this.polling = true;
    try {
      const data = await request<TableScriptExecution[]>("runs", {
        id,
        offset: more ? this.runs.length : 0,
        limit: 20,
      });
      if (this.disposed || this.selected?.id !== id) {
        return;
      }
      runInAction(() => {
        this.runs = more ? [...this.runs, ...data] : data;
        this.hasMoreRuns = data.length === 20;
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * Selects one saved console result.
   *
   * @param id the execution UUID.
   */
  @action selectRun(id: string): void {
    this.selectedRunId = id;
  }

  /** Clears sensitive in-memory code when the account session ends. */
  @action dispose(): void {
    this.disposed = true;
    this.source = this.name = "";
    this.selected = undefined;
    this.scripts = [];
    this.runs = [];
    this.capabilities = undefined;
    this.mode = undefined;
  }

  private disposed = false;
  private polling = false;
  @observable private loadedTimezone = this.timezone;

  private async loadSelected(id: string): Promise<void> {
    const data = await request<TableScriptDetails>("info", { id });
    if (this.disposed) {
      return;
    }
    this.acceptSelection(data);
    await this.refreshRuns();
  }

  @action private acceptSelection(data: TableScriptDetails): void {
    this.selected = data;
    this.name = data.name;
    this.source = data.source;
    this.cron = data.cron ?? "0 9 * * *";
    this.timezone = data.cron
      ? data.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    this.loadedTimezone = this.timezone;
    this.scheduleEnabled = data.scheduleEnabled;
    this.runs = [];
    this.selectedRunId = undefined;
    this.conflict = false;
    this.replaceSummary(data);
  }

  private requireSelected(): TableScriptDetails {
    if (this.conflict) {
      throw new TableScriptConflictError(
        "Script changed on the server. Copy your code before reloading."
      );
    }
    if (!this.selected) {
      throw new Error("Select or create a script first.");
    }
    return this.selected;
  }

  private async saveSource(): Promise<void> {
    const selected = this.requireSelected();
    if (!this.codeDirty) {
      return;
    }
    const data = await request<TableScriptDetails>("update", {
      id: selected.id,
      lastRevision: selected.revision,
      name: this.name,
      source: this.source,
    });
    if (this.disposed) {
      return;
    }
    runInAction(() => {
      this.selected = data;
      this.replaceSummary(data);
    });
  }

  @action private replaceSummary(data: TableScriptDetails): void {
    const { source: _source, ...summary } = data;
    this.scripts = this.scripts.some((script) => script.id === data.id)
      ? this.scripts.map((script) => (script.id === data.id ? summary : script))
      : [...this.scripts, summary];
  }

  private async perform(operation: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) {
      return;
    }
    runInAction(() => {
      this.busy = true;
      this.error = "";
    });
    try {
      await operation();
    } catch (error) {
      if (!this.disposed) {
        runInAction(() => {
          this.conflict ||= error instanceof TableScriptConflictError;
          this.error =
            error instanceof Error
              ? error.message
              : "The request could not complete.";
        });
      }
      throw error;
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }
}

/** Shares transient editor sessions within the signed-in Outline account. */
export class TableScriptsStore {
  /**
   * Returns an in-memory editor, creating it on first use.
   *
   * @param documentId the containing document UUID.
   * @returns the document's script session.
   */
  getSession(documentId: string): TableScriptSession {
    if (!this.removeUnloadListener && typeof window !== "undefined") {
      const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        if (
          [...this.sessions.values()].some(
            (session) => session.dirty || session.busy
          )
        ) {
          event.preventDefault();
          event.returnValue = "";
        }
      };
      window.addEventListener("beforeunload", handleBeforeUnload);
      this.removeUnloadListener = () =>
        window.removeEventListener("beforeunload", handleBeforeUnload);
    }
    let session = this.sessions.get(documentId);
    if (!session) {
      session = new TableScriptSession(documentId);
      this.sessions.set(documentId, session);
    }
    return session;
  }

  /** Removes all drafts and results when the account logs out. */
  clear(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.removeUnloadListener?.();
    this.removeUnloadListener = undefined;
  }

  private sessions = new Map<string, TableScriptSession>();
  private removeUnloadListener?: () => void;
}

async function request<T>(method: string, body: JSONObject): Promise<T> {
  const response = await client.post<{ data: T }>(
    `/tableScripts.${method}`,
    body,
    { retry: false }
  );
  return response.data;
}
