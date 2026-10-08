import { makeObservable, observable, runInAction } from "mobx";
import { z } from "zod";

interface Options {
  keys: string[];
  recoveryPrefix?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> &
    Partial<Pick<Storage, "length" | "key">>;
  factory?: IDBFactory;
}

/**
 * Keeps synchronous recovery snapshots backed by serialized IndexedDB writes.
 * Small localStorage mirrors survive an interrupted asynchronous write; versioned
 * tombstones prevent an older mirror from resurrecting an acknowledged draft.
 */
export class TableDraftStorage {
  readonly ready: Promise<void>;
  @observable loaded = false;
  @observable failed = false;
  @observable pending = 0;
  @observable.ref otherDrafts: { key: string; value: string }[] = [];

  constructor(private readonly options: Options) {
    makeObservable(this);
    for (const key of options.keys) {
      owners.set(key, this.owner);
    }
    this.ready = this.load();
  }

  /**
   * Reads a hydrated draft without accessing browser storage during editing.
   *
   * @param key the account/document/tab-scoped draft key.
   * @returns the latest recoverable snapshot, or null.
   */
  getItem(key: string): string | null {
    return this.cache.get(key)?.value ?? null;
  }

  /**
   * Captures a snapshot immediately and queues a durable backup.
   *
   * @param key the scoped draft key.
   * @param value the complete recoverable session state.
   */
  setItem(key: string, value: string): void {
    this.persist(key, value);
  }

  /**
   * Records an acknowledgement without allowing an older backup to reappear.
   *
   * @param key the scoped draft key.
   */
  removeItem(key: string): void {
    this.persist(key, null);
  }

  /**
   * Waits for the current backup checkpoint without blocking on later edits.
   *
   * @returns completion after pending backups have settled; inspect failed.
   */
  async flush(): Promise<void> {
    await this.ready;
    await this.queue;
  }

  /**
   * Releases the database connection after queued backups finish.
   *
   * @returns completion once the connection is closed.
   */
  async dispose(): Promise<void> {
    await this.flush();
    this.disposed = true;
    this.database?.close();
    this.database = undefined;
  }

  private disposed = false;
  private readonly owner = ++ownerSequence;
  private generation = this.owner;
  private database?: IDBDatabase;
  private cache = new Map<string, DraftRecord>();
  private sequence = Date.now();
  private queue = Promise.resolve();
  private failures = new Set<string>();

  private async load(): Promise<void> {
    try {
      this.database = await this.open();
    } catch {
      // A mirror may predate an IDB-only write. Recovery completeness is unknown.
      for (const key of this.options.keys) {
        this.failures.add(key);
      }
    }
    const otherKeys = await this.findOtherKeys();
    for (const key of [...this.options.keys, ...otherKeys]) {
      let local: DraftRecord | undefined;
      let durable: DraftRecord | undefined;
      try {
        const text = this.options.storage?.getItem(key);
        if (text) {
          const parsed = recordSchema.safeParse(JSON.parse(text));
          local = parsed.success
            ? parsed.data
            : { outlineTableDraft: true, sequence: 0, value: text };
        }
      } catch {
        // Legacy drafts can be non-JSON strings in injected storage adapters.
        try {
          const value = this.options.storage?.getItem(key);
          if (value) {
            local = { outlineTableDraft: true, sequence: 0, value };
          }
        } catch {
          this.failures.add(key);
        }
      }
      if (this.database) {
        try {
          const value = await this.read(key);
          const parsed = recordSchema.safeParse(value);
          if (parsed.success) {
            durable = parsed.data;
          }
        } catch {
          this.failures.add(key);
        }
      }
      const latest =
        local && (!durable || isNewer(local, durable)) ? local : durable;
      try {
        const marker = this.options.storage?.getItem(`${key}:pending`);
        const parsed = marker && recordSchema.safeParse(JSON.parse(marker));
        if (
          parsed &&
          parsed.success &&
          (!latest || isNewer(parsed.data, latest))
        ) {
          this.failures.add(key);
        }
      } catch {
        this.failures.add(key);
      }
      if (latest?.pending) {
        // The latest snapshot never became durable. Retain the last recovery
        // point but never advertise it as a current, successful backup.
        this.failures.add(key);
        if (durable) {
          this.cache.set(key, durable);
        }
      } else if (latest) {
        this.cache.set(key, latest);
      }
      this.sequence = Math.max(this.sequence, latest?.sequence ?? 0);
      this.generation = Math.max(this.generation, (latest?.owner ?? 0) + 1);
    }
    if (!this.database && !this.options.storage && this.options.keys.length) {
      this.failures.add(this.options.keys[0]);
    }
    runInAction(() => {
      this.otherDrafts = otherKeys.flatMap((key) => {
        const value = this.cache.get(key)?.value;
        return value ? [{ key, value }] : [];
      });
      this.failed = this.failures.size > 0;
      this.loaded = true;
    });
  }

