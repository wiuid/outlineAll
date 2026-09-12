/* oxlint-disable */
import stores from "~/stores";
import { parser } from "@shared/test/editor";
import { ProsemirrorDataHelper } from "@shared/utils/ProsemirrorDataHelper";
import { getTableDocument } from "@shared/utils/tableDocument";
import type { DocumentCreationType } from "~/types";
import { client } from "~/utils/ApiClient";

describe("DocumentsStore", () => {
  describe("createEmptyDocument", () => {
    const post = vi.mocked(client.post);
    const destination = {
      id: "55555555-5555-4555-8555-555555555555",
      title: "预算 ``` 表格",
      collectionId: "66666666-6666-4666-8666-666666666666",
      parentDocumentId: "77777777-7777-4777-8777-777777777777",
    };

    beforeEach(() => {
      post.mockReset();
      post.mockResolvedValue({
        data: { ...destination, revision: 1 },
        policies: [
          { id: destination.id, abilities: { read: true, update: true } },
        ],
      });
    });

    it("creates Markdown with the original destination, template and width preference", async () => {
      const document = await stores.documents.createEmptyDocument(
        { ...destination, fullWidth: false, templateId: "template-id" },
        { publish: true, index: 3 }
      );

      expect(post).toHaveBeenCalledExactlyOnceWith("/documents.create", {
        ...destination,
        data: ProsemirrorDataHelper.getEmpty(),
        templateId: "template-id",
        fullWidth: false,
        publish: true,
        index: 3,
      });
      expect(document).toBe(stores.documents.get(destination.id));
      expect(stores.policies.abilities(document.id).update).toBe(true);
    });

    it("creates a native table with the requested link ID and position, without competing content", async () => {
      await stores.documents.createEmptyDocument(
        {
          ...destination,
          fullWidth: false,
          data: ProsemirrorDataHelper.getEmpty(),
          templateId: "template-id",
        },
        { publish: true, index: 3 },
        "table"
      );

      expect(post).toHaveBeenCalledExactlyOnceWith("/documents.create", {
        ...destination,
        fullWidth: true,
        publish: true,
        index: 3,
        text: expect.any(String),
      });
      const table = readTableCall(0);
      expect(table.workbook.name).toBe(destination.title);
      expect(table.workbook.sheetOrder).toHaveLength(1);
      const sheet = table.workbook.sheets[table.workbook.sheetOrder[0]];
      expect(sheet.cellData).toEqual({});
      expect(sheet.rowCount).toBeGreaterThan(0);
      expect(sheet.columnCount).toBeGreaterThan(0);
    });

    it("keeps table drafts unpublished and gives each creation independent workbook and sheet IDs", async () => {
      await stores.documents.createEmptyDocument({ title: "" }, {}, "table");
      await stores.documents.createEmptyDocument({ title: "" }, {}, "table");

      expect(post).toHaveBeenCalledTimes(2);
      for (const [, body] of post.mock.calls) {
        expect(body).not.toHaveProperty("publish");
        expect(body).not.toHaveProperty("collectionId");
        expect(body).not.toHaveProperty("parentDocumentId");
      }
      const first = readTableCall(0).workbook;
      const second = readTableCall(1).workbook;
      expect(first.id).not.toBe(second.id);
      expect(first.sheetOrder[0]).not.toBe(second.sheetOrder[0]);
    });

    const creationTypes: DocumentCreationType[] = ["document", "table"];
    it.each(creationTypes)(
      "propagates %s creation failures without a fallback request",
      async (type) => {
        const error = new Error("Creation denied");
        post.mockRejectedValueOnce(error);

        await expect(
          stores.documents.createEmptyDocument({}, {}, type)
        ).rejects.toBe(error);
        expect(post).toHaveBeenCalledTimes(1);
        expect(stores.documents.isSaving).toBe(false);
      }
    );

    function readTableCall(index: number) {
      const body = post.mock.calls[index]?.[1];
      if (!body || body instanceof FormData || typeof body.text !== "string") {
        throw new Error("Expected a Markdown creation request");
      }
      const table = getTableDocument(parser.parse(body.text).toJSON());
      if (table?.version !== 2) {
        throw new Error(
          "Expected a native table after the Markdown round trip"
        );
      }
      return table;
    }
  });

  describe("deleted", () => {
    test("should filter by the user that deleted the document", () => {
      const deleter = stores.users.add({
        id: "22222222-2222-2222-2222-222222222222",
        name: "Deleter",
      });
      const other = stores.users.add({
        id: "33333333-3333-3333-3333-333333333333",
        name: "Other",
      });

      const mine = stores.documents.add({
        id: "11111111-1111-1111-1111-111111111111",
        title: "Deleted by me",
        deletedAt: "2026-08-18T00:00:00.000Z",
        deletedBy: deleter,
      });
      stores.documents.add({
        id: "44444444-4444-4444-4444-444444444444",
        title: "Deleted by someone else",
        deletedAt: "2026-08-18T00:00:00.000Z",
        deletedBy: other,
      });

      const results = stores.documents.deleted({ userId: deleter.id });
      expect(results.map((doc) => doc.id)).toEqual([mine.id]);
    });
  });
});
