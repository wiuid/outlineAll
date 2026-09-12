import i18next from "i18next";
import { schema } from "@shared/test/editor";
import { MentionType } from "@shared/types";
import { createDocumentMentionItems } from "./mention";

describe("create and link documents or tables", () => {
  const options = {
    search: "  预算表  ",
    actorId: "actor",
    documentId: "parent",
    canCreate: true,
  };

  it("keeps a unique document reference for each creation choice", () => {
    const items = createDocumentMentionItems(i18next.t, options);
    expect(items.filter((item) => item.visible)).toHaveLength(4);
    expect(new Set(items.map((item) => item.attrs.modelId)).size).toBe(4);

    for (const item of items) {
      const mention = schema.nodes.mention.create(item.attrs);
      expect(mention.attrs).toMatchObject({
        modelId: item.attrs.modelId,
        type: MentionType.Document,
        label: "预算表",
        actorId: "actor",
      });
      // Creation options must not leak into persisted mention attributes.
      expect(mention.attrs).not.toHaveProperty("creationType");
      expect(mention.attrs).not.toHaveProperty("nested");
    }
    const tables = items.filter((item) => item.attrs.creationType === "table");
    expect(tables.map((item) => !!item.attrs.nested)).toEqual([false, true]);
  });

  it.each(["", "  ", "person@example.com"])(
    "hides creation for an invalid search %j",
    (search) => {
      const items = createDocumentMentionItems(i18next.t, {
        ...options,
        search,
      });
      expect(items.every((item) => !item.visible)).toBe(true);
    }
  );

  it("hides both content types when the editor cannot create documents", () => {
    const items = createDocumentMentionItems(i18next.t, {
      ...options,
      canCreate: false,
    });
    expect(items.every((item) => !item.visible)).toBe(true);
  });

  it("offers only root creation in an editor without a parent document", () => {
    const items = createDocumentMentionItems(i18next.t, {
      ...options,
      documentId: undefined,
    });
    const visible = items.filter((item) => item.visible);
    expect(visible).toHaveLength(2);
    expect(visible.every((item) => !item.attrs.nested)).toBe(true);
    expect(visible.some((item) => item.attrs.creationType === "table")).toBe(
      true
    );
  });
});
