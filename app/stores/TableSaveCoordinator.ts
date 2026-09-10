/** Serializes opaque workbook saves without interpreting workbook contents. */
export class DebouncedTableSave {
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private inflight?: Promise<void>;

  constructor(
    private readonly save: () => Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  /** Whether edits or an unacknowledged save remain. */
  get hasPending(): boolean {
    return this.dirty || Boolean(this.inflight);
  }

  /** Marks a mutation dirty and schedules its save. */
  schedule(): void {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(this.onError);
    }, 800);
  }

  /** Saves immediately, drains edits made during a request, and propagates failures. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    while (this.dirty || this.inflight) {
      if (!this.inflight) {
        this.dirty = false;
        this.inflight = this.save()
          .catch((error: unknown) => {
            this.dirty = true;
            throw error;
          })
          .finally(() => {
            this.inflight = undefined;
          });
      }
      await this.inflight;
    }
  }
}

interface TableSaveEntry {
  hasPending: () => boolean;
  flush: () => Promise<void>;
}

/** Coordinates mounted table editors at document-action and navigation boundaries. */
export class TableSaveCoordinator {
  private entries = new Set<TableSaveEntry>();

  /** Registers a mounted editor and returns its cleanup callback. */
  register(entry: TableSaveEntry): () => void {
    this.entries.add(entry);
    return () => {
      this.entries.delete(entry);
    };
  }

  /** Whether any table has pending edits, including an active cell editor. */
  get hasPending(): boolean {
    return [...this.entries].some((entry) => entry.hasPending());
  }

  /** Flushes all mounted tables, including descendants affected by parent actions. */
  async flush(): Promise<void> {
    for (const entry of this.entries) {
      await entry.flush();
    }
  }
}

/** Shared coordinator; it contains callbacks only, never workbook data. */
export const tableSaves = new TableSaveCoordinator();
