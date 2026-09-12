import {
  sharedModelPath,
  desktopify,
  newDocumentPath,
  newNestedDocumentPath,
  newSiblingDocumentPath,
} from "./routeHelpers";

describe("document creation routes", () => {
  it("keeps existing Markdown and template routes while offering tables in drafts and collections", () => {
    expect(newDocumentPath()).toBe("/doc/new");
    expect(newDocumentPath("collection", { templateId: "template" })).toBe(
      "/collection/collection/new?templateId=template"
    );
    expect(newDocumentPath(undefined, { type: "table" })).toBe(
      "/doc/new?type=table"
    );
    expect(newDocumentPath("collection", { type: "table" })).toBe(
      "/collection/collection/new?type=table"
    );
  });

  it("preserves and encodes the parent when creating a nested table", () => {
    const path = new URL(
      newNestedDocumentPath("parent & child", "table"),
      "https://example.com"
    );
    expect(path.pathname).toBe("/doc/new");
    expect(Object.fromEntries(path.searchParams)).toEqual({
      parentDocumentId: "parent & child",
      type: "table",
    });
    expect(newNestedDocumentPath("parent")).toBe(
      "/doc/new?parentDocumentId=parent"
    );
  });

  it.each([0, 3])(
    "preserves collection, parent and sibling position %i for tables",
    (index) => {
      const path = new URL(
        newSiblingDocumentPath({
          collectionId: "collection",
          parentDocumentId: "parent",
          index,
          type: "table",
        }),
        "https://example.com"
      );
      expect(path.pathname).toBe("/doc/new");
      expect(Object.fromEntries(path.searchParams)).toEqual({
        collectionId: "collection",
        parentDocumentId: "parent",
        index: String(index),
        type: "table",
      });
    }
  );

  it("keeps root sibling routes free of an unintended parent or table type", () => {
    expect(
      newSiblingDocumentPath({ collectionId: "collection", index: 0 })
    ).toBe("/doc/new?collectionId=collection&index=0");
  });
});

describe("#sharedDocumentPath", () => {
  it("should return share path for a document", () => {
    const shareId = "1c922644-40d8-41fe-98f9-df2b67239d45";
    const docPath = "/doc/test-DjDlkBi77t";
    expect(sharedModelPath(shareId)).toBe(
      "/s/1c922644-40d8-41fe-98f9-df2b67239d45"
    );
    expect(sharedModelPath(shareId, docPath)).toBe(
      "/s/1c922644-40d8-41fe-98f9-df2b67239d45/doc/test-DjDlkBi77t"
    );
  });
});

describe("#desktopify", () => {
  it("should replace https protocol with outline://", () => {
    expect(
      desktopify("/doc/test-DjDlkBi77t", "https://app.getoutline.com")
    ).toBe("outline://app.getoutline.com/doc/test-DjDlkBi77t");
  });

  it("should replace http protocol with outline://", () => {
    expect(desktopify("/doc/test-DjDlkBi77t", "http://localhost:3000")).toBe(
      "outline://localhost:3000/doc/test-DjDlkBi77t"
    );
  });
});
