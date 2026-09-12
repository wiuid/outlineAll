/* oxlint-disable */
import stores from "~/stores";
import { autorun, runInAction } from "mobx";

describe("Collection model", () => {
  test("should initialize with data", () => {
    const collection = stores.collections.add({
      id: "123",
      name: "Engineering",
    });
    expect(collection.name).toBe("Engineering");
  });

  test("sorts an observed document tree without mutating its manual order", () => {
    const collection = stores.collections.add({
      id: "alphabetical-creation",
      name: "Creation destinations",
      sort: { field: "title", direction: "asc" },
      documents: [
        {
          id: "b",
          title: "B",
          url: "/doc/b",
          children: [
            { id: "b2", title: "Child 12", url: "/doc/b2", children: [] },
            { id: "b1", title: "Child 2", url: "/doc/b1", children: [] },
          ],
        },
        { id: "a", title: "A", url: "/doc/a", children: [] },
      ],
    });
    const snapshots: { roots: string[]; children: string[] }[] = [];
    const errors: string[] = [];
    const dispose = autorun(
      () => {
        snapshots.push({
          roots: collection.sortedDocuments?.map((node) => node.id) ?? [],
          children: collection
            .getChildrenForDocument("b")
            .map((node) => node.id),
        });
      },
      { onError: (error) => errors.push(String(error)) }
    );
    try {
      expect(errors).toEqual([]);
      expect(snapshots.at(-1)).toEqual({
        roots: ["a", "b"],
        children: ["b1", "b2"],
      });
      runInAction(() => {
        collection.sort = { field: "title", direction: "desc" };
      });
      expect(snapshots.at(-1)).toEqual({
        roots: ["b", "a"],
        children: ["b2", "b1"],
      });
      expect(collection.documents?.map((node) => node.id)).toEqual(["b", "a"]);
      expect(collection.documents?.[0].children.map((node) => node.id)).toEqual(
        ["b2", "b1"]
      );
      runInAction(() => {
        collection.sort = { field: "index", direction: "asc" };
      });
      expect(collection.sortedDocuments).toEqual(collection.documents);
      expect(snapshots.at(-1)).toEqual({
        roots: ["b", "a"],
        children: ["b2", "b1"],
      });
      expect(errors).toEqual([]);
    } finally {
      dispose();
    }
  });
});
