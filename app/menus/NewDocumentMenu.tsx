import { observer } from "mobx-react";
import { PlusIcon } from "outline-icons";
import { useTranslation } from "react-i18next";
import Button from "~/components/Button";
import type { SidebarContextType } from "~/components/Sidebar/components/SidebarContext";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import usePolicy from "~/hooks/usePolicy";
import { DocumentTypeMenu } from "~/menus/DocumentTypeMenu";
import { newDocumentPath } from "~/utils/routeHelpers";

interface Props {
  collectionId?: string;
  sidebarContext?: SidebarContextType;
  neutral?: boolean;
}

/** Offers document and table creation in a collection or the user's drafts. */
function NewDocumentMenu({ collectionId, sidebarContext, neutral }: Props) {
  const { t } = useTranslation();
  const team = useCurrentTeam();
  const can = usePolicy(collectionId ?? team);

  if (!can.createDocument) {
    return null;
  }

  return (
    <DocumentTypeMenu
      documentPath={{
        pathname: newDocumentPath(collectionId),
        state: { sidebarContext },
      }}
      tablePath={{
        pathname: newDocumentPath(collectionId),
        search: "?type=table",
        state: { sidebarContext },
      }}
      align="end"
    >
      <Button icon={<PlusIcon />} disclosure neutral={neutral}>
        {t("Create")}
      </Button>
    </DocumentTypeMenu>
  );
}

export default observer(NewDocumentMenu);
