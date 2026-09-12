import type { DocumentPreferences, TextEditMode } from "@shared/types";
import { getTableDocument } from "@shared/utils/tableDocument";
import { parser } from "@server/editor";
import {
  DocumentConflictError,
  NotFoundError,
  ValidationError,
} from "@server/errors";
import { Event, Document } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { TextHelper } from "@server/models/helpers/TextHelper";
import { sequelize } from "@server/storage/database";
import type { APIContext } from "@server/types";

interface Props {
  /** The existing document */
  document: Document;
  /** The new title */
  title?: string;
  /** The document icon */
  icon?: string | null;
  /** The document icon's color */
  color?: string | null;
  /** The new text content */
  text?: string;
  /** Whether the editing session is complete */
  done?: boolean;
  /** The version of the client editor that was used */
  editorVersion?: string;
  /** The ID of the template that was used */
  templateId?: string | null;
  /** If the document should be displayed full-width on the screen */
  fullWidth?: boolean;
  /** Display preferences for the document, merged with existing values */
  preferences?: DocumentPreferences | null;
  /** Whether insights should be visible on the document */
  insightsEnabled?: boolean;
  /** The edit mode: "replace", "append", "prepend", or "patch" */
  editMode?: TextEditMode;
  /** The document revision the changes are based on, the update is rejected if it no longer matches */
  lastRevision?: number;
  /** The markdown text to find when using "patch" edit mode */
  findText?: string;
  /** Whether the document should be published to the collection */
  publish?: boolean;
  /** The ID of the collection to publish the document to */
  collectionId?: string | null;
}

/**
 * This command updates document properties. To update collaborative text state
 * use documentCollaborativeUpdater. Starts a transaction when the caller has
 * not provided one, so revision checks and writes always share a row lock.
 *
 * @param ctx the API context for the update.
 * @param props the properties of the document to update.
 * @returns the updated document.
 * @throws {DocumentConflictError} if the revision no longer matches.
 * @throws {ValidationError} if a table content update is missing its revision.
 * @throws {NotFoundError} if the document no longer exists.
 */
export default async function documentUpdater(
  ctx: APIContext,
  props: Props
): Promise<Document> {
  if (!ctx.state.transaction) {
    return sequelize.transaction((transaction) =>
      documentUpdater(
        {
          ...ctx,
          state: { ...ctx.state, transaction },
          context: { ...ctx.context, transaction },
        },
        props
      )
    );
  }

  let { document } = props;
  const {
    title,
    icon,
    color,
    text,
    editorVersion,
    templateId,
    fullWidth,
    preferences,
    insightsEnabled,
    editMode,
    findText,
    lastRevision,
    publish,
    collectionId,
    done,
  } = props;
  const { user } = ctx.state.auth;
  const { transaction } = ctx.state;

  // Check under a row lock before mutating the instance or processing attachments.
  // The revision predicate is rechecked by PostgreSQL after a concurrent writer
  // releases its lock, so only one writer can commit against a given revision.
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

  // A writer may have committed while this request was waiting for the lock.
  // Refresh the instance so content edits and revision increments use that state.
  if (locked.revisionCount !== document.revisionCount) {
    await document.reload({ transaction });
  }

  if (
    text !== undefined &&
    lastRevision === undefined &&
    (getTableDocument(await DocumentHelper.toJSON(document)) ||
      getTableDocument(parser.parse(text).toJSON()))
  ) {
    throw ValidationError(
      "lastRevision is required when updating a lightweight table"
    );
  }

  const cId = collectionId || document.collectionId;

  if (title !== undefined) {
    document.title = title.trim();
  }
  if (icon !== undefined) {
    document.icon = icon;
  }
  if (color !== undefined) {
    document.color = color;
  }
  if (editorVersion) {
    document.editorVersion = editorVersion;
  }
  if (templateId) {
    document.templateId = templateId;
  }
  if (fullWidth !== undefined) {
    document.fullWidth = fullWidth;
  }
  if (preferences) {
    document.preferences = {
      ...document.preferences,
      ...preferences,
    };
  }
  if (insightsEnabled !== undefined) {
    document.insightsEnabled = insightsEnabled;
  }
  if (text !== undefined) {
    document = DocumentHelper.applyMarkdownToDocument(
      document,
      await TextHelper.replaceImagesWithAttachments(ctx, text, user, {
        base64Only: true,
      }),
      editMode,
      findText
    );
  }

  const changed = document.changed();
  const eventData = done !== undefined ? { done } : undefined;

  const event = {
    name: "documents.update",
    documentId: document.id,
    collectionId: cId,
    data: eventData,
  };

  if (publish && cId) {
    if (!document.collectionId) {
      document.collectionId = cId;
    }
    await document.publish(ctx, { collectionId: cId, data: eventData });
  } else if (changed) {
    document.lastModifiedById = user.id;
    document.updatedBy = user;
    await document.saveWithCtx(ctx, undefined, { data: eventData });
  } else if (done) {
    await Event.schedule({
      ...event,
      actorId: user.id,
      teamId: document.teamId,
    });
  }

  return await Document.findByPk(document.id, {
    userId: user.id,
    rejectOnEmpty: true,
    transaction,
  });
}
