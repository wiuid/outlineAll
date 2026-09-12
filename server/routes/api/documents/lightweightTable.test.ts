import { TextEditMode } from "@shared/types";
import {
  getLightweightTable,
  tableToMarkdown,
  type LightweightTable,
} from "@shared/utils/lightweightTable";
import documentUpdater from "@server/commands/documentUpdater";
import { createContext } from "@server/context";
import { parser } from "@server/editor";
import { Document, Event } from "@server/models";
import { buildDocument, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();

const table: LightweightTable = {
  format: "outline-table",
  version: 1,
  columns: [{ width: 180 }, {}, {}],
  rows: [
    {
      cells: [{ value: 2 }, { value: 3 }, { formula: "=SUM(A1:B1)" }],
    },
    {
      height: 80,
      cells: [
        {
          value:
            "第一行\n第二行\r\n``` <script>alert(1)</script> ![image](https://example.com/image.png)",
          style: {
            bold: true,
            italic: true,
            color: "#123456",
            background: "#abcdef",
            wrap: true,
          },
        },
        { value: true },
        { value: null },
      ],
    },
  ],
};

const updatedTable: LightweightTable = {
  ...table,
  columns: [{ width: 240 }, {}, {}],
  rows: [
    { cells: [{ value: 10 }, { value: 20 }, { formula: "=SUM(A1:B1)" }] },
    ...table.rows.slice(1),
    { cells: [{ value: "New row" }, { value: false }, { value: null }] },
  ],
};

describe("lightweight table document API", () => {
  it.each([
    { text: "Unversioned replacement" },
    { text: "" },
    { text: tableToMarkdown(updatedTable) },
    { text: "Appended", editMode: TextEditMode.Append },
    { text: "Appended", append: true },
    { text: "Prepended", editMode: TextEditMode.Prepend },
    { text: "Changed", editMode: TextEditMode.Patch, findText: "第一行" },
  ])(
    "requires a revision when editing a table through Markdown (%#)",
    async (input) => {
      const user = await buildUser();
      const created = await server.post("/api/documents.create", user, {
        body: { title: "Original", table },
      });
      expect(created.status).toBe(200);
      const { data } = await created.json();

      const response = await server.post("/api/documents.update", user, {
        body: { id: data.id, title: "Not saved", ...input },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "validation_error",
      });

      const stored = await Document.findByPk(data.id, { rejectOnEmpty: true });
      expect(stored.title).toBe("Original");
      expect(stored.revisionCount).toBe(data.revision);
      expect(getLightweightTable(stored.content ?? undefined)).toEqual(table);
    }
  );

  it("requires a revision before writing structured table input", async () => {
    const user = await buildUser();
    const created = await server.post("/api/documents.create", user, {
      body: { title: "Original", table },
    });
    expect(created.status).toBe(200);
    const { data } = await created.json();

    const response = await server.post("/api/documents.update", user, {
      body: { id: data.id, title: "Not saved", table },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "validation_error" });

    const stored = await Document.findByPk(data.id, { rejectOnEmpty: true });
    expect(stored.title).toBe("Original");
    expect(stored.revisionCount).toBe(data.revision);
    expect(getLightweightTable(stored.content ?? undefined)).toEqual(table);
  });

  it.each([{ table }, { text: tableToMarkdown(table) }])(
    "persists table input through create/info (%#)",
    async (input) => {
      const user = await buildUser();
      const created = await server.post("/api/documents.create", user, {
        body: { title: "Table", ...input },
      });
      expect(created.status).toBe(200);
      const { data } = await created.json();
      expect(data.table).toEqual(table);
      expect(data.revision).toEqual(expect.any(Number));
      expect(getLightweightTable(parser.parse(data.text).toJSON())).toEqual(
        table
      );

      const stored = await Document.findByPk(data.id, { rejectOnEmpty: true });
      expect(getLightweightTable(stored.content ?? undefined)).toEqual(table);
      expect(stored.revisionCount).toBe(data.revision);

      const response = await server.post("/api/documents.info", user, {
        body: { id: data.id },
        headers: { "x-api-version": "3" },
      });
      expect(response.status).toBe(200);
      const read = await response.json();
      expect(read.data.document.table).toEqual(table);
      expect(getLightweightTable(read.data.document.data)).toEqual(table);
      expect(read.data.document.revision).toBe(data.revision);

      const legacyResponse = await server.post("/api/documents.info", user, {
        body: { id: data.id },
      });
      expect(legacyResponse.status).toBe(200);
      const legacy = await legacyResponse.json();
      expect(legacy.data.table).toEqual(table);
      expect(
        getLightweightTable(parser.parse(legacy.data.text).toJSON())
      ).toEqual(table);
      expect(legacy.data.revision).toBe(data.revision);
    }
  );

  it.each([{ table: updatedTable }, { text: tableToMarkdown(updatedTable) }])(
    "updates and reads a table, then rejects an obsolete revision (%#)",
    async (input) => {
      const user = await buildUser();
      const created = await server.post("/api/documents.create", user, {
        body: { title: "Original", table },
      });
      expect(created.status).toBe(200);
      const { data } = await created.json();

      const response = await server.post("/api/documents.update", user, {
        body: {
          id: data.id,
          title: "Updated",
          lastRevision: data.revision,
          ...input,
        },
        headers: { "x-api-version": "3" },
      });
      expect(response.status).toBe(200);
      const updated = await response.json();
      expect(updated.data.table).toEqual(updatedTable);
      expect(getLightweightTable(updated.data.data)).toEqual(updatedTable);
      expect(updated.data.revision).toBe(data.revision + 1);

      const conflict = await server.post("/api/documents.update", user, {
        body: {
          id: data.id,
          title: "Not saved",
          table,
          lastRevision: data.revision,
        },
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({
        error: "document_conflict",
      });

      const read = await server.post("/api/documents.info", user, {
        body: { id: data.id },
      });
      expect(read.status).toBe(200);
      const result = await read.json();
      expect(result.data.title).toBe("Updated");
      expect(result.data.table).toEqual(updatedTable);
      expect(result.data.revision).toBe(updated.data.revision);
      expect(
        getLightweightTable(parser.parse(result.data.text).toJSON())
      ).toEqual(updatedTable);

      const stored = await Document.findByPk(data.id, { rejectOnEmpty: true });
      expect(stored.title).toBe("Updated");
      expect(getLightweightTable(stored.content ?? undefined)).toEqual(
        updatedTable
      );
      expect(stored.revisionCount).toBe(updated.data.revision);
      expect(
        await Event.count({
          where: { documentId: data.id, name: "documents.update" },
        })
      ).toBe(1);
    }
  );

  it("allows exactly one concurrent API writer for a revision", async () => {
    const user = await buildUser();
    const created = await server.post("/api/documents.create", user, {
      body: { title: "Original", table },
    });
    expect(created.status).toBe(200);
    const { data } = await created.json();
    const competingTable: LightweightTable = {
      ...updatedTable,
      rows: [
        {
          cells: [{ value: "Other writer" }, { value: 5 }, { formula: "=B1" }],
        },
      ],
    };

    // Both requests load the original revision before either lock query runs.
    // The actual PostgreSQL queries, locks, and commits remain unstubbed.
    const waiters: (() => void)[] = [];
    const hook = "lightweight-table-concurrent-writers";
    Document.addHook("beforeFind", hook, async (options) => {
      if (!options.lock) {
        return;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (waiters.length === 2) {
          waiters.forEach((release) => release());
        }
      });
    });

    try {
      const responses = await Promise.all(
        [updatedTable, competingTable].map((nextTable) =>
          server.post("/api/documents.update", user, {
            body: {
              id: data.id,
              table: nextTable,
              lastRevision: data.revision,
            },
          })
        )
      );
      expect(waiters).toHaveLength(2);
      expect(
        responses
          .map((response) => response.status)
          .sort((left, right) => left - right)
      ).toEqual([200, 409]);
      const winner = responses.find((response) => response.status === 200);
      const loser = responses.find((response) => response.status === 409);
      if (!winner || !loser) {
        throw new Error("Expected one successful update and one conflict");
      }

      const result = await winner.json();
      expect(result.data.revision).toBe(data.revision + 1);
      expect(await loser.json()).toMatchObject({ error: "document_conflict" });
      const stored = await Document.findByPk(data.id, { rejectOnEmpty: true });
      expect(getLightweightTable(stored.content ?? undefined)).toEqual(
        result.data.table
      );
      expect(stored.revisionCount).toBe(data.revision + 1);
      expect(
        await Event.count({
          where: { documentId: data.id, name: "documents.update" },
        })
      ).toBe(1);
    } finally {
      Document.removeHook("beforeFind", hook);
      waiters.forEach((release) => release());
    }
  });

  it("protects internal updates without a caller transaction and refreshes stale metadata writes", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      userId: user.id,
      teamId: user.teamId,
      text: tableToMarkdown(table),
    });
    const initialRevision = document.revisionCount;
    const stale = await Document.findByPk(document.id, { rejectOnEmpty: true });
    const updated = await documentUpdater(createContext({ user }), {
      document,
      text: tableToMarkdown(updatedTable),
      lastRevision: initialRevision,
    });
    expect(updated.revisionCount).toBe(initialRevision + 1);

    await expect(
      documentUpdater(createContext({ user }), {
        document: stale,
        title: "Not saved",
        text: tableToMarkdown(table),
        lastRevision: initialRevision,
      })
    ).rejects.toMatchObject({ status: 409, id: "document_conflict" });

    const renamed = await documentUpdater(createContext({ user }), {
      document: stale,
      title: "Renamed",
    });
    expect(renamed.revisionCount).toBe(initialRevision + 2);
    expect(getLightweightTable(renamed.content ?? undefined)).toEqual(
      updatedTable
    );

    const conflict = await server.post("/api/documents.update", user, {
      body: { id: document.id, table, lastRevision: updated.revisionCount },
    });
    expect(conflict.status).toBe(409);
    const stored = await Document.findByPk(document.id, {
      rejectOnEmpty: true,
    });
    expect(stored.title).toBe("Renamed");
    expect(stored.revisionCount).toBe(renamed.revisionCount);
    expect(getLightweightTable(stored.content ?? undefined)).toEqual(
      updatedTable
    );
  });

  it("checks the locked state when a stale ordinary document has become a table", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      userId: user.id,
      teamId: user.teamId,
      text: "Ordinary document",
    });
    const stale = await Document.findByPk(document.id, { rejectOnEmpty: true });
    const converted = await server.post("/api/documents.update", user, {
      body: { id: document.id, table, lastRevision: document.revisionCount },
    });
    expect(converted.status).toBe(200);

    await expect(
      documentUpdater(createContext({ user }), {
        document: stale,
        title: "Not saved",
        text: "Unversioned replacement",
      })
    ).rejects.toMatchObject({ status: 400, id: "validation_error" });

    const stored = await Document.findByPk(document.id, {
      rejectOnEmpty: true,
    });
    expect(stored.title).toBe(document.title);
    expect(getLightweightTable(stored.content ?? undefined)).toEqual(table);
    expect(stored.revisionCount).toBe(document.revisionCount + 1);
  });

  it("requires a revision for Markdown conversion and supports versioned conversion back to text", async () => {
    const user = await buildUser();
    const document = await buildDocument({
      userId: user.id,
      teamId: user.teamId,
      text: "Ordinary document",
    });
    const missingRevision = await server.post("/api/documents.update", user, {
      body: { id: document.id, text: tableToMarkdown(table) },
    });
    expect(missingRevision.status).toBe(400);

    const converted = await server.post("/api/documents.update", user, {
      body: {
        id: document.id,
        text: tableToMarkdown(table),
        lastRevision: document.revisionCount,
      },
    });
    expect(converted.status).toBe(200);
    const { data } = await converted.json();
    expect(data.table).toEqual(table);

    const restored = await server.post("/api/documents.update", user, {
      body: {
        id: document.id,
        text: "Ordinary again",
        lastRevision: data.revision,
      },
    });
    expect(restored.status).toBe(200);
    const result = await restored.json();
    expect(result.data.table).toBeUndefined();
    expect(result.data.text).toBe("Ordinary again");
    expect(result.data.revision).toBe(data.revision + 1);
  });

  it.each([
    "Ordinary Markdown",
    "| A | B |\n| --- | --- |\n| 1 | 2 |",
    `${tableToMarkdown(table)}\n\nOther content`,
    "```outline-table\nnot JSON\n```",
  ])("preserves ordinary Markdown update behavior (%#)", async (text) => {
    const user = await buildUser();
    const created = await server.post("/api/documents.create", user, {
      body: { title: "Ordinary", text },
    });
    expect(created.status).toBe(200);
    const { data } = await created.json();
    expect(data.table).toBeUndefined();

    const updated = await server.post("/api/documents.update", user, {
      body: { id: data.id, text: `${text}\n\nUpdated` },
    });
    expect(updated.status).toBe(200);
    const result = await updated.json();
    expect(result.data.table).toBeUndefined();
    expect(result.data.text).toContain("Updated");
  });

  it("keeps table reads and writes behind document permissions", async () => {
    const user = await buildUser();
    const other = await buildUser();
    const created = await server.post("/api/documents.create", user, {
      body: { title: "Private table", table },
    });
    expect(created.status).toBe(200);
    const { data } = await created.json();

    for (const endpoint of ["info", "update"]) {
      const body = {
        id: data.id,
        table: updatedTable,
        lastRevision: data.revision,
      };
      const anonymous = await server.post(`/api/documents.${endpoint}`, {
        body,
      });
      expect(anonymous.status).toBe(401);
      const forbidden = await server.post(`/api/documents.${endpoint}`, other, {
        body,
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).not.toHaveProperty("data");
    }

    const stored = await Document.findByPk(data.id, { rejectOnEmpty: true });
    expect(getLightweightTable(stored.content ?? undefined)).toEqual(table);
    expect(stored.revisionCount).toBe(data.revision);
  });

  it("returns a validation error for oversized structured input", async () => {
    const user = await buildUser();
    const response = await server.post("/api/documents.create", user, {
      body: {
        title: "Too large",
        table: {
          ...table,
          columns: [{}],
          rows: Array.from({ length: 51 }, () => ({
            cells: [{ value: "x".repeat(10_000) }],
          })),
        },
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "validation_error" });
    expect(
      await Document.unscoped().count({ where: { teamId: user.teamId } })
    ).toBe(0);
  });
});
