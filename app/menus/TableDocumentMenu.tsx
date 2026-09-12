import { observer } from "mobx-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { createTableDocumentMenuAction } from "~/actions/definitions/tableDocuments";
import type Document from "~/models/Document";
import DocumentMenu from "./DocumentMenu";

interface Props {
  document: Document;
  editable: boolean;
  saveDisabled: boolean;
  status: string;
  onSave: () => Promise<void>;
  onRename?: () => void;
}

/**
 * Shows table saving, creation, sharing and document management in one menu.
 *
 * @param props the table's current save state and document actions.
 * @returns the table options dropdown or mobile drawer.
 */
export const TableDocumentMenu = observer(function TableDocumentMenu({
  document,
  editable,
  saveDisabled,
  status,
  onSave,
  onRename,
}: Props) {
  const { t } = useTranslation();
  const action = useCallback(
    () =>
      createTableDocumentMenuAction({
        documentId: document.id,
        editable,
        saveDisabled,
        onSave,
        onRename,
      }),
    [document.id, editable, saveDisabled, onSave, onRename]
  );

  return (
    <DocumentMenu
      document={document}
      action={action}
      prepend={<SaveStatus>{status}</SaveStatus>}
      ariaLabel={t("Table options")}
      align="end"
      neutral
    />
  );
});

const SaveStatus = styled.div`
  padding: 8px 12px;
  color: ${({ theme }) => theme.textSecondary};
  font-size: 12px;
  border-bottom: 1px solid ${({ theme }) => theme.divider};
`;
