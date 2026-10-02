import { randomUUID } from "node:crypto";
import { LocaleType } from "@univerjs/core";
import { UserRole } from "@shared/types";
import {
  getTableDocument,
  type UniverTable,
} from "@shared/utils/tableDocument";
import { Document, Revision, TableCollaboration } from "@server/models";
import { buildUser } from "@server/test/factories";
import { getTestServer, withAPIContext } from "@server/test/support";

const server = getTestServer();

async function setup() {
  const user = await buildUser();
  const attachmentId = randomUUID();
  const table: UniverTable = {
    format: "outline-table",
    version: 2,
    workbook: {
      id: randomUUID(),
      name: "Historical table",
      appVersion: "0.25.1",
      locale: LocaleType.EN_US,
      styles: { bold: { bl: 1 } },
      sheetOrder: ["first", "second"],
      sheets: {
        first: {
          id: "first",
          name: "Original",
          rowCount: 10,
          columnCount: 5,
          rowData: { 0: { h: 80 } },
          columnData: { 0: { w: 200 } },
          cellData: {
            0: { 0: { v: "原有内容", s: "bold" } },
            1: { 0: { v: 21, f: "=SUM(10,11)" } },
            2: {
              0: {
                custom: {
                  outlineImage: {
                    attachmentId,
                    src: `/api/attachments.redirect?id=${attachmentId}`,
                    name: "photo.png",
                    width: 320,
                    height: 240,
                  },
                },
              },
            },
          },
        },
        second: {
          id: "second",
          name: "Second",
          rowCount: 10,
          columnCount: 5,
          cellData: { 0: { 0: { v: "00123" } } },
        },
      },
    },
  };
  const created = await server.post("/api/documents.create", user, {
    body: { title: "Original title", table },
  });
  expect(created.status).toBe(200);
  const { data } = await created.json();
  const document = await Document.findByPk(data.id, { rejectOnEmpty: true });
  const revision = await withAPIContext(user, (ctx) =>
    Revision.createFromDocument(ctx, document, [user.id])
  );
  const current = structuredClone(table);
  current.workbook.sheets.first.cellData = {
    0: { 0: { v: "Current content" } },
  };
  const changed = await server.post("/api/documents.update", user, {
    body: {
      id: document.id,
      title: "Current title",
      table: current,
      lastRevision: document.revisionCount,
    },
  });
  expect(changed.status).toBe(200);
  const updated = await changed.json();
  const info = await server.post("/api/tableCollaboration.info", user, {
    body: { documentId: document.id },
  });
  expect(info.status).toBe(200);
  const collaboration = await info.json();
  return {
    user,
    document,
    revision,
    table,
    current,
    lastRevision: updated.data.revision,
    epoch: collaboration.data.epoch,
  };
}

