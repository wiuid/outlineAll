import { DocumentConflictError, NetworkError } from "~/utils/errors";
import { createTableWorkbook } from "~/utils/tableWorkbook";
import {
  TableDocumentSession,
  type TableSaveRequest,
} from "./TableDocumentSession";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Not initialized");
  };
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("TableDocumentSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes saves and drains edits made during an in-flight request", async () => {
    const first = deferred<number>();
    const save = vi
      .fn<(request: TableSaveRequest) => Promise<number>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(12);
    const storage = createStorage();
    const session = new TableDocumentSession({
      title: "Original",
      revision: 10,
      workbook: createTableWorkbook("Original"),
      save,
      storage,
      draftKey: "draft",
    });
    session.setTitle("First change");
    const pending = session.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      title: "First change",
      lastRevision: 10,
    });
    session.setTitle("Second change");
    const anotherFlush = session.flush();
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(11);
    await Promise.all([pending, anotherFlush]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({
      title: "Second change",
      lastRevision: 11,
    });
    expect(session.baseRevision).toBe(12);
    expect(session.hasPending).toBe(false);
    expect(storage.getItem("draft")).toBeNull();
    session.dispose();
  });

  it("keeps the original base revision after live model updates and stops on conflict", async () => {
    const source = { revision: 7 };
    const storage = createStorage();
    const save = vi
      .fn<(request: TableSaveRequest) => Promise<number>>()
      .mockRejectedValue(new DocumentConflictError());
    const session = new TableDocumentSession({
      title: "Original",
      revision: source.revision,
      workbook: createTableWorkbook("Original"),
      save,
      storage,
      draftKey: "draft",
    });
    source.revision = 8;
    session.setTitle("Local draft");
    await expect(session.flush()).rejects.toBeInstanceOf(DocumentConflictError);
    expect(save.mock.calls[0][0].lastRevision).toBe(7);
    expect(session.conflict).toBe(true);
    expect(session.hasPending).toBe(true);
    session.setTitle("Still editable locally");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(session.flush()).rejects.toBeInstanceOf(DocumentConflictError);
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem("draft") ?? "null")).toMatchObject({
      title: "Still editable locally",
      baseRevision: 7,
    });
    session.dispose();
  });

  it("restores a stale draft without silently rebasing it onto the newest revision", async () => {
    const storage = createStorage();
    const workbook = createTableWorkbook("Original");
    const save = vi.fn<(request: TableSaveRequest) => Promise<number>>();
    const original = new TableDocumentSession({
      title: "Original",
      revision: 4,
      workbook,
      save,
      storage,
      draftKey: "draft",
    });
    original.setTitle("Recovered title");
    original.dispose();
    const restored = new TableDocumentSession({
      title: "Server title",
      revision: 5,
      workbook,
      save,
      storage,
      draftKey: "draft",
    });
    restored.initialize(workbook);
    expect(restored.title).toBe("Recovered title");
    expect(restored.baseRevision).toBe(4);
    expect(restored.conflict).toBe(true);
    await expect(restored.flush()).rejects.toBeInstanceOf(
      DocumentConflictError
    );
    expect(save).not.toHaveBeenCalled();
    restored.dispose();
  });

  it("normalizes initial snapshots without writing an untouched workbook", async () => {
    const workbook = createTableWorkbook("Original");
    const save = vi.fn<(request: TableSaveRequest) => Promise<number>>();
    const session = new TableDocumentSession({
      title: "Original",
      revision: 1,
      workbook,
      save,
    });
    session.initialize({
      ...workbook,
      resources: [{ name: "native", data: "{}" }],
    });
    session.capture(session.table.workbook);
    await session.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.hasPending).toBe(false);
    expect(save).not.toHaveBeenCalled();
    session.dispose();
  });

  it("serializes publishing with subsequent cell edits and acknowledges only its own response", async () => {
    const metadata = deferred<{
      value: string;
      revision: number;
      title: string;
    }>();
    const save = vi
      .fn<(request: TableSaveRequest) => Promise<number>>()
      .mockResolvedValue(4);
    const session = new TableDocumentSession({
      title: "Original",
      revision: 2,
      workbook: createTableWorkbook("Original"),
      save,
    });
    const send = vi.fn().mockReturnValue(metadata.promise);
    const updating = session.updateMetadata(send);
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith(2);
    session.setTitle("Edited while publishing");
    const saving = session.flush();
    expect(save).not.toHaveBeenCalled();
    metadata.resolve({ value: "published", revision: 3, title: "Original" });
    expect(await updating).toBe("published");
    await saving;
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      lastRevision: 3,
      title: "Edited while publishing",
    });
    expect(session.baseRevision).toBe(4);
    session.dispose();
  });

  it("retains the draft on network errors and retries against the same revision", async () => {
    const storage = createStorage();
    const save = vi
      .fn<(request: TableSaveRequest) => Promise<number>>()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce(3);
    const session = new TableDocumentSession({
      title: "Original",
      revision: 2,
      workbook: createTableWorkbook("Original"),
      save,
      storage,
      draftKey: "draft",
    });
    session.setTitle("Updated");
    await expect(session.flush()).rejects.toBeInstanceOf(NetworkError);
    expect(storage.getItem("draft")).not.toBeNull();
    expect(session.conflict).toBe(false);
    await session.flush();
    expect(save.mock.calls.map(([request]) => request.lastRevision)).toEqual([
      2, 2,
    ]);
    expect(session.error).toBeUndefined();
    expect(session.dirty).toBe(false);
    session.dispose();
  });

  it("keeps different tabs' drafts independent and surfaces unavailable storage", async () => {
    const storage = createStorage();
    storage.setItem("other-tab", "keep this draft");
    const save = vi
      .fn<(request: TableSaveRequest) => Promise<number>>()
      .mockResolvedValue(2);
    const session = new TableDocumentSession({
      title: "Original",
      revision: 1,
      workbook: createTableWorkbook("Original"),
      save,
      storage: {
        ...storage,
        setItem: () => {
          throw new Error("Quota exceeded");
        },
      },
      draftKey: "this-tab",
    });
    session.setTitle("Still in memory");
    expect(session.storageFailed).toBe(true);
    expect(session.title).toBe("Still in memory");
    await session.flush();
    expect(session.dirty).toBe(false);
    expect(session.storageFailed).toBe(false);
    expect(storage.getItem("other-tab")).toBe("keep this draft");
    session.dispose();
  });
});
