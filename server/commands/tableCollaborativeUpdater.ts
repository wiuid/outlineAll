import { createHash } from "node:crypto";
import type { IWorkbookData } from "@univerjs/core";
import type { Transaction } from "sequelize";
import * as Y from "yjs";
import {
  createTableCollaboration,
  decodeTableBytes,
  encodeTableBytes,
  materializeTable,
  validateTableCollaboration,
  type TableCollaborationResponse,
} from "@shared/utils/tableCollaboration";
import {
  getTableDocument,
  tableDocumentToMarkdown,
} from "@shared/utils/tableDocument";
import { parser } from "@server/editor";
import { DocumentConflictError, ValidationError } from "@server/errors";
import { Document, Event, TableCollaboration } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import type User from "@server/models/User";
import { authorize } from "@server/policies";
import { sequelize } from "@server/storage/database";
import Redis from "@server/storage/redis";
import { AuthenticationType } from "@server/types";
import Logger from "@server/logging/Logger";
import { toError } from "@shared/utils/error";
import { calculateTableFormulas } from "@server/utils/tableFormulaCalculator";

/** Redis carries revision notifications only; table data always uses the API. */
export const TABLE_COLLABORATION_CHANNEL = "tables:committed";

/** A bounded client delta, optionally guarded for complex native range moves. */
export interface TableCollaborationInput {
  documentId: string;
  vector?: string;
  epoch?: string;
  update?: string;
  title?: string;
  exclusiveRevision?: number;
  baseRevision?: number;
}

/**
 * Reads or commits collaborative changes in the same transaction as the native
 * document snapshot. A successful response acknowledges durable persistence.
 *
 * @param user the authenticated member; never supplied by the request body.
 * @param input the document, state vector and optional local changes.
 * @returns the missing shared changes and their committed document revision.
 * @throws {DocumentConflictError} if the epoch or guarded revision is stale.
 * @throws {ValidationError} if the delta cannot produce a valid native table.
 */
