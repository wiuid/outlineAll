import isEqual from "fast-deep-equal";
import { traceFunction } from "@server/logging/tracing";
import { getTableDocument } from "@shared/utils/tableDocument";
import {
  ValidationError,
  DocumentConflictError,
  NotFoundError,
} from "@server/errors";
import {
  Collection,
  Revision,
  Document,
  TableCollaboration,
} from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { sequelize } from "@server/storage/database";
import { authorize } from "@server/policies";
import type { APIContext } from "@server/types";
import { assertPresent } from "@server/validation";
import { publishTableChange } from "./tableCollaborativeUpdater";

type Props = {
  /** The document to restore. Must be loaded with `paranoid: false`. */
  document: Document;
  /** Destination collection to restore into. Defaults to the original collection. */
  collectionId?: string | null;
  /** Revision to restore the document's content from, when not archived or deleted. */
  revisionId?: string | null;
  /** Current document revision, required when replacing table content. */
  lastRevision?: number;
};

/**
 * Restores a previously archived or deleted document, or restores a document's
 * content to a specific revision. Re-attaches the document to the destination
 * collection's structure when applicable and authorizes the acting user.
 *
 * @param ctx - the API context, providing the acting user and transaction.
 * @param props - the document and restore options.
 * @returns the restored document.
 * @throws ValidationError if the destination collection is not active.
 * @throws NotFoundError if the given revision does not exist.
 * @throws DocumentConflictError if the document changed after confirmation.
 * @throws ValidationError if table restoration is missing its current revision.
 */
async function documentRestorer(
  ctx: APIContext,
  props: Props
): Promise<Document> {
  if (!ctx.state.transaction) {
    return sequelize.transaction((transaction) =>
      documentRestorer(
        {
          ...ctx,
          state: { ...ctx.state, transaction },
          context: { ...ctx.context, transaction },
        },
        props
      )
    );
  }
  const { document, collectionId, revisionId, lastRevision } = props;
  const { user } = ctx.state.auth;
  const { transaction } = ctx.state;

  if (!document.deletedAt && !document.archivedAt && revisionId) {
    authorize(user, "update", document);
    const revision = await Revision.findByPk(revisionId, {
      transaction,
      rejectOnEmpty: true,
    });
    authorize(document, "restore", revision);
    const locked = await Document.unscoped().findOne({
      attributes: ["id", "revisionCount"],
      where: {
        id: document.id,
        ...(lastRevision !== undefined && { revisionCount: lastRevision }),
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
      paranoid: false,
    });
    if (!locked) {
      throw lastRevision !== undefined
        ? DocumentConflictError()
        : NotFoundError();
    }
    await document.reload({ transaction });
    // Permissions and lifecycle may have changed while waiting for the row lock.
    authorize(user, "update", document);
    if (document.deletedAt || document.archivedAt) {
      throw DocumentConflictError();
    }
    const currentContent = await DocumentHelper.toJSON(document);
    const isTable = !!(
      getTableDocument(currentContent) ||
      getTableDocument(await DocumentHelper.toJSON(revision))
    );
    if (isTable && lastRevision === undefined) {
      throw ValidationError(
        "lastRevision is required when restoring table content"
      );
    }
    if (isTable) {
      const latest = await Revision.findOne({
        where: { documentId: document.id },
        order: [["createdAt", "DESC"]],
        transaction,
      });
      if (
        !latest ||
        latest.title !== document.title ||
        latest.icon !== document.icon ||
        latest.color !== document.color ||
        !isEqual(await DocumentHelper.toJSON(latest), currentContent)
      ) {
        await Revision.createFromDocument(
          ctx,
          document,
          document.collaboratorIds
        );
      }
    }
    await document.restoreFromRevision(revision);
    document.lastModifiedById = user.id;
    document.updatedBy = user;
    await document.saveWithCtx(ctx, undefined, { name: "restore" });
    const removed = await TableCollaboration.destroy({
      where: { documentId: document.id },
      transaction,
    });
    if (isTable) {
      await Revision.createFromDocument(ctx, document, [user.id]);
    }
    if (removed || isTable) {
      transaction.afterCommit(() =>
        publishTableChange(document.id, document.revisionCount)
      );
    }
    return document;
  }

  const sourceCollectionId = document.collectionId;
  const destCollectionId = collectionId ?? sourceCollectionId;

  const srcCollection = sourceCollectionId
    ? await Collection.findByPk(sourceCollectionId, {
        userId: user.id,
        includeDocumentStructure: true,
        paranoid: false,
        transaction,
      })
    : undefined;

  const destCollection = destCollectionId
    ? await Collection.findByPk(destCollectionId, {
        userId: user.id,
        includeDocumentStructure: true,
        transaction,
      })
    : undefined;

  if (!destCollection?.isActive) {
    throw ValidationError(
      "Unable to restore, the collection may have been deleted or archived"
    );
  }

  if (sourceCollectionId && sourceCollectionId !== destCollection.id) {
    authorize(user, "updateDocument", srcCollection);
    await srcCollection?.removeDocumentInStructure(document, {
      save: true,
      transaction,
    });
  }

  if (document.deletedAt) {
    authorize(user, "restore", document);
    authorize(user, "updateDocument", destCollection);

    // restore a previously deleted document
    await document.restoreTo(ctx, { collectionId: destCollection.id });
  } else if (document.archivedAt) {
    authorize(user, "unarchive", document);
    authorize(user, "updateDocument", destCollection);

    // restore a previously archived document
    await document.restoreTo(ctx, { collectionId: destCollection.id });
  } else {
    assertPresent(revisionId, "revisionId is required");
  }

  return document;
}

export default traceFunction({
  spanName: "documentRestorer",
})(documentRestorer);
