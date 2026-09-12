import { randomUUID } from "node:crypto";
import { Transaction } from "sequelize";
import {
  getLightweightTable,
  tableToMarkdown,
  type LightweightTable,
} from "@shared/utils/lightweightTable";
import { createContext } from "@server/context";
import { parser } from "@server/editor";
import { Document, User } from "@server/models";
import { TextHelper } from "@server/models/helpers/TextHelper";
import { sequelize } from "@server/storage/database";
import documentUpdater from "./documentUpdater";

const table: LightweightTable = {
  format: "outline-table",
  version: 1,
  columns: [{}],
  rows: [{ cells: [{ value: "Original" }] }],
};

// Exercise the real command and model instances; only persistence and attachment
// IO are stubbed. These tests do not establish PostgreSQL lock semantics.
function setup() {
  const user = User.build({ id: randomUUID(), teamId: randomUUID() });
  const document = Document.build(
    {
      id: randomUUID(),
      teamId: user.teamId,
      title: "Original",
      content: parser.parse(tableToMarkdown(table)).toJSON(),
      revisionCount: 0,
    },
    { isNewRecord: false, raw: true }
  );
  // Constructing a transaction does not connect or start a SQL transaction.
  const transaction = new Transaction(sequelize, {});
  const ctx = createContext({ user, transaction });
  const scope = Document.unscoped();
  vi.spyOn(Document, "unscoped").mockReturnValue(scope);
  const lock = vi.spyOn(scope, "findOne").mockResolvedValue(null);
  const save = vi.spyOn(document, "saveWithCtx").mockResolvedValue(document);
  const images = vi
    .spyOn(TextHelper, "replaceImagesWithAttachments")
    .mockImplementation(async (_ctx, text) => text);
  return { ctx, document, transaction, lock, save, images };
}

afterEach(() => vi.restoreAllMocks());

describe("documentUpdater revision guards (no database)", () => {
  it("rejects a lost revision race before mutating content or processing attachments", async () => {
    const { ctx, document, transaction, lock, save, images } = setup();
    const content = document.content;

    await expect(
      documentUpdater(ctx, {
        document,
        title: "Must not change",
        text: "Must not be processed",
        lastRevision: 0,
      })
    ).rejects.toMatchObject({ status: 409, id: "document_conflict" });

    expect(lock).toHaveBeenCalledWith({
      attributes: ["id", "revisionCount"],
      where: { id: document.id, revisionCount: 0 },
      transaction,
      lock: transaction.LOCK.UPDATE,
      paranoid: false,
    });
    expect(document.title).toBe("Original");
    expect(document.content).toEqual(content);
    expect(document.revisionCount).toBe(0);
    expect(images).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("requires a revision before changing table content through Markdown", async () => {
    const { ctx, document, lock, save, images } = setup();
    lock.mockResolvedValue(document);

    await expect(
      documentUpdater(ctx, {
        document,
        title: "Must not change",
        text: "![image](data:image/png;base64,aGVsbG8=)",
      })
    ).rejects.toMatchObject({ status: 400, id: "validation_error" });

    expect(document.title).toBe("Original");
    expect(getLightweightTable(document.content ?? undefined)).toEqual(table);
    expect(document.revisionCount).toBe(0);
    expect(images).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("requires a revision when converting an ordinary document to a table", async () => {
    const { ctx, document, lock, save, images } = setup();
    const content = parser.parse("Ordinary document").toJSON();
    document.set({ content }, { raw: true });
    lock.mockResolvedValue(document);

    await expect(
      documentUpdater(ctx, {
        document,
        title: "Must not change",
        text: tableToMarkdown(table),
      })
    ).rejects.toMatchObject({ status: 400, id: "validation_error" });

    expect(document.title).toBe("Original");
    expect(document.content).toEqual(content);
    expect(images).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
