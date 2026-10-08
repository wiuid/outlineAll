import {
  IDBFactory,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
} from "fake-indexeddb";
import { TableDraftStorage } from "./TableDraftStorage";

it("finds other-tab drafts only for the same account and document without claiming them", async () => {
  const factory = new IDBFactory();
  const prefix = "outline-table-draft:team:alice:document:";
  const originalKey = `${prefix}old-tab:collaboration`;
  const ownKey = `${prefix}new-tab:collaboration`;
  const foreignKey =
    "outline-table-draft:team:bob:document:other-tab:collaboration";
  const first = new TableDraftStorage({
    keys: [originalKey, foreignKey],
    factory,
  });
  await first.ready;
  first.setItem(originalKey, "recoverable draft");
  first.setItem(foreignKey, "another account");
  await first.flush();
  const next = new TableDraftStorage({
    keys: [ownKey],
    recoveryPrefix: prefix,
    factory,
  });
  await next.ready;
  expect(next.getItem(ownKey)).toBeNull();
  expect(next.otherDrafts).toEqual([
    { key: originalKey, value: "recoverable draft" },
  ]);
  // Discovery is read-only: the original tab can still persist newer edits.
  first.setItem(originalKey, "latest original edit");
  await first.flush();
  const reopened = new TableDraftStorage({ keys: [originalKey], factory });
  await reopened.ready;
  expect(reopened.getItem(originalKey)).toBe("latest original edit");
  await first.dispose();
  await next.dispose();
  await reopened.dispose();
});

it("recovers the latest large draft from IndexedDB when localStorage is full", async () => {
  const factory = new IDBFactory();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > 1024) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const first = new TableDraftStorage({ keys: ["draft"], storage, factory });
  await first.ready;
  first.setItem("draft", "small");
  await first.flush();
  const latest = "latest".repeat(10000);
  first.setItem("draft", latest);
  await first.flush();
  expect(first.failed).toBe(false);
  const reopened = new TableDraftStorage({ keys: ["draft"], storage, factory });
  await reopened.ready;
  expect(reopened.getItem("draft")).toBe(latest);
  await first.dispose();
  await reopened.dispose();
});

it("does not resurrect a draft removed after queued writes", async () => {
  const factory = new IDBFactory();
  const first = new TableDraftStorage({ keys: ["draft"], factory });
  await first.ready;
  first.setItem("draft", "one");
  first.setItem("draft", "two");
  first.removeItem("draft");
  await first.flush();
  const next = new TableDraftStorage({ keys: ["draft"], factory });
  await next.ready;
  expect(next.getItem("draft")).toBeNull();
  await first.dispose();
  await next.dispose();
});

it("migrates existing raw localStorage drafts and works without IndexedDB", async () => {
  const values = new Map([["draft", '{"title":"legacy"}']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const first = new TableDraftStorage({ keys: ["draft"], storage });
  await first.ready;
  expect(first.getItem("draft")).toBe('{"title":"legacy"}');
  first.setItem("draft", "newest");
  await first.flush();
  const next = new TableDraftStorage({ keys: ["draft"], storage });
  await next.ready;
  expect(next.getItem("draft")).toBe("newest");
  expect(next.failed).toBe(false);
  await first.dispose();
  await next.dispose();
});

it("warns when recovering an older checkpoint after both stores reject the latest edit", async () => {
  const factory = new IDBFactory();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > 1024) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const first = new TableDraftStorage({ keys: ["draft"], storage, factory });
  await first.ready;
  first.setItem("draft", "checkpoint");
  await first.flush();
  const failure = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
  first.setItem("draft", "newest".repeat(10000));
  await first.flush();
  expect(first.failed).toBe(true);
  failure.mockRestore();
  const next = new TableDraftStorage({ keys: ["draft"], storage, factory });
  await next.ready;
  expect(next.getItem("draft")).toBe("checkpoint");
  expect(next.failed).toBe(true);
  await first.dispose();
  await next.dispose();
});

it("persists a late session flush after the editor releases its storage connection", async () => {
  const factory = new IDBFactory();
  const first = new TableDraftStorage({ keys: ["draft"], factory });
  await first.ready;
  await first.dispose();
  first.setItem("draft", "late editor commit");
  await first.flush();
  const next = new TableDraftStorage({ keys: ["draft"], factory });
  await next.ready;
  expect(next.getItem("draft")).toBe("late editor commit");
  await next.dispose();
});

it.each([false, true])(
  "rejects stale owners' late saves and removals (IndexedDB=%s)",
  async (indexedDB) => {
    const factory = indexedDB ? new IDBFactory() : undefined;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const old = new TableDraftStorage({ keys: ["owner"], storage, factory });
    await old.ready;
    old.setItem("owner", "old");
    await old.flush();
    const current = new TableDraftStorage({
      keys: ["owner"],
      storage,
      factory,
    });
    await current.ready;
    current.setItem("owner", "new");
    await current.flush();
    old.removeItem("owner");
    await old.flush();
    expect(JSON.parse(storage.getItem("owner") ?? "{}").value).toBe("new");
    current.removeItem("owner");
    await current.flush();
    await old.dispose();
    old.setItem("owner", "resurrected");
    await old.flush();
    // Read IDB independently of the mirror as well.
    const recovered = new TableDraftStorage({
      keys: ["owner"],
      storage: indexedDB ? undefined : storage,
      factory,
    });
    await recovered.ready;
    expect(recovered.getItem("owner")).toBeNull();
    await current.dispose();
    await recovered.dispose();
  }
);

it("keeps the last local-only checkpoint when the next snapshot exceeds quota", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > 1024) {
        throw new Error("quota");
      }
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const first = new TableDraftStorage({ keys: ["quota"], storage });
  await first.ready;
  first.setItem("quota", "last checkpoint");
  await first.flush();
  first.setItem("quota", "x".repeat(10000));
  await first.flush();
  expect(first.failed).toBe(true);
  const next = new TableDraftStorage({ keys: ["quota"], storage });
  await next.ready;
  expect(next.getItem("quota")).toBe("last checkpoint");
  expect(next.failed).toBe(true);
  await first.dispose();
  await next.dispose();
});

