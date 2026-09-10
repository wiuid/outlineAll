import {
  TableSaveCoordinator,
  DebouncedTableSave,
  tableSaves,
} from "./TableSaveCoordinator";
import stores from "~/stores";

describe("document metadata save barrier", () => {
  it("serializes the fresh workbook snapshot after flushing, not stale metadata", async () => {
    const document = stores.documents.add({
      id: "fresh-table",
      documentType: "table",
      title: "Table",
      tableData: { saved: "old" },
    });
    const sent = new Error("Request captured");
    const save = vi.spyOn(stores.documents, "save").mockRejectedValue(sent);
    const unregister = tableSaves.register({
      hasPending: () => true,
      flush: async () => {
        document.tableData = { saved: "fresh" };
      },
    });
    try {
      await expect(document.save(undefined, { publish: true })).rejects.toBe(
        sent
      );
      expect(save.mock.calls[0][0]).toMatchObject({
        tableData: { saved: "fresh" },
      });
    } finally {
      unregister();
      save.mockRestore();
    }
  });
});

describe("table save coordination", () => {
  afterEach(() => vi.useRealTimers());

  it("serializes edits made during a save and retries failed saves", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const save = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const pending = new DebouncedTableSave(save, vi.fn());
    pending.schedule();
    const first = pending.flush();
    pending.schedule();
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await expect(first).rejects.toThrow("offline");
    expect(pending.hasPending).toBe(true);
    await pending.flush();
    expect(save).toHaveBeenCalledTimes(3);
    expect(pending.hasPending).toBe(false);
  });

  it("keeps failed lifecycle flushes pending and unregisters disposed editors", async () => {
    const coordinator = new TableSaveCoordinator();
    const flush = vi.fn().mockRejectedValueOnce(new Error("save failed"));
    const unregister = coordinator.register({ hasPending: () => true, flush });
    expect(coordinator.hasPending).toBe(true);
    await expect(coordinator.flush()).rejects.toThrow("save failed");
    expect(coordinator.hasPending).toBe(true);
    unregister();
    expect(coordinator.hasPending).toBe(false);
  });

  it("flushes the debounce immediately and waits for the save acknowledgement", async () => {
    vi.useFakeTimers();
    let acknowledge: () => void = () => {};
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
    );
    const pending = new DebouncedTableSave(save, vi.fn());
    pending.schedule();
    expect(save).not.toHaveBeenCalled();
    const flushed = pending.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(pending.hasPending).toBe(true);
    acknowledge();
    await flushed;
    expect(pending.hasPending).toBe(false);
  });
});