  private async findOtherKeys(): Promise<string[]> {
    const prefix = this.options.recoveryPrefix;
    if (!prefix) {
      return [];
    }
    const keys = new Set<string>();
    try {
      const storage = this.options.storage;
      for (let index = 0; index < (storage?.length ?? 0); index++) {
        const key = storage?.key?.(index);
        if (key?.startsWith(prefix) && !key.endsWith(":pending")) {
          keys.add(key);
        }
      }
    } catch {
      // IndexedDB can still contain drafts from a closed browser tab.
    }
    try {
      if (this.database) {
        const database = this.database;
        const stored = await new Promise<IDBValidKey[]>((resolve, reject) => {
          const transaction = database.transaction("drafts", "readonly");
          const request = transaction.objectStore("drafts").getAllKeys();
          const timer = setTimeout(() => {
            reject(new Error("Draft discovery timed out"));
            try {
              transaction.abort();
            } catch {
              /* Already completed. */
            }
          }, 3000);
          request.onsuccess = () => {
            clearTimeout(timer);
            resolve(request.result);
          };
          request.onerror = () => {
            clearTimeout(timer);
            reject(request.error);
          };
          transaction.onabort = () => {
            clearTimeout(timer);
            reject(transaction.error);
          };
        });
        for (const key of stored) {
          if (typeof key === "string" && key.startsWith(prefix)) {
            keys.add(key);
          }
        }
      }
    } catch {
      // Discovery must not block editing or overwrite a current tab's draft.
    }
    return [...keys].filter((key) => !this.options.keys.includes(key));
  }

  private persist(key: string, value: string | null): void {
    if (owners.get(key) !== this.owner) {
      return;
    }
    const record: DraftRecord = {
      outlineTableDraft: true,
      owner: this.generation,
      sequence: ++this.sequence,
      value,
    };
    this.cache.set(key, record);
    let mirrored = false;
    try {
      if (this.options.storage) {
        const previous = this.options.storage.getItem(key);
        if (previous) {
          let parsed;
          try {
            parsed = recordSchema.safeParse(JSON.parse(previous));
          } catch {
            // Unwrapped legacy snapshots do not carry an ownership generation.
          }
          if (parsed?.success && isNewer(parsed.data, record)) {
            return;
          }
        }
        if (this.database && value && value.length > 64 * 1024) {
          // Large workbooks use IndexedDB. Avoid synchronous megabyte writes
          // on every keystroke while retaining a marker for interrupted backups.
          this.options.storage.setItem(
            `${key}:pending`,
            JSON.stringify({ ...record, value: null, pending: true })
          );
        } else {
          this.options.storage.setItem(key, JSON.stringify(record));
          mirrored = true;
        }
      }
    } catch {
      try {
        // Never destroy the sole recoverable checkpoint to record a failure.
        this.options.storage?.setItem(
          `${key}:pending`,
          JSON.stringify({ ...record, value: null, pending: true })
        );
      } catch {
        // The observable failure state still reports a total storage outage.
      }
    }
    runInAction(() => {
      this.pending++;
    });
    this.queue = this.queue.then(async () => {
      let durable = false;
      if (owners.get(key) !== this.owner) {
        runInAction(() => {
          this.pending--;
        });
        return;
      }
      try {
        if (this.disposed) {
          // React may release the view before its asynchronous final commit.
          this.database = await this.open();
        }
        if (this.database) {
          await this.write(key, record);
          durable = true;
        }
      } catch {
        // A synchronous mirror can still provide the latest recovery snapshot.
      } finally {
        if (this.disposed) {
          this.database?.close();
          this.database = undefined;
        }
      }
      if (durable || mirrored) {
        this.failures.delete(key);
      } else {
        this.failures.add(key);
      }
      runInAction(() => {
        this.pending--;
        this.failed = this.failures.size > 0;
      });
    });
  }

