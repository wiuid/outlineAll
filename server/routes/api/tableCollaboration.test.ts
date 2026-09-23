import { LocaleType } from "@univerjs/core";
import * as Y from "yjs";
import { CollectionPermission } from "@shared/types";
import { DocumentValidation } from "@shared/validations";
import {
  captureTableChanges,
  decodeTableBytes,
  encodeTableBytes,
  getTableLayout,
  materializeTable,
  TableCollaborationResponseSchema,
  type TableCollaborationResponse,
} from "@shared/utils/tableCollaboration";
import {
  UniverTableSchema,
  tableDocumentToMarkdown,
} from "@shared/utils/tableDocument";
import { Document, Event } from "@server/models";
import { parser } from "@server/editor";
import {
  createTableScript,
  runTableScript,
} from "@server/commands/tableScriptManager";
import { performTableScriptRun } from "@server/commands/tableScriptExecutor";
import * as runner from "@server/utils/tableScriptRunner";
import environment from "@server/utils/environment";
import { buildCollection, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();
const table = UniverTableSchema.parse({
  format: "outline-table",
  version: 2,
  workbook: {
    id: "collaborative-book",
    name: "Collaboration",
    appVersion: "0.25.1",
    locale: LocaleType.EN_US,
    styles: {},
    sheetOrder: ["sheet"],
    sheets: {
      sheet: {
        id: "sheet",
        name: "Sheet1",
        rowCount: 20,
        columnCount: 5,
        cellData: { 0: { 0: { v: 2 }, 1: { f: "=A1*2", v: 4 } } },
      },
    },
  },
});

function change(state: TableCollaborationResponse, row: number, value: number) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, decodeTableBytes(state.update));
  const before = materializeTable(doc);
  const after = structuredClone(before);
  after.sheets.sheet.cellData = {
    ...after.sheets.sheet.cellData,
    [row]: { ...after.sheets.sheet.cellData?.[row], 0: { v: value } },
  };
  const layout = getTableLayout(doc);
  captureTableChanges(doc, before, after, layout, structuredClone(layout), {});
  return {
    epoch: state.epoch,
    baseRevision: state.revision,
    update: encodeTableBytes(
      Y.encodeStateAsUpdate(doc, decodeTableBytes(state.vector))
    ),
    vector: encodeTableBytes(Y.encodeStateVector(doc)),
  };
}

async function fixture() {
  const user = await buildUser();
  const collection = await buildCollection({
    teamId: user.teamId,
    permission: CollectionPermission.ReadWrite,
  });
  const created = await server.post("/api/documents.create", user, {
    body: {
      title: "Shared",
      table,
      collectionId: collection.id,
      publish: true,
    },
  });
  expect(created.status).toBe(200);
  const { data } = await created.json();
  const info = await server.post("/api/tableCollaboration.info", user, {
    body: { documentId: data.id },
  });
  expect(info.status).toBe(200);
  const state = TableCollaborationResponseSchema.parse(
    (await info.json()).data
  );
  return { user, id: data.id, state, collection };
}

