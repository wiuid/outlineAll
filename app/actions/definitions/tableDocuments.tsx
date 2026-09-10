import { InputIcon } from "outline-icons";
import { ActionSeparator, createAction, createRootMenuAction } from "~/actions";
import { ActiveDocumentSection } from "~/actions/sections";
import { TableDocumentRenameDialog } from "~/components/TableDocumentRenameDialog";
import type { ActionWithChildren } from "~/types";
import {
  restoreDocument,
  restoreDocumentToCollection,
  starDocument,
  unstarDocument,
  subscribeDocument,
  unsubscribeDocument,
  editDocument,
  shareDocument,
  publishDocument,
  unpublishDocument,
  archiveDocument,
  moveDocument,
  importDocument,
  createNewDocument,
  createNewTable,
  createNewDocumentInAlphabeticalCollection,
  pinDocument,
  openDocumentComments,
  openDocumentInsights,
  copyDocumentLink,
  copyDocumentShareLink,
  deleteDocument,
  permanentlyDeleteDocument,
  leaveDocument,
} from "./documents";

/**
 * Builds the shared table management allowlist without spreadsheet-content actions.
 *
 * @param documentId the table document's identifier.
 * @param onRename optional inline title editor callback.
 * @returns the action tree used by table dropdowns and context menus.
 */
export function createTableDocumentMenuAction(
  documentId: string,
  onRename?: () => void
): ActionWithChildren {
  const rename = createAction({
    name: ({ t }) => `${t("Rename")}…`,
    analyticsName: "Rename table document",
    section: ActiveDocumentSection,
    icon: <InputIcon />,
    visible: ({ stores }) =>
      Boolean(stores.policies.abilities(documentId).update),
    perform: ({ stores, t }) => {
      if (!stores.policies.abilities(documentId).update) {
        return;
      }
      if (onRename) {
        requestAnimationFrame(onRename);
        return;
      }
      const document = stores.documents.get(documentId);
      if (document) {
        stores.dialogs.openModal({
          title: t("Rename"),
          content: <TableDocumentRenameDialog document={document} />,
        });
      }
    },
  });
  return createRootMenuAction([
    restoreDocument,
    restoreDocumentToCollection,
    starDocument,
    unstarDocument,
    subscribeDocument,
    unsubscribeDocument,
    ActionSeparator,
    editDocument,
    rename,
    shareDocument,
    publishDocument,
    unpublishDocument,
    archiveDocument,
    moveDocument,
    importDocument,
    createNewDocument,
    createNewTable,
    createNewDocumentInAlphabeticalCollection,
    pinDocument,
    ActionSeparator,
    openDocumentComments,
    openDocumentInsights,
    copyDocumentLink,
    copyDocumentShareLink,
    ActionSeparator,
    deleteDocument,
    permanentlyDeleteDocument,
    leaveDocument,
  ]);
}
