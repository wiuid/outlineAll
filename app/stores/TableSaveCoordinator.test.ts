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
});
