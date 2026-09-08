import { observer } from "mobx-react";
import * as React from "react";
import type Document from "~/models/Document";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import usePolicy from "~/hooks/usePolicy";
import { newDocumentPath } from "~/utils/routeHelpers";
import { createInternalLinkAction } from "~/actions";
import { ActiveDocumentSection } from "~/actions/sections";
import { useMenuAction } from "~/hooks/useMenuAction";
import Tooltip from "~/components/Tooltip";
import Button from "~/components/Button";
import { PlusIcon } from "outline-icons";

type Props = {
  document: Document;
};

function NewChildDocumentMenu({ document }: Props) {
  const canCollection = usePolicy(document.collectionId);

  const actions = React.useMemo(
    () => [
      createInternalLinkAction({
        name: "文档",
        section: ActiveDocumentSection,
        visible: !!canCollection.createDocument,
        to: newDocumentPath(document.collectionId),
      }),
      createInternalLinkAction({
        name: "表格",
        section: ActiveDocumentSection,
        visible: !!canCollection.createDocument,
        to: newDocumentPath(document.collectionId, { type: "table" }),
      }),
    ],
    [
      canCollection.createDocument,
      document.collectionId,
    ]
  );

  const rootAction = useMenuAction(actions);

  return (
    <Tooltip content="新建" shortcut="n" placement="bottom">
      <DropdownMenu
        action={rootAction}
        align="end"
        ariaLabel="新建"
      >
        <Button icon={<PlusIcon />} neutral>
          新建
        </Button>
      </DropdownMenu>
    </Tooltip>
  );
}

export default observer(NewChildDocumentMenu);
