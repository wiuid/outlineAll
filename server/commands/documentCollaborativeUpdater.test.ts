import { Node } from "prosemirror-model";
import { prosemirrorToYDoc } from "y-prosemirror";
import {
  tableToMarkdown,
  type LightweightTable,
} from "@shared/utils/lightweightTable";
import {
  UniverTableSchema,
  tableDocumentToMarkdown,
} from "@shared/utils/tableDocument";
import { parser, schema } from "@server/editor";
import { Event } from "@server/models";
import { buildDocument, buildUser } from "@server/test/factories";
import documentCollaborativeUpdater from "./documentCollaborativeUpdater";

describe("documentCollaborativeUpdater", () => {
  const legacyTable: LightweightTable = {
    format: "outline-table",
    version: 1,
    columns: [{}],
    rows: [{ cells: [{ value: 5 }] }],
  };
  const nativeTable = UniverTableSchema.parse({
    format: "outline-table",
    version: 2,
    workbook: {
      id: "book",
      name: "Table",
      appVersion: "0.25.1",
      locale: "zhCN",
      styles: {},
      sheetOrder: ["sheet"],
      sheets: { sheet: { id: "sheet" } },
    },
  });

  it.each([tableToMarkdown(legacyTable), tableDocumentToMarkdown(nativeTable)])(
    "rejects stale collaborative writes to a table under the row lock (%#)",
    async (text) => {
      const user = await buildUser();
      const content = parser.parse(text).toJSON();
      const document = await buildDocument({
        teamId: user.teamId,
        userId: user.id,
        content,
      });
      const revision = document.revisionCount;
      const events = await Event.count({ where: { documentId: document.id } });
      const ydoc = prosemirrorToYDoc(
        parser.parse("outdated Markdown"),
        "default"
      );
      await expect(
        documentCollaborativeUpdater({
          documentId: document.id,
          ydoc,
          sessionCollaboratorIds: [user.id],
          isLastConnection: true,
          clientVersion: null,
        })
      ).rejects.toMatchObject({ status: 409 });
      await document.reload();
      expect(document.content).toEqual(content);
      expect(document.revisionCount).toBe(revision);
      expect(await Event.count({ where: { documentId: document.id } })).toBe(
        events
      );
      ydoc.destroy();
    }
  );

  it("rejects an unversioned conversion from collaborative Markdown to a table", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });
    const original = document.content;
    const ydoc = prosemirrorToYDoc(
      parser.parse(tableDocumentToMarkdown(nativeTable)),
      "default"
    );
    await expect(
      documentCollaborativeUpdater({
        documentId: document.id,
        ydoc,
        sessionCollaboratorIds: [user.id],
        isLastConnection: true,
        clientVersion: null,
      })
    ).rejects.toMatchObject({ status: 409 });
    await document.reload();
    expect(document.content).toEqual(original);
    ydoc.destroy();
  });

  it("accepts an unchanged table without incrementing its revision", async () => {
    const user = await buildUser();
    const node = parser.parse(tableDocumentToMarkdown(nativeTable));
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      content: JSON.parse(JSON.stringify(node.toJSON())),
    });
    const revision = document.revisionCount;
    const ydoc = prosemirrorToYDoc(node, "default");
    await documentCollaborativeUpdater({
      documentId: document.id,
      ydoc,
      sessionCollaboratorIds: [user.id],
      isLastConnection: true,
      clientVersion: null,
    });
    await document.reload();
    expect(document.revisionCount).toBe(revision);
    ydoc.destroy();
  });

  const buildYDoc = (content: object[]) => {
    const doc = Node.fromJSON(schema, { type: "doc", content });
    return prosemirrorToYDoc(doc, "default");
  };

  it("persists canonical JSON without empty attrs on marks", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
    });

    const ydoc = buildYDoc([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Deciders:",
            marks: [{ type: "strong" }],
          },
        ],
      },
    ]);

    await documentCollaborativeUpdater({
      documentId: document.id,
      ydoc,
      sessionCollaboratorIds: [user.id],
      isLastConnection: true,
      clientVersion: null,
    });

    await document.reload();

    const marks = JSON.stringify(document.content).match(/"attrs":\{\}/g);
    expect(marks).toBeNull();

    const text = document.content?.content?.[0]?.content?.[0];
    expect(text?.marks).toEqual([{ type: "strong" }]);
  });

  it("does not persist when content is unchanged", async () => {
    const user = await buildUser();
    const content = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello" }],
      },
    ];
    const ydoc = buildYDoc(content);

    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      content: Node.fromJSON(schema, { type: "doc", content }).toJSON(),
    });

    const updatedAt = document.updatedAt;

    await documentCollaborativeUpdater({
      documentId: document.id,
      ydoc,
      sessionCollaboratorIds: [user.id],
      isLastConnection: true,
      clientVersion: null,
    });

    await document.reload();
    expect(document.updatedAt).toEqual(updatedAt);
  });
});
