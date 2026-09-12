import {
  getTableDocument,
  tableDocumentToMarkdown,
  UniverTableSchema,
} from "@shared/utils/tableDocument";
import { parser } from "@server/editor";
import { Document } from "@server/models";
import { buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();
const table = UniverTableSchema.parse({
  format: "outline-table",
  version: 2,
  workbook: {
    id: "native-workbook",
    name: "原生表格",
    appVersion: "0.25.1",
    locale: "zhCN",
    styles: { bold: { bl: 1 } },
    sheetOrder: ["first", "second"],
    sheets: {
      first: {
        id: "first",
        name: "预算",
        rowCount: 1000,
        columnCount: 26,
        cellData: {
          0: { 0: { v: 15, s: "bold" }, 1: { f: "=SUM(A1:A2)", v: 36 } },
          1: { 0: { v: 21 } },
        },
        mergeData: [{ startRow: 2, endRow: 2, startColumn: 0, endColumn: 1 }],
      },
      second: { id: "second", name: "Sheet2" },
    },
    resources: [{ name: "SHEET_RESOURCE", data: "{}" }],
  },
});

describe("native table document API", () => {
  it.each(["structured", "Markdown"])(
    "creates, reads and updates native workbooks through %s",
    async (transport) => {
      const user = await buildUser();
      const input =
        transport === "structured"
          ? { table }
          : { text: tableDocumentToMarkdown(table) };
      const created = await server.post("/api/documents.create", user, {
        body: { title: "Table", ...input },
      });
      expect(created.status).toBe(200);
      const { data } = await created.json();
      expect(data.table).toEqual(table);
      const updatedTable = {
        ...table,
        workbook: { ...table.workbook, name: "Updated" },
      };
      const nextInput =
        transport === "structured"
          ? { table: updatedTable }
          : { text: tableDocumentToMarkdown(updatedTable) };
      const missing = await server.post("/api/documents.update", user, {
        body: { id: data.id, ...nextInput },
      });
      expect(missing.status).toBe(400);
      const updated = await server.post("/api/documents.update", user, {
        body: { id: data.id, lastRevision: data.revision, ...nextInput },
      });
      expect(updated.status).toBe(200);
      const result = await updated.json();
      expect(result.data.table).toEqual(updatedTable);
      expect(result.data.revision).toBe(data.revision + 1);
      const conflict = await server.post("/api/documents.update", user, {
        body: {
          id: data.id,
          lastRevision: data.revision,
          text: "stale Markdown",
        },
      });
      expect(conflict.status).toBe(409);
      const read = await server.post("/api/documents.info", user, {
        body: { id: data.id },
        headers: { "x-api-version": "4" },
      });
      expect(read.status).toBe(200);
      expect((await read.json()).data.document.table).toEqual(updatedTable);
      const stored = await Document.findByPk(data.id, { rejectOnEmpty: true });
      expect(getTableDocument(stored.content ?? undefined)).toEqual(
        updatedTable
      );
      expect(getTableDocument(parser.parse(result.data.text).toJSON())).toEqual(
        updatedTable
      );
      expect(stored.revisionCount).toBe(data.revision + 1);
    }
  );

  it("accepts exactly one concurrent native update and preserves its revision", async () => {
    const user = await buildUser();
    const created = await server.post("/api/documents.create", user, {
      body: { table },
    });
    const { data } = await created.json();
    const responses = await Promise.all(
      ["first writer", "second writer"].map((name) =>
        server.post("/api/documents.update", user, {
          body: {
            id: data.id,
            lastRevision: data.revision,
            table: { ...table, workbook: { ...table.workbook, name } },
          },
        })
      )
    );
    expect(responses.map((res) => res.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const winner = responses.find((res) => res.status === 200);
    const saved = await winner?.json();
    const stored = await Document.findByPk(data.id, { rejectOnEmpty: true });
    expect(getTableDocument(stored.content ?? undefined)).toEqual(
      saved.data.table
    );
    expect(stored.revisionCount).toBe(data.revision + 1);
  });

  it("does not expose or update native content for another team", async () => {
    const user = await buildUser();
    const other = await buildUser();
    const created = await server.post("/api/documents.create", user, {
      body: { table },
    });
    const { data } = await created.json();
    for (const action of ["info", "update"]) {
      const res = await server.post(`/api/documents.${action}`, other, {
        body: { id: data.id, table, lastRevision: data.revision },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).data).toBeUndefined();
    }
  });
});
