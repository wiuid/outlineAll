import type { LocationDescriptor } from "history";
import { DocumentIcon, TableIcon } from "outline-icons";
import { useMemo } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { createAction, createInternalLinkAction } from "~/actions";
import { DocumentSection } from "~/actions/sections";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import Tooltip from "~/components/Tooltip";
import { useMenuAction } from "~/hooks/useMenuAction";
import type { DocumentCreationType } from "~/types";

interface MenuProps {
  children: ReactElement;
  align?: "start" | "end";
  onOpen?: () => void;
  onClose?: () => void;
  tooltip?: string;
}

type Props = MenuProps &
  (
    | { onSelect: (type: DocumentCreationType) => void }
    | { documentPath: LocationDescriptor; tablePath: LocationDescriptor }
  );

/**
 * Offers the same document and spreadsheet choices at every creation entry.
 *
 * @param props the trigger and destinations or inline creation handler.
 * @returns an accessible dropdown, or a drawer on mobile.
 */
export function DocumentTypeMenu(props: Props) {
  const { t } = useTranslation();
  const actions = useMemo(() => {
    const types: DocumentCreationType[] = ["document", "table"];
    return types.map((type) => {
      const definition = {
        name: type === "table" ? t("Table") : t("Document"),
        icon: type === "table" ? <TableIcon /> : <DocumentIcon />,
        section: DocumentSection,
      };
      if ("onSelect" in props) {
        return createAction({
          ...definition,
          perform: () => props.onSelect(type),
        });
      }
      return createInternalLinkAction({
        ...definition,
        to: type === "table" ? props.tablePath : props.documentPath,
      });
    });
  }, [props, t]);
  const action = useMenuAction(actions);

  return (
    <Tooltip content={props.tooltip}>
      <DropdownMenu
        action={action}
        ariaLabel={t("Create")}
        align={props.align}
        onOpen={props.onOpen}
        onClose={props.onClose}
      >
        {props.children}
      </DropdownMenu>
    </Tooltip>
  );
}