describe("table collaboration database integration", () => {
  it("atomically merges concurrent editors, persists formula results and acknowledges duplicates", async () => {
    const { user, id, state } = await fixture();
    const other = await buildUser({ teamId: user.teamId });
    const first = change(state, 0, 7);
    const second = change(state, 1, 9);
    const responses = await Promise.all([
      server.post("/api/tableCollaboration.update", user, {
        body: { documentId: id, ...first },
      }),
      server.post("/api/tableCollaboration.update", other, {
        body: { documentId: id, ...second },
      }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const info = await server.post("/api/documents.info", user, {
      body: { id },
    });
    const saved = (await info.json()).data;
    expect(saved.table.workbook.sheets.sheet.cellData[0][0].v).toBe(7);
    expect(saved.table.workbook.sheets.sheet.cellData[1][0].v).toBe(9);
    expect(saved.table.workbook.sheets.sheet.cellData[0][1].v).toBe(14);
    expect(saved.revision).toBe(state.revision + 2);
    const duplicate = await server.post(
      "/api/tableCollaboration.update",
      user,
      { body: { documentId: id, ...first } }
    );
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).data.revision).toBe(saved.revision);
    const old = await server.post("/api/documents.update", user, {
      body: { id, table, lastRevision: state.revision },
    });
    expect(old.status).toBe(409);
  }, 20000);

  it("invalidates old collaboration epochs after an explicit API replacement", async () => {
    const { user, id, state } = await fixture();
    const replacement = structuredClone(table);
    replacement.workbook.name = "Replaced";
    const updated = await server.post("/api/documents.update", user, {
      body: { id, table: replacement, lastRevision: state.revision },
    });
    expect(updated.status).toBe(200);
    const stale = await server.post("/api/tableCollaboration.update", user, {
      body: { documentId: id, ...change(state, 0, 55) },
    });
    expect(stale.status).toBe(409);
    const info = await server.post("/api/tableCollaboration.info", user, {
      body: { documentId: id },
    });
    expect((await info.json()).data.epoch).not.toBe(state.epoch);
  });

  it("rejects invalid Yjs data without changing the persisted document", async () => {
    const { user, id, state } = await fixture();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeTableBytes(state.update));
    doc.getMap("outside").set("field", "invalid");
    const res = await server.post("/api/tableCollaboration.update", user, {
      body: {
        documentId: id,
        epoch: state.epoch,
        baseRevision: state.revision,
        update: encodeTableBytes(Y.encodeStateAsUpdate(doc)),
      },
    });
    expect(res.status).toBe(400);
    const info = await server.post("/api/tableCollaboration.info", user, {
      body: { documentId: id },
    });
    expect((await info.json()).data.revision).toBe(state.revision);
  });

  it("rejects stale writes on both sides of a complex range rearrangement", async () => {
    const { user, id, state } = await fixture();
    const first = await server.post("/api/tableCollaboration.update", user, {
      body: {
        documentId: id,
        ...change(state, 0, 11),
        exclusiveRevision: state.revision,
      },
    });
    expect(first.status).toBe(200);
    const stale = await server.post("/api/tableCollaboration.update", user, {
      body: { documentId: id, ...change(state, 1, 12) },
    });
    expect(stale.status).toBe(409);
    const exclusive = await server.post(
      "/api/tableCollaboration.update",
      user,
      {
        body: {
          documentId: id,
          ...change(state, 1, 13),
          exclusiveRevision: state.revision,
        },
      }
    );
    expect(exclusive.status).toBe(409);
  });

  it("rechecks read and edit permissions for every synchronization request", async () => {
    const { user, id, state, collection } = await fixture();
    const outsider = await buildUser();
    const viewer = await buildUser({ teamId: user.teamId });
    await collection.update({ permission: CollectionPermission.Read });
    const read = await server.post("/api/tableCollaboration.info", viewer, {
      body: { documentId: id },
    });
    expect(read.status).toBe(200);
    const denied = await server.post("/api/tableCollaboration.update", viewer, {
      body: { documentId: id, ...change(state, 0, 66) },
    });
    expect(denied.status).toBe(403);
    const hidden = await server.post("/api/tableCollaboration.info", outsider, {
      body: { documentId: id },
    });
    expect(hidden.status).toBe(403);
  });

  it("detects snapshots restored outside the table update API before accepting old deltas", async () => {
    const { user, id, state } = await fixture();
    const restored = structuredClone(table);
    restored.workbook.name = "Restored snapshot";
    await Document.update(
      {
        content: parser.parse(tableDocumentToMarkdown(restored)).toJSON(),
        state: null,
        revisionCount: state.revision + 1,
      },
      { where: { id }, hooks: false }
    );
    const stale = await server.post("/api/tableCollaboration.update", user, {
      body: { documentId: id, ...change(state, 0, 99) },
    });
    expect(stale.status).toBe(409);
    const current = await server.post("/api/tableCollaboration.info", user, {
      body: { documentId: id },
    });
    expect(current.status).toBe(200);
    expect((await current.json()).data.epoch).not.toBe(state.epoch);
  });

  it("rejects malformed synchronization vectors as client errors", async () => {
    const { user, id, state } = await fixture();
    const invalid = await server.post("/api/tableCollaboration.info", user, {
      body: { documentId: id, epoch: state.epoch, vector: "AAAA!!!!" },
    });
    expect(invalid.status).toBe(400);
  });

  it("rejects titles that exceed the document title limit", async () => {
    const { user, id, state } = await fixture();
    const invalid = await server.post("/api/tableCollaboration.update", user, {
      body: {
        documentId: id,
        ...change(state, 0, 3),
        title: "x".repeat(DocumentValidation.maxTitleLength + 1),
      },
    });

    expect(invalid.status).toBe(400);
    const current = await server.post("/api/documents.info", user, {
      body: { id },
    });
    expect((await current.json()).data.revision).toBe(state.revision);
  });

  it("acknowledges a committed update when event scheduling fails", async () => {
    const { user, id, state } = await fixture();
    vi.spyOn(Event, "schedule").mockRejectedValueOnce(
      new Error("Event queue unavailable")
    );

    const updated = await server.post("/api/tableCollaboration.update", user, {
      body: { documentId: id, ...change(state, 0, 17) },
    });

    expect(updated.status).toBe(200);
    expect((await updated.json()).data.revision).toBe(state.revision + 1);
    const current = await server.post("/api/documents.info", user, {
      body: { id },
    });
    expect(
      (await current.json()).data.table.workbook.sheets.sheet.cellData[0][0].v
    ).toBe(17);
  });

  it("provides the committed collaborative values and calculated formulas to Python execution", async () => {
    const { user, id, state } = await fixture();
    const updated = await server.post("/api/tableCollaboration.update", user, {
      body: { documentId: id, ...change(state, 0, 21) },
    });
    expect(updated.status).toBe(200);
    const revision = (await updated.json()).data.revision;
    const previousUrl = environment.TABLE_SCRIPT_RUNNER_URL;
    const previousToken = environment.TABLE_SCRIPT_RUNNER_TOKEN;
    environment.TABLE_SCRIPT_RUNNER_URL = "https://runner.example.com";
    environment.TABLE_SCRIPT_RUNNER_TOKEN =
      "test-runner-credential-32-characters";
    const execute = vi
      .spyOn(runner, "executeTableScript")
      .mockResolvedValue({ status: "succeeded", output: "42\n" });
    try {
      const script = await createTableScript(user, id, {
        name: "snapshot.py",
        source: "print('test snapshot')",
      });
      const run = await runTableScript(user, script.id, script.revision);
      await run.update({ status: "running", startedAt: new Date() });
      await performTableScriptRun(run);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0].document).toMatchObject({
        id,
        revision,
        table: {
          workbook: {
            sheets: {
              sheet: {
                cellData: { 0: { 0: { v: 21 }, 1: { v: 42, f: "=A1*2" } } },
              },
            },
          },
        },
      });
      expect((await run.reload()).status).toBe("succeeded");
      await run.destroy();
      await script.destroy({ force: true });
    } finally {
      execute.mockRestore();
      if (previousUrl === undefined) {
        delete environment.TABLE_SCRIPT_RUNNER_URL;
      } else {
        environment.TABLE_SCRIPT_RUNNER_URL = previousUrl;
      }
      if (previousToken === undefined) {
        delete environment.TABLE_SCRIPT_RUNNER_TOKEN;
      } else {
        environment.TABLE_SCRIPT_RUNNER_TOKEN = previousToken;
      }
    }
  }, 15000);
});
