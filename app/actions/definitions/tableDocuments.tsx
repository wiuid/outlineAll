import { CloudIcon } from "outline-icons";
import {
  ActionSeparator,
  createAction,
  createActionWithChildren,
  createInternalLinkAction,
  createRootMenuAction,
} from "~/actions";
import { ActiveDocumentSection } from "~/actions/sections";
import type { ActionWithChildren, DocumentCreationType } from "~/types";
import { newDocumentPath } from "~/utils/routeHelpers";
import { renameActionFactory } from "./common";
import {
  archiveDocument,
  copyDocumentLink,
  copyDocumentShareLink,
  createNewDocument,
  createNewTable,
  deleteDocument,
  duplicateDocument,
  editDocument,
  leaveDocument,
  moveDocument,
  openDocumentComments,
  openDocumentInDesktop,
  openDocumentInsights,
  openDocumentInSplit,
  permanentlyDeleteDocument,
  publishDocument,
  restoreDocument,
  restoreDocumentToCollection,
  shareDocument,
  starDocument,
  subscribeDocument,
  togglePinDocumentToCollection,
  togglePinDocumentToHome,
  unpublishDocument,
  unstarDocument,
  unsubscribeDocument,
} from "./documents";

interface Options {
  documentId: string;
  editable: boolean;
  saveDisabled: boolean;
  onSave: () => Promise<void>;
  onRename?: () => void;
}

/**
 * Builds table actions using Outline's existing permissions and destinations.
 * Document body tools are omitted until they support native workbooks.
 *
 * @param options the active table's editing state and save/rename handlers.
 * @returns the table's overflow menu action.
 */
export function createTableDocumentMenuAction({
  documentId,
  editable,
  saveDisabled,
  onSave,
  onRename,
}: Options): ActionWithChildren {
  return createRootMenuAction([
    createAction({
      name: ({ t }) => t("Save"),
      section: ActiveDocumentSection,
      icon: <CloudIcon />,
      shortcut: ["Meta+S"],
      visible: editable,
      disabled: saveDisabled,
      perform: onSave,
    }),
    editDocument,
    ActionSeparator,
    createDocumentMenu("document"),
    createDocumentMenu("table"),
    ActionSeparator,
    { ...shareDocument, name: ({ t }) => `${t("Share")}…` },
    copyDocumentLink,
    copyDocumentShareLink,
    renameActionFactory({
      section: ActiveDocumentSection,
      modelId: documentId,
      onRename,
    }),
    duplicateDocument,
    moveDocument,
    starDocument,
    unstarDocument,
    ActionSeparator,
    createActionWithChildren({
      name: ({ t }) => t("More"),
      section: ActiveDocumentSection,
      children: [
        togglePinDocumentToCollection,
        togglePinDocumentToHome,
        ActionSeparator,
        subscribeDocument,
        unsubscribeDocument,
        openDocumentComments,
        openDocumentInsights,
        openDocumentInDesktop,
        openDocumentInSplit,
      ],
    }),
    publishDocument,
    unpublishDocument,
    archiveDocument,
    restoreDocument,
    restoreDocumentToCollection,
    ActionSeparator,
    deleteDocument,
    permanentlyDeleteDocument,
    leaveDocument,
  ]);
}

/** Keeps collection, sibling and nested creation in a single-level submenu. */
function createDocumentMenu(type: DocumentCreationType): ActionWithChildren {
  const action = type === "table" ? createNewTable : createNewDocument;
  const inCollection = createInternalLinkAction({
    name: ({ t, activeDocumentId, stores }) => {
      const document = activeDocumentId
        ? stores.documents.get(activeDocumentId)
        : undefined;
      return t("In {{ collectionName }}", {
        collectionName: document?.collection?.name ?? t("collection"),
      });
    },
    section: ActiveDocumentSection,
    visible: ({ activeDocumentId, stores }) => {
      const document = activeDocumentId
        ? stores.documents.get(activeDocumentId)
        : undefined;
      return (
        !!document?.collectionId &&
        !!stores.policies.abilities(document.collectionId).createDocument
      );
    },
    to: ({ activeDocumentId, stores, sidebarContext }) => {
      const document = activeDocumentId
        ? stores.documents.get(activeDocumentId)
        : undefined;
      if (!document?.collectionId) {
        return "";
      }
      const [pathname, search] = newDocumentPath(document.collectionId, {
        type: type === "table" ? "table" : undefined,
      }).split("?");
      return { pathname, search, state: { sidebarContext } };
    },
  });

  return createActionWithChildren({
    ...action,
    visible: ({ currentTeamId, activeDocumentId, stores }) =>
      !!currentTeamId &&
      !!activeDocumentId &&
      !!stores.policies.abilities(currentTeamId).createDocument &&
      !stores.documents.get(activeDocumentId)?.isDeleted,
    children: (context) => [
      inCollection,
      ActionSeparator,
      ...(typeof action.children === "function"
        ? action.children(context)
        : action.children),
    ],
  });
}