it("warns that a local mirror may be stale when IndexedDB open fails", async () => {
  const factory = new IDBFactory();
  const storage = {
    getItem: (key: string) =>
      key.endsWith(":pending") ? null : "old checkpoint",
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  vi.spyOn(factory, "open").mockImplementation(() => {
    throw new Error("unavailable");
  });
  const drafts = new TableDraftStorage({
    keys: ["open-error"],
    factory,
    storage,
  });
  await drafts.ready;
  expect(drafts.getItem("open-error")).toBe("old checkpoint");
  expect(drafts.failed).toBe(true);
  await drafts.dispose();
});

it("bounds an unresponsive open and closes a late successful connection", async () => {
  vi.useFakeTimers();
  try {
    const factory = new IDBFactory();
    const request = new IDBOpenDBRequest();
    vi.spyOn(factory, "open").mockReturnValue(request);
    const drafts = new TableDraftStorage({ keys: ["open-timeout"], factory });
    await vi.advanceTimersByTimeAsync(6000);
    expect(drafts.loaded).toBe(true);
    expect(drafts.failed).toBe(true);
    const close = vi.fn();
    Object.defineProperty(request, "result", { value: { close } });
    request.onsuccess?.call(request, new Event("success"));
    expect(close).toHaveBeenCalledOnce();
    await drafts.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("bounds an unresponsive read and keeps its older mirror visibly uncertain", async () => {
  const factory = new IDBFactory();
  const seed = new TableDraftStorage({ keys: ["read-timeout"], factory });
  await seed.ready;
  await seed.dispose();
  const read = vi
    .spyOn(IDBObjectStore.prototype, "get")
    .mockReturnValue(new IDBRequest());
  const storage = {
    getItem: (key: string) => (key.endsWith(":pending") ? null : "mirror"),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  const drafts = new TableDraftStorage({
    keys: ["read-timeout"],
    factory,
    storage,
  });
  await drafts.ready;
  expect(drafts.getItem("read-timeout")).toBe("mirror");
  expect(drafts.failed).toBe(true);
  await drafts.dispose();
  read.mockRestore();
}, 8000);

it("settles queued work superseded while the next owner hydrates", async () => {
  const factory = new IDBFactory();
  const old = new TableDraftStorage({ keys: ["queued-owner"], factory });
  await old.ready;
  old.setItem("queued-owner", "queued old write");
  const next = new TableDraftStorage({ keys: ["queued-owner"], factory });
  await next.ready;
  next.removeItem("queued-owner");
  await Promise.all([old.flush(), next.flush()]);
  expect(old.pending).toBe(0);
  await old.dispose();
  await next.dispose();
});

it.each([false, true])(
  "compares a newer persisted owner inside the write boundary (IDB=%s)",
  async (indexedDB) => {
    const factory = new IDBFactory();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const old = new TableDraftStorage({
      keys: ["external"],
      factory: indexedDB ? factory : undefined,
      storage: indexedDB ? undefined : storage,
    });
    await old.ready;
    const newer = {
      outlineTableDraft: true,
      sequence: 1,
      owner: Number.MAX_SAFE_INTEGER,
      value: "external owner",
    };
    if (indexedDB) {
      const database = await new Promise<IDBDatabase>((resolve) => {
        const request = factory.open("outline-table-drafts", 1);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve) => {
        const transaction = database.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put(newer, "external");
        transaction.oncomplete = () => resolve();
      });
      database.close();
    } else {
      storage.setItem("external", JSON.stringify(newer));
    }
    old.removeItem("external");
    await old.flush();
    const recovered = new TableDraftStorage({
      keys: ["external"],
      factory: indexedDB ? factory : undefined,
      storage: indexedDB ? undefined : storage,
    });
    await recovered.ready;
    expect(recovered.getItem("external")).toBe("external owner");
    await old.dispose();
    await recovered.dispose();
  }
);

it("reports unavailable storage even before the first edit", async () => {
  const drafts = new TableDraftStorage({ keys: ["draft"] });
  await drafts.ready;
  expect(drafts.failed).toBe(true);
  drafts.setItem("draft", "still in memory");
  await drafts.flush();
  expect(drafts.failed).toBe(true);
  expect(drafts.getItem("draft")).toBe("still in memory");
});
