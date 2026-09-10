import { useState } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "react-i18next";
import { DocumentValidation } from "@shared/validations";
import type Document from "~/models/Document";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import Input from "~/components/Input";
import usePolicy from "~/hooks/usePolicy";
import { tableSaves } from "~/stores/TableSaveCoordinator";

/** Rename fallback for table context menus without an inline title editor. */
export const TableDocumentRenameDialog = observer(
  function TableDocumentRenameDialog({ document }: { document: Document }) {
    const { t } = useTranslation();
    const can = usePolicy(document);
    const [title, setTitle] = useState(document.title);
    return (
      <ConfirmationDialog
        submitText={t("Rename")}
        disabled={!can.update}
        onSubmit={async () => {
          if (!can.update) {
            return false;
          }
          await tableSaves.flush();
          await document.store.update({ id: document.id, title: title.trim() });
          return true;
        }}
      >
        <Input
          label={t("Title")}
          value={title}
          maxLength={DocumentValidation.maxTitleLength}
          onChange={(event) => setTitle(event.target.value)}
          disabled={!can.update}
          autoFocus
        />
      </ConfirmationDialog>
    );
  }
);
