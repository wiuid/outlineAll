import { TableSaveCoordinator } from "./TableSaveCoordinator";

describe("TableSaveCoordinator", () => {
  it("commits active cells before a dependent action and supports cleanup", async () => {
    const coordinator = new TableSaveCoordinator();
    const flush = vi.fn().mockResolvedValue(undefined);
    const unregister = coordinator.register({
      documentId: "first",
      hasPending: () => true,
      flush,
    });
    expect(coordinator.hasPending).toBe(true);
    await coordinator.flush("second");
    expect(flush).not.toHaveBeenCalled();
    await coordinator.flush();
    expect(flush).toHaveBeenCalledTimes(1);
    unregister();
    expect(coordinator.hasPending).toBe(false);
  });

  it("rejects the dependent action when a table cannot be saved", async () => {
    const coordinator = new TableSaveCoordinator();
    const action = vi.fn();
    coordinator.register({
      documentId: "first",
      hasPending: () => true,
      flush: async () => {
        throw new Error("Conflict");
      },
    });
    await expect(coordinator.flush().then(action)).rejects.toThrow("Conflict");
    expect(action).not.toHaveBeenCalled();
  });

  it("updates metadata through the instance that saved the latest edits", async () => {
    const coordinator = new TableSaveCoordinator();
    const firstUpdate = vi.fn();
    const secondUpdate = vi.fn(async (send) => (await send(4)).value);
    coordinator.register({
      documentId: "shared",
      hasPending: () => false,
      flush: vi.fn().mockResolvedValue(undefined),
      updateMetadata: firstUpdate,
    });
    coordinator.register({
      documentId: "shared",
      hasPending: () => true,
      flush: vi.fn().mockResolvedValue(undefined),
      updateMetadata: secondUpdate,
    });
    const send = vi.fn().mockResolvedValue({
      data: { revision: 5, title: "Renamed" },
    });

    await expect(coordinator.updateMetadata("shared", send)).resolves.toEqual({
      data: { revision: 5, title: "Renamed" },
    });
    expect(firstUpdate).not.toHaveBeenCalled();
    expect(secondUpdate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(4);
  });
});
