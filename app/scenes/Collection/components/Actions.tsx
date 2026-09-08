import { observer } from "mobx-react";
import { EditIcon, PlusIcon } from "outline-icons";
import { useTranslation } from "react-i18next";
import type Collection from "~/models/Collection";
import { Action } from "~/components/Actions";
import Button from "~/components/Button";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import Tooltip from "~/components/Tooltip";
import usePolicy from "~/hooks/usePolicy";
import CollectionMenu from "~/menus/CollectionMenu";
import { createInternalLinkAction } from "~/actions";
import { ActiveDocumentSection } from "~/actions/sections";
import { useMenuAction } from "~/hooks/useMenuAction";
import {
  collectionEditPath,
  collectionPath,
  newDocumentPath,
} from "~/utils/routeHelpers";
import useCurrentUser from "~/hooks/useCurrentUser";
import type { SidebarContextType } from "~/components/Sidebar/components/SidebarContext";
import { CollectionTab } from "./Navigation";
import lazyWithRetry from "~/utils/lazyWithRetry";
import history from "~/utils/history";
import RegisterKeyDown from "~/components/RegisterKeyDown";
import { useCallback, useMemo } from "react";

const ShareButton = lazyWithRetry(() => import("./ShareButton"));

type Props = {
  /** The collection for which to render actions */
  collection: Collection;
  /** Whether the collection is in editing mode */
  isEditing: boolean;
  /** Contextual information for the sidebar */
  sidebarContext: SidebarContextType;
};

function Actions({ collection, isEditing, sidebarContext }: Props) {
  const { t } = useTranslation();
  const can = usePolicy(collection);
  const user = useCurrentUser();

  const goToEdit = useCallback(() => {
    history.push({
      pathname: collectionEditPath(collection),
      state: { sidebarContext },
    });
  }, [collection, sidebarContext]);

  const goBack = useCallback(() => {
    history.push({
      pathname: collectionPath(collection, CollectionTab.Overview),
      state: { sidebarContext },
    });
  }, [collection, sidebarContext]);

  const newDocumentActions = useMemo(
    () => [
      createInternalLinkAction({
        name: "文档",
        section: ActiveDocumentSection,
        visible: can.createDocument,
        to: newDocumentPath(collection.id),
      }),
      createInternalLinkAction({
        name: "表格",
        section: ActiveDocumentSection,
        visible: can.createDocument,
        to: newDocumentPath(collection.id, { type: "table" }),
      }),
    ],
    [can.createDocument, collection.id]
  );
  const newDocumentAction = useMenuAction(newDocumentActions);

  return (
    <>
      {(!isEditing || !user?.separateEditMode) && (
        <Action>
          <ShareButton collection={collection} />
        </Action>
      )}
      {!isEditing && user?.separateEditMode && (
        <Action>
          <RegisterKeyDown trigger="e" handler={goToEdit} />
          <Tooltip
            content={t("Edit collection")}
            shortcut="e"
            placement="bottom"
          >
            <Button icon={<EditIcon />} onClick={goToEdit} neutral>
              {t("Edit")}
            </Button>
          </Tooltip>
        </Action>
      )}
      {isEditing && user?.separateEditMode && (
        <Action>
          <RegisterKeyDown trigger="Escape" handler={goBack} />
          <Button onClick={goBack}>{t("Done editing")}</Button>
        </Action>
      )}
      {can.createDocument && (
        <Action>
          <Tooltip content="新建" shortcut="n" placement="bottom">
            <DropdownMenu
              action={newDocumentAction}
              align="end"
              ariaLabel="新建"
            >
              <Button icon={<PlusIcon />} neutral={isEditing}>
                新建
              </Button>
            </DropdownMenu>
          </Tooltip>
        </Action>
      )}
      <Action>
        <CollectionMenu collection={collection} align="end" neutral />
      </Action>
    </>
  );
}

export default observer(Actions);
