import { tableSaves } from "~/stores/TableSaveCoordinator";
import { client } from "./ApiClient";
vi.unmock("~/utils/ApiClient");

describe("table save lifecycle barrier", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not send a lifecycle request if pending saves fail", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const unregister = tableSaves.register({
      hasPending: () => true,
      flush: async () => {
        throw new Error("Unsaved table");
      },
    });
    try {
      await expect(
        client.post("/documents.archive", { id: "table" })
      ).rejects.toThrow("Unsaved table");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});
