import { observer } from "mobx-react";
import { PlusIcon } from "outline-icons";
import { useMemo } from "react";
import Button from "~/components/Button";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import Tooltip from "~/components/Tooltip";
import { createInternalLinkAction } from "~/actions";
import { ActiveDocumentSection } from "~/actions/sections";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import { useMenuAction } from "~/hooks/useMenuAction";
import usePolicy from "~/hooks/usePolicy";
import { preloadEditor } from "~/routes/scenes";
import { newDocumentPath } from "~/utils/routeHelpers";

function NewDocumentMenu() {
  const team = useCurrentTeam();
  const can = usePolicy(team);

  const actions = useMemo(
    () => [
      createInternalLinkAction({
        name: "文档",
        section: ActiveDocumentSection,
        visible: !!can.createDocument,
        to: newDocumentPath(),
      }),
      createInternalLinkAction({
        name: "表格",
        section: ActiveDocumentSection,
        visible: !!can.createDocument,
        to: newDocumentPath(undefined, { type: "table" }),
      }),
    ],
    [can.createDocument]
  );
  const rootAction = useMenuAction(actions);

  if (!can.createDocument) {
    return null;
  }

  return (
    <Tooltip content="新建" shortcut="n" placement="bottom">
      <DropdownMenu
        action={rootAction}
        align="end"
        ariaLabel="新建"
      >
        <Button
          icon={<PlusIcon />}
          onPointerEnter={preloadEditor}
          onFocus={preloadEditor}
        >
          新建
        </Button>
      </DropdownMenu>
    </Tooltip>
  );
}

export default observer(NewDocumentMenu);