  private open(): Promise<IDBDatabase | undefined> {
    if (!this.options.factory || !this.options.keys.length) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      const request = this.options.factory?.open("outline-table-drafts", 1);
      if (!request) {
        resolve(undefined);
        return;
      }
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore("drafts");
      };
      let settled = false;
      const fail = (error: Error | DOMException | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error("Draft database open timed out")),
        3000
      );
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error("Draft database is blocked"));
    });
  }

  private read(key: string): Promise<object | undefined> {
    return new Promise((resolve, reject) => {
      if (!this.database) {
        resolve(undefined);
        return;
      }
      const transaction = this.database.transaction("drafts", "readonly");
      const request = transaction.objectStore("drafts").get(key);
      let settled = false;
      const finish = (error?: Error | DOMException | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve(request.result);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error("Draft database read timed out"));
        try {
          transaction.abort();
        } catch {
          /* Already completed. */
        }
      }, 3000);
      request.onsuccess = () => finish();
      request.onerror = () =>
        finish(request.error ?? new Error("Draft read failed"));
      transaction.onabort = () =>
        finish(transaction.error ?? new Error("Draft read aborted"));
    });
  }

  private write(key: string, record: DraftRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.database) {
        reject(new Error("Draft database is unavailable"));
        return;
      }
      const transaction = this.database.transaction("drafts", "readwrite");
      let settled = false;
      const finish = (error?: Error | DOMException | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => {
        finish(new Error("Draft database write timed out"));
        try {
          transaction.abort();
        } catch {
          /* Already completed. */
        }
      }, 3000);
      const store = transaction.objectStore("drafts");
      const request = store.get(key);
      request.onsuccess = () => {
        if (settled) {
          return;
        }
        const previous = recordSchema.safeParse(request.result);
        if (
          owners.get(key) !== this.owner ||
          (previous.success && isNewer(previous.data, record))
        ) {
          return;
        }
        try {
          store.put(record, key);
        } catch {
          transaction.abort();
        }
      };
      transaction.oncomplete = () => finish();
      transaction.onerror = () =>
        finish(transaction.error ?? new Error("Draft write failed"));
      transaction.onabort = () =>
        finish(transaction.error ?? new Error("Draft write aborted"));
    });
  }
}

const recordSchema = z.object({
  outlineTableDraft: z.literal(true),
  sequence: z.number().nonnegative(),
  owner: z.number().nonnegative().optional(),
  value: z.string().nullable(),
  pending: z.boolean().optional(),
});
type DraftRecord = z.infer<typeof recordSchema>;

// Keys already include account, document and tab identity. Claim immediately,
// before hydration, so a released view cannot win during the next view's load.
const owners = new Map<string, number>();
let ownerSequence = Date.now();

function isNewer(previous: DraftRecord, next: DraftRecord): boolean {
  return (
    (previous.owner ?? 0) > (next.owner ?? 0) ||
    ((previous.owner ?? 0) === (next.owner ?? 0) &&
      previous.sequence > next.sequence)
  );
}