describe("table version restoration", () => {
  it("restores every worksheet, image and format while retaining the replaced version", async () => {
    const { user, document, revision, table, current, lastRevision } =
      await setup();
    const result = await server.post("/api/documents.restore", user, {
      body: { id: document.id, revisionId: revision.id, lastRevision },
    });
    expect(result.status).toBe(200);
    const { data } = await result.json();
    expect(data.title).toBe("Original title");
    expect(data.table).toEqual(table);
    expect(data.revision).toBe(lastRevision + 1);
    expect(
      await TableCollaboration.count({ where: { documentId: document.id } })
    ).toBe(0);
    const versions = await Revision.findAll({
      where: { documentId: document.id },
      order: [["createdAt", "ASC"]],
    });
    expect(versions).toHaveLength(3);
    expect(
      versions.some(
        (version) =>
          version.title === "Current title" &&
          JSON.stringify(getTableDocument(version.content ?? undefined)) ===
            JSON.stringify(current)
      )
    ).toBe(true);
    expect(getTableDocument(versions.at(-1)?.content ?? undefined)).toEqual(
      table
    );
  });

  it("requires a current revision and rejects stale confirmations without writing", async () => {
    const { user, document, revision, current, lastRevision, epoch } =
      await setup();
    for (const input of [{}, { lastRevision: lastRevision - 1 }]) {
      const result = await server.post("/api/documents.restore", user, {
        body: { id: document.id, revisionId: revision.id, ...input },
      });
      expect(result.status).toBe("lastRevision" in input ? 409 : 400);
    }
    await document.reload();
    expect(getTableDocument(document.content ?? undefined)).toEqual(current);
    expect(document.revisionCount).toBe(lastRevision);
    expect(await Revision.count({ where: { documentId: document.id } })).toBe(
      1
    );
    expect(await TableCollaboration.findByPk(epoch)).not.toBeNull();
  });

  it("rolls back content, history and collaboration when restoration fails", async () => {
    const { user, document, revision, current, lastRevision, epoch } =
      await setup();
    const createRevision = Revision.createFromDocument.bind(Revision);
    const saveVersion = vi
      .spyOn(Revision, "createFromDocument")
      .mockImplementationOnce(createRevision)
      .mockRejectedValueOnce(new Error("Could not save restored version"));
    try {
      const result = await server.post("/api/documents.restore", user, {
        body: { id: document.id, revisionId: revision.id, lastRevision },
      });
      expect(result.status).toBe(500);
      await document.reload();
      expect(getTableDocument(document.content ?? undefined)).toEqual(current);
      expect(document.revisionCount).toBe(lastRevision);
      expect(await Revision.count({ where: { documentId: document.id } })).toBe(
        1
      );
      expect(await TableCollaboration.findByPk(epoch)).not.toBeNull();
    } finally {
      saveVersion.mockRestore();
    }
  });

  it("reuses a saved current version instead of adding a duplicate backup", async () => {
    const { user, document, revision, lastRevision } = await setup();
    await document.reload();
    await withAPIContext(user, (ctx) =>
      Revision.createFromDocument(ctx, document, [user.id])
    );
    const result = await server.post("/api/documents.restore", user, {
      body: { id: document.id, revisionId: revision.id, lastRevision },
    });
    expect(result.status).toBe(200);
    expect(await Revision.count({ where: { documentId: document.id } })).toBe(
      3
    );
  });

  it("allows only one concurrent restore against the same revision", async () => {
    const { user, document, revision, lastRevision } = await setup();
    const body = { id: document.id, revisionId: revision.id, lastRevision };
    const results = await Promise.all([
      server.post("/api/documents.restore", user, { body }),
      server.post("/api/documents.restore", user, { body }),
    ]);
    expect(
      results.map((result) => result.status).sort((a, b) => a - b)
    ).toEqual([200, 409]);
    await document.reload();
    expect(document.revisionCount).toBe(lastRevision + 1);
    expect(await Revision.count({ where: { documentId: document.id } })).toBe(
      3
    );
  });

  it("starts a new collaboration epoch and rejects updates from the replaced epoch", async () => {
    const { user, document, revision, lastRevision, epoch } = await setup();
    const restored = await server.post("/api/documents.restore", user, {
      body: { id: document.id, revisionId: revision.id, lastRevision },
    });
    expect(restored.status).toBe(200);
    const info = await server.post("/api/tableCollaboration.info", user, {
      body: { documentId: document.id },
    });
    const { data } = await info.json();
    expect(data.epoch).not.toBe(epoch);
    const stale = await server.post("/api/tableCollaboration.update", user, {
      body: {
        documentId: document.id,
        epoch,
        update: "AAA=",
        vector: "AA==",
        baseRevision: lastRevision,
      },
    });
    expect(stale.status).toBe(409);
  });

  it("rejects viewers and revisions belonging to another document", async () => {
    const { user, document, revision, lastRevision } = await setup();
    const viewer = await buildUser({
      teamId: user.teamId,
      role: UserRole.Viewer,
    });
    const denied = await server.post("/api/documents.restore", viewer, {
      body: { id: document.id, revisionId: revision.id, lastRevision },
    });
    expect(denied.status).toBe(403);
    const other = await server.post("/api/documents.create", user, {
      body: { title: "Other document", text: "Unchanged" },
    });
    const otherDocument = (await other.json()).data;
    const wrong = await server.post("/api/documents.restore", user, {
      body: {
        id: otherDocument.id,
        revisionId: revision.id,
        lastRevision: otherDocument.revision,
      },
    });
    expect(wrong.status).toBe(403);
    expect(await Revision.count({ where: { documentId: document.id } })).toBe(
      1
    );
  });

  it("restores a historical table after conversion to an ordinary document", async () => {
    const { user, document, revision, table, lastRevision } = await setup();
    const changed = await server.post("/api/documents.update", user, {
      body: {
        id: document.id,
        text: "Current ordinary document",
        lastRevision,
      },
    });
    expect(changed.status).toBe(200);
    const converted = (await changed.json()).data;
    const unguarded = await server.post("/api/documents.restore", user, {
      body: { id: document.id, revisionId: revision.id },
    });
    expect(unguarded.status).toBe(400);
    const restored = await server.post("/api/documents.restore", user, {
      body: {
        id: document.id,
        revisionId: revision.id,
        lastRevision: converted.revision,
      },
    });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data.table).toEqual(table);
    const backups = await Revision.findAll({
      where: { documentId: document.id },
    });
    expect(
      backups.some((version) =>
        JSON.stringify(version.content).includes("Current ordinary document")
      )
    ).toBe(true);
  });
});