export async function tableCollaborativeUpdater(
  user: User,
  input: TableCollaborationInput
): Promise<TableCollaborationResponse> {
  let clientVector: Uint8Array | undefined;
  if (input.vector) {
    try {
      clientVector = decodeTableBytes(input.vector);
      Y.decodeStateVector(clientVector);
    } catch {
      throw ValidationError("Invalid table state vector");
    }
  }
  return sequelize.transaction(async (transaction) => {
    const document = await loadDocument(
      user,
      input.documentId,
      transaction,
      !!input.update
    );
    const table = getTableDocument(await DocumentHelper.toJSON(document));
    if (!table || table.version !== 2) {
      throw ValidationError(
        "Realtime collaboration requires a native spreadsheet"
      );
    }
    let record = await TableCollaboration.findOne({
      where: { documentId: document.id },
      transaction,
    });
    if (record) {
      const existing = new Y.Doc();
      try {
        Y.applyUpdate(existing, record.state);
        if (
          existing.getMap<string>("properties").get('["snapshotHash"]') !==
          fingerprint(table.workbook)
        ) {
          if (input.update) {
            throw DocumentConflictError();
          }
          await record.destroy({ transaction });
          record = null;
        }
      } finally {
        existing.destroy();
      }
    }
    if (input.update && (!record || input.epoch !== record.id)) {
      throw DocumentConflictError(
        "This workbook was replaced. Your local changes are preserved."
      );
    }
    if (
      input.update &&
      record &&
      (input.baseRevision === undefined ||
        input.baseRevision < record.barrierRevision)
    ) {
      throw DocumentConflictError(
        "This workbook's range layout changed. Your local changes are preserved."
      );
    }
    if (
      input.exclusiveRevision !== undefined &&
      input.exclusiveRevision !== document.revisionCount
    ) {
      throw DocumentConflictError(
        "This range changed while it was being rearranged. Your local changes are preserved."
      );
    }
    const doc = new Y.Doc();
    try {
      if (record) {
        Y.applyUpdate(doc, record.state);
      } else {
        const initial = createTableCollaboration(table.workbook);
        initial
          .getMap<string>("properties")
          .set('["snapshotHash"]', fingerprint(table.workbook));
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(initial));
        initial.destroy();
        record = await TableCollaboration.create(
          {
            documentId: document.id,
            state: Buffer.from(Y.encodeStateAsUpdate(doc)),
          },
          { transaction }
        );
      }
      const before = Buffer.from(Y.encodeStateAsUpdate(doc));
      if (input.update) {
        let workbook: IWorkbookData;
        try {
          Y.applyUpdate(doc, decodeTableBytes(input.update));
          validateTableCollaboration(doc);
          workbook = materializeTable(doc);
          if (workbook.id !== table.workbook.id) {
            throw new Error(
              "Workbook identity cannot change within a collaboration session"
            );
          }
        } catch (error) {
          Logger.warn("Rejected invalid table collaboration update", {
            documentId: document.id,
            message: toError(error).message,
          });
          throw ValidationError("Invalid table collaboration update");
        }
        const state = Buffer.from(Y.encodeStateAsUpdate(doc));
        if (
          !state.equals(before) ||
          (input.title !== undefined && input.title !== document.title)
        ) {
          const snapshot = await calculateTableFormulas(workbook);
          doc
            .getMap<string>("properties")
            .set('["snapshotHash"]', fingerprint(snapshot));
          const content = parser
            .parse(
              tableDocumentToMarkdown({
                format: "outline-table",
                version: 2,
                workbook: snapshot,
              })
            )
            .toJSON();
          await record.update(
            {
              state: Buffer.from(Y.encodeStateAsUpdate(doc)),
              ...(input.exclusiveRevision !== undefined && {
                barrierRevision: document.revisionCount + 1,
              }),
            },
            { transaction }
          );
          await document.update(
            {
              content,
              state: null,
              title: input.title?.trim() ?? document.title,
              revisionCount: document.revisionCount + 1,
              lastModifiedById: user.id,
              collaboratorIds: [
                ...new Set([...(document.collaboratorIds ?? []), user.id]),
              ],
            },
            { transaction, hooks: false }
          );
          transaction.afterCommit(async () => {
            await publishTableChange(document.id, document.revisionCount);
            await Event.schedule({
              name: "documents.update",
              documentId: document.id,
              collectionId: document.collectionId,
              teamId: document.teamId,
              actorId: user.id,
              authType: AuthenticationType.APP,
              data: { multiplayer: true, title: document.title },
            });
          });
        }
      }
      const vector =
        input.vector && input.epoch === record.id ? clientVector : undefined;
      return {
        epoch: record.id,
        revision: document.revisionCount,
        barrierRevision: record.barrierRevision,
        title: document.title,
        update: encodeTableBytes(Y.encodeStateAsUpdate(doc, vector)),
        vector: encodeTableBytes(Y.encodeStateVector(doc)),
      };
    } finally {
      doc.destroy();
    }
  });
}

function fingerprint(workbook: IWorkbookData): string {
  return createHash("sha256").update(JSON.stringify(workbook)).digest("hex");
}

/**
 * Notifies connected table views after a database transaction has committed.
 * Missed notifications are recovered by the client's reconnect reconciliation.
 *
 * @param documentId the committed document.
 * @param revision its current persisted revision.
 */
export async function publishTableChange(
  documentId: string,
  revision: number
): Promise<void> {
  try {
    await Redis.defaultClient.publish(
      TABLE_COLLABORATION_CHANNEL,
      JSON.stringify({ documentId, revision })
    );
  } catch (error) {
    Logger.error(
      "Unable to announce committed table revision",
      toError(error),
      { documentId }
    );
  }
}

async function loadDocument(
  user: User,
  id: string,
  transaction: Transaction,
  updating: boolean
): Promise<Document> {
  const candidate = await Document.findByPk(id, {
    userId: user.id,
    transaction,
  });
  authorize(user, updating ? "update" : "read", candidate);
  if (!candidate) {
    throw ValidationError("Spreadsheet not found");
  }
  await Document.unscoped().findOne({
    attributes: ["id"],
    where: { id: candidate.id },
    transaction,
    lock: transaction.LOCK.UPDATE,
    rejectOnEmpty: true,
  });
  const document = await Document.findByPk(candidate.id, {
    userId: user.id,
    transaction,
    rejectOnEmpty: true,
  });
  authorize(user, updating ? "update" : "read", document);
  return document;
}
