import { observer } from "mobx-react";
import { DocumentIcon, PlusIcon, TableIcon } from "outline-icons";
import { useMemo } from "react";
import { useTranslation, Trans } from "react-i18next";
import type Document from "~/models/Document";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import usePolicy from "~/hooks/usePolicy";
import useStores from "~/hooks/useStores";
import { useLocationSidebarContext } from "~/hooks/useLocationSidebarContext";
import { newDocumentPath, newNestedDocumentPath } from "~/utils/routeHelpers";
import { ActionSeparator, createInternalLinkAction } from "~/actions";
import { ActiveDocumentSection } from "~/actions/sections";
import { useMenuAction } from "~/hooks/useMenuAction";
import Tooltip from "~/components/Tooltip";
import Button from "~/components/Button";

interface Props {
  document: Document;
}

/** Offers document and table creation in the current collection or document. */
function NewChildDocumentMenu({ document }: Props) {
  const { t } = useTranslation();
  const canCollection = usePolicy(document.collectionId);
  const canDocument = usePolicy(document);
  const sidebarContext = useLocationSidebarContext();
  const { collections } = useStores();

  const collection = document.collectionId
    ? collections.get(document.collectionId)
    : undefined;
  const collectionName = collection ? collection.name : t("collection");

  const actions = useMemo(() => {
    const location = (path: string) => {
      const [pathname, search] = path.split("?");
      return { pathname, search, state: { sidebarContext } };
    };
    return [
      createInternalLinkAction({
        name: (
          <Trans
            defaults="New document in <em>{{ collectionName }}</em>"
            values={{
              collectionName,
            }}
            components={{
              em: <strong />,
            }}
          />
        ),
        icon: <DocumentIcon />,
        section: ActiveDocumentSection,
        visible: !!canCollection.createDocument,
        to: location(newDocumentPath(document.collectionId)),
      }),
      createInternalLinkAction({
        name: t("New table in {{name}}", { name: collectionName }),
        icon: <TableIcon />,
        section: ActiveDocumentSection,
        visible: !!canCollection.createDocument,
        to: location(newDocumentPath(document.collectionId, { type: "table" })),
      }),
      ActionSeparator,
      createInternalLinkAction({
        name: (
          <Trans
            defaults="New document in <em>{{ collectionName }}</em>"
            values={{
              collectionName: document.titleWithDefault,
            }}
            components={{
              em: <strong />,
            }}
          />
        ),
        icon: <DocumentIcon />,
        section: ActiveDocumentSection,
        visible: !!canDocument.createChildDocument,
        to: location(newNestedDocumentPath(document.id)),
      }),
      createInternalLinkAction({
        name: t("New table in {{name}}", { name: document.titleWithDefault }),
        icon: <TableIcon />,
        section: ActiveDocumentSection,
        visible: !!canDocument.createChildDocument,
        to: location(newNestedDocumentPath(document.id, "table")),
      }),
    ];
  }, [
    t,
    collectionName,
    canCollection.createDocument,
    canDocument.createChildDocument,
    sidebarContext,
    document.id,
    document.titleWithDefault,
    document.collectionId,
  ]);

  const rootAction = useMenuAction(actions);

  return (
    <Tooltip content={t("Create")} placement="bottom">
      <DropdownMenu action={rootAction} align="end" ariaLabel={t("Create")}>
        <Button icon={<PlusIcon />} disclosure neutral>
          {t("Create")}
        </Button>
      </DropdownMenu>
    </Tooltip>
  );
}

export default observer(NewChildDocumentMenu);
