import * as Popover from "@radix-ui/react-popover";
import {
  ICommandService,
  IPermissionService,
  LocaleService,
  ThemeService,
  nameCharacterCheck,
  type Workbook,
} from "@univerjs/core";
import {
  COLOR_PICKER_COMPONENT,
  ContextMenuPanel,
  ContextMenuPosition,
  CustomLabel,
  InsertSheetCommand,
  InsertSheetMutation,
  RemoveSheetMutation,
  RenameSheetOperation,
  SetTabColorCommand,
  SetTabColorMutation,
  SetWorksheetActivateCommand,
  SetWorksheetActiveOperation,
  SetWorksheetHideMutation,
  SetWorksheetNameCommand,
  SetWorksheetNameMutation,
  SetWorksheetOrderCommand,
  SetWorksheetOrderMutation,
  SetWorksheetShowCommand,
  ShowMenuListCommand,
  WorkbookCreateSheetPermission,
  WorkbookEditablePermission,
  WorkbookHideSheetPermission,
  WorkbookMoveSheetPermission,
  WorkbookRenameSheetPermission,
  useActiveWorkbook,
  useDependency,
  useObservable,
  type IValueOption,
} from "@univerjs/preset-sheets-core";
import { MenuIcon, MoreIcon, PlusIcon } from "outline-icons";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styled, { createGlobalStyle, css } from "styled-components";
import { bindTableSheetGestures } from "~/utils/tableSheetGestures";

interface Props {
  host: HTMLElement;
  beforeAction: () => Promise<void>;
  onError: (error: unknown) => void;
}

/**
 * Adds touch management beside Univer's native, horizontally scrolling tabs.
 *
 * @param props the workbook host and its guarded cell commit lifecycle.
 * @returns worksheet controls and menus backed by native commands.
 */
export function TableSheetControls(props: Props) {
  const workbook = useActiveWorkbook();
  if (!workbook) {
    return null;
  }
  return <SheetControlsContent {...props} workbook={workbook} />;
}

interface ContentProps extends Props {
  workbook: Workbook;
}

function SheetControlsContent({
  host,
  beforeAction,
  onError,
  workbook,
}: ContentProps) {
  const { t } = useTranslation();
  const commands = useDependency<ICommandService>(ICommandService);
  const permissions = useDependency<IPermissionService>(IPermissionService);
  const locale = useDependency<LocaleService>(LocaleService);
  const dark = useObservable(
    useDependency<ThemeService>(ThemeService).darkMode$,
    false
  );
  const unitId = workbook.getUnitId();
  const editable = useObservable(
    permissions.getPermissionPoint$(new WorkbookEditablePermission(unitId).id)
  )?.value;
  const canCreate = useObservable(
    permissions.getPermissionPoint$(
      new WorkbookCreateSheetPermission(unitId).id
    )
  )?.value;
  const canHide = useObservable(
    permissions.getPermissionPoint$(new WorkbookHideSheetPermission(unitId).id)
  )?.value;
  const canMove = useObservable(
    permissions.getPermissionPoint$(new WorkbookMoveSheetPermission(unitId).id)
  )?.value;
  const canRename = useObservable(
    permissions.getPermissionPoint$(
      new WorkbookRenameSheetPermission(unitId).id
    )
  )?.value;
  const [version, setVersion] = useState(0);
  const [panel, setPanel] = useState<"list" | "manage" | "rename" | "color">();
  const [sheetId, setSheetId] = useState("");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const running = useRef(false);
  const anchor = useRef<HTMLElement | null>(null);
  const listButton = useRef<HTMLButtonElement>(null);
  const panelElement = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const nameId = useId();

  useEffect(() => {
    alive.current = true;
    const changes = new Set([
      InsertSheetMutation.id,
      RemoveSheetMutation.id,
      SetWorksheetNameMutation.id,
      SetWorksheetOrderMutation.id,
      SetWorksheetHideMutation.id,
      SetWorksheetActiveOperation.id,
      SetTabColorMutation.id,
    ]);
    const subscription = commands.onCommandExecuted((command) => {
      if (changes.has(command.id)) {
        setVersion((value) => value + 1);
      }
    });
    return () => {
      alive.current = false;
      subscription.dispose();
    };
  }, [commands]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      if (running.current) {
        return;
      }
      running.current = true;
      setBusy(true);
      try {
        await beforeAction();
        if (alive.current) {
          await action();
        }
      } catch (error) {
        onError(error);
      } finally {
        running.current = false;
        if (alive.current) {
          setBusy(false);
        }
      }
    },
    [beforeAction, onError]
  );

  const handleManage = useCallback(
    (targetId: string, tab: HTMLElement) => {
      void run(async () => {
        const target = workbook.getSheetBySheetId(targetId);
        if (!target || target.isSheetHidden()) {
          return;
        }
        // Native footer permissions and contextual commands follow the active
        // sheet. Activate the target just as Univer's desktop context menu does.
        const activated = await commands.executeCommand(
          SetWorksheetActivateCommand.id,
          { unitId, subUnitId: targetId }
        );
        if (!activated || !alive.current) {
          return;
        }
        anchor.current = tab.isConnected ? tab : listButton.current;
        setSheetId(targetId);
        setPanel("manage");
      });
    },
    [commands, run, unitId, workbook]
  );

  useEffect(
    () => bindTableSheetGestures(host, handleManage),
    [host, handleManage]
  );

  const sheets = workbook.getSheets();
  const target = workbook.getSheetBySheetId(sheetId);
  const visible = sheets.filter((sheet) => !sheet.isSheetHidden());
  const visibleIndex = visible.findIndex(
    (sheet) => sheet.getSheetId() === sheetId
  );
  const activeColor = workbook.getActiveSheet().getTabColor() ?? "";

  useEffect(() => {
    // Native mobile tabs omit color mutations from their refresh subscription,
    // and their dark theme overrides the inline color. Keep their indicator in
    // sync without reactivating the sheet or rebuilding the native tab bar.
    const property = "--table-sheet-active-color";
    const original = host.style.getPropertyValue(property);
    host.style.setProperty(property, activeColor);
    return () => {
      host.style.setProperty(property, original);
    };
  }, [activeColor, host]);

  useEffect(() => {
    if (panel && panel !== "list" && (!target || target.isSheetHidden())) {
      setPanel(undefined);
    }
  }, [panel, target, version]);

  const handleList = () => {
    void run(async () => {
      anchor.current = listButton.current;
      setPanel("list");
    });
  };

  const handleAdd = () => {
    if (!editable || !canCreate) {
      return;
    }
    void run(async () => {
      await commands.executeCommand(InsertSheetCommand.id, { unitId });
    });
  };

  const handleSelect = (targetId: string, hidden: boolean) => {
    if (hidden && (!editable || !canHide)) {
      return;
    }
    void run(async () => {
      if (hidden) {
        const shown = await commands.executeCommand(
          SetWorksheetShowCommand.id,
          {
            unitId,
            subUnitId: targetId,
          }
        );
        if (!shown) {
          return;
        }
      }
      await commands.executeCommand(SetWorksheetActivateCommand.id, {
        unitId,
        subUnitId: targetId,
      });
      if (alive.current) {
        setPanel(undefined);
      }
    });
  };

  const handleCommand = (option: IValueOption) => {
    const commandId = option.commandId ?? option.id;
    if (!commandId || !target) {
      return;
    }
    if (commandId === RenameSheetOperation.id) {
      setName(target.getName());
      setNameError(undefined);
      setPanel("rename");
      return;
    }
    if (commandId === ShowMenuListCommand.id) {
      setPanel("list");
      return;
    }
    if (commandId === SetTabColorCommand.id) {
      if (editable) {
        setPanel("color");
      }
      return;
    }
    setPanel(undefined);
    void run(async () => {
      await commands.executeCommand(commandId, {
        unitId,
        subUnitId: sheetId,
        value: option.value,
      });
    });
  };

  const handleColor = (value: string | number) => {
    if (!editable || !target || typeof value !== "string") {
      return;
    }
    void run(async () => {
      await commands.executeCommand(SetTabColorCommand.id, {
        unitId,
        subUnitId: sheetId,
        value,
      });
      if (alive.current) {
        setPanel(undefined);
      }
    });
  };

  const handleMove = (direction: -1 | 1) => {
    const neighbor = visible[visibleIndex + direction];
    if (!editable || !canMove || !target || !neighbor) {
      return;
    }
    void run(async () => {
      await commands.executeCommand(SetWorksheetOrderCommand.id, {
        unitId,
        subUnitId: sheetId,
        order: sheets.indexOf(neighbor),
      });
      if (alive.current) {
        setPanel(undefined);
      }
    });
  };

  const handleRename = () => {
    if (!target || !editable || !canRename) {
      return;
    }
    // Reuse the checks applied by Univer's desktop inline rename editor.
    const error = !name.trim()
      ? "sheets-ui.sheetConfig.sheetNameCannotIsEmptyError"
      : !nameCharacterCheck(name)
        ? "sheets-ui.sheetConfig.sheetNameSpecCharError"
        : name !== target.getName() && workbook.checkSheetName(name)
          ? "sheets-ui.sheetConfig.sheetNameAlreadyExistsError"
          : undefined;
    if (error) {
      setNameError(locale.t(error));
      return;
    }
    void run(async () => {
      const renamed =
        name === target.getName() ||
        (await commands.executeCommand(SetWorksheetNameCommand.id, {
          unitId,
          subUnitId: sheetId,
          name,
        }));
      if (renamed && alive.current) {
        setPanel(undefined);
      }
    });
  };

  return (
    <Controls data-table-sheet-controls>
      <ControlButton
        ref={listButton}
        type="button"
        aria-label={t("Worksheets")}
        title={t("Worksheets")}
        aria-haspopup="dialog"
        aria-expanded={!!panel}
        onClick={handleList}
        disabled={busy}
      >
        <MenuIcon />
      </ControlButton>
      <ControlButton
        type="button"
        aria-label={t("Add worksheet")}
        title={t("Add worksheet")}
        onClick={handleAdd}
        disabled={busy || !editable || !canCreate}
      >
        <PlusIcon />
      </ControlButton>
      <Popover.Root
        open={!!panel}
        onOpenChange={(open) => {
          if (!open) {
            setPanel(undefined);
          }
        }}
      >
        <Popover.Anchor virtualRef={anchor} />
        <Popover.Portal>
          <Panel
            ref={panelElement}
            data-table-sheet-panel={panel}
            className={dark ? "univer-dark" : undefined}
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            aria-labelledby={titleId}
            onKeyDown={(event) => event.stopPropagation()}
            onInteractOutside={(event) => {
              // Univer's native color picker and submenus use their own portal.
              if (
                event.target instanceof Element &&
                event.target.closest("[data-u-context-menu-submenu]")
              ) {
                event.preventDefault();
              }
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const active = host.ownerDocument.activeElement;
              if (
                active === host.ownerDocument.body ||
                (active && panelElement.current?.contains(active))
              ) {
                const returnTo = anchor.current?.isConnected
                  ? anchor.current
                  : listButton.current;
                returnTo?.focus({ preventScroll: true });
              }
            }}
          >
            <PanelTitle id={titleId}>
              {panel === "list" ? t("Worksheets") : target?.getName()}
            </PanelTitle>
            {panel === "list" && (
              <SheetList>
                {sheets.map((sheet) => {
                  const id = sheet.getSheetId();
                  const hidden = !!sheet.isSheetHidden();
                  const selected = workbook.getActiveSheet() === sheet;
                  return (
                    <SheetRow key={id}>
                      <SheetButton
                        type="button"
                        aria-current={selected ? "true" : undefined}
                        disabled={busy || (hidden && (!editable || !canHide))}
                        onClick={() => handleSelect(id, hidden)}
                      >
                        <span>{sheet.getName()}</span>
                        {hidden && (
                          <small>
                            {locale.t("sheets-ui.sheetConfig.unhide")}
                          </small>
                        )}
                      </SheetButton>
                      {!hidden && (
                        <ControlButton
                          type="button"
                          aria-label={t("Manage {{name}}", {
                            name: sheet.getName(),
                          })}
                          title={t("Manage worksheet")}
                          disabled={busy}
                          onClick={() => {
                            if (listButton.current) {
                              handleManage(id, listButton.current);
                            }
                          }}
                        >
                          <MoreIcon />
                        </ControlButton>
                      )}
                    </SheetRow>
                  );
                })}
              </SheetList>
            )}
            {panel === "manage" && !!target && (
              <>
                <NativeMenu
                  menuType={ContextMenuPosition.FOOTER_TABS}
                  menuSessionVersion={version}
                  onOptionSelect={handleCommand}
                />
                <OrderControls>
                  <ActionButton
                    type="button"
                    disabled={
                      busy || !editable || !canMove || visibleIndex <= 0
                    }
                    onClick={() => handleMove(-1)}
                  >
                    {locale.t("sheets-ui.sheetConfig.moveLeft")}
                  </ActionButton>
                  <ActionButton
                    type="button"
                    disabled={
                      busy ||
                      !editable ||
                      !canMove ||
                      visibleIndex >= visible.length - 1
                    }
                    onClick={() => handleMove(1)}
                  >
                    {locale.t("sheets-ui.sheetConfig.moveRight")}
                  </ActionButton>
                </OrderControls>
              </>
            )}
            {panel === "rename" && (
              <RenameForm
                onSubmit={(event) => {
                  event.preventDefault();
                  handleRename();
                }}
              >
                <label htmlFor={nameId}>
                  {locale.t("sheets-ui.sheetConfig.rename")}
                </label>
                <NameInput
                  id={nameId}
                  value={name}
                  autoFocus
                  autoComplete="off"
                  enterKeyHint="done"
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? `${nameId}-error` : undefined}
                  disabled={busy || !editable || !canRename}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameError(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                    }
                  }}
                />
                {nameError && (
                  <NameError id={`${nameId}-error`} role="alert">
                    {nameError}
                  </NameError>
                )}
                <OrderControls>
                  <ActionButton
                    type="button"
                    onClick={() => setPanel("manage")}
                  >
                    {t("Cancel")}
                  </ActionButton>
                  <ActionButton
                    type="submit"
                    disabled={busy || !editable || !canRename}
                  >
                    {t("Save")}
                  </ActionButton>
                </OrderControls>
              </RenameForm>
            )}
            {panel === "color" && (
              <ColorContent>
                <ColorPickerViewport host={host} dark={dark} />
                <CustomLabel
                  label={{ name: COLOR_PICKER_COMPONENT }}
                  value={target?.getTabColor() ?? ""}
                  onChange={handleColor}
                />
                <ActionButton type="button" onClick={() => setPanel("manage")}>
                  {t("Back")}
                </ActionButton>
              </ColorContent>
            )}
          </Panel>
        </Popover.Portal>
      </Popover.Root>
    </Controls>
  );
}

interface PickerViewport {
  height: number;
  width: number;
  top: number;
  left: number;
}

interface ColorPickerViewportProps {
  host: HTMLElement;
  dark: boolean;
}

function ColorPickerViewport({ host, dark }: ColorPickerViewportProps) {
  const [viewport, setViewport] = useState<PickerViewport>();

  useEffect(() => {
    const view = host.ownerDocument.defaultView;
    if (!view) {
      return;
    }
    const visual = view.visualViewport;
    const handleResize = () => {
      setViewport({
        height: visual?.height ?? view.innerHeight,
        width: visual?.width ?? view.innerWidth,
        top: visual?.offsetTop ?? 0,
        left: visual?.offsetLeft ?? 0,
      });
    };
    handleResize();
    view.addEventListener("resize", handleResize);
    visual?.addEventListener("resize", handleResize);
    visual?.addEventListener("scroll", handleResize);
    return () => {
      view.removeEventListener("resize", handleResize);
      visual?.removeEventListener("resize", handleResize);
      visual?.removeEventListener("scroll", handleResize);
    };
  }, [host]);

  return viewport ? (
    <ColorDialogStyles $viewport={viewport} $dark={dark} />
  ) : null;
}

const ColorDialogStyles = createGlobalStyle<{
  $viewport: PickerViewport;
  $dark: boolean;
}>`
  /* The native custom picker uses a separate portal centered in the layout
     viewport. Keep that dialog above the keyboard while this picker is open. */
  [role="dialog"]:has([data-u-comp="color-picker-spectrum"]) {
    top: ${({ $viewport }) => $viewport.top + $viewport.height / 2}px;
    left: ${({ $viewport }) => $viewport.left + $viewport.width / 2}px;
    max-height: ${({ $viewport }) => $viewport.height - 16}px;
    max-width: ${({ $viewport }) => $viewport.width - 16}px;
    overflow-y: auto;
    overscroll-behavior: contain;

    /* This portal also sits outside Univer's dark theme ancestor. */
    ${({ $dark }) =>
      $dark &&
      css`
        background: var(--univer-gray-700);
        border-color: var(--univer-gray-600);
        color: var(--univer-gray-400);

        input {
          border-color: var(--univer-gray-600);
          color: var(--univer-white);
        }
        button.univer-bg-white {
          background: var(--univer-gray-700);
          border-color: var(--univer-gray-600);
          color: var(--univer-white);

          &:hover {
            background: var(--univer-gray-600);
          }
        }
      `}
  }
`;

const Controls = styled.div`
  display: flex;
  flex: none;
  order: -1;
  height: 40px;
  align-items: center;
  color: var(--univer-gray-700);
  background: var(--univer-gray-50);
  border-inline-end: 1px solid var(--univer-gray-200);

  .univer-dark & {
    color: var(--univer-gray-200);
    background: var(--univer-gray-800);
    border-color: var(--univer-gray-700);
  }
`;

const ControlButton = styled.button`
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  touch-action: manipulation;

  &:focus-visible {
    outline: 2px solid var(--univer-primary-600);
    outline-offset: -2px;
  }
  &:active {
    background: var(--univer-gray-200);
  }
  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .univer-dark &:active {
    background: var(--univer-gray-600);
  }
`;

const Panel = styled(Popover.Content)`
  z-index: 1070;
  box-sizing: border-box;
  width: 288px;
  max-width: calc(100vw - 16px);
  max-height: min(520px, var(--radix-popover-content-available-height));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  border: 1px solid var(--univer-gray-200);
  border-radius: 8px;
  background: var(--univer-white);
  color: var(--univer-gray-900);
  box-shadow: 0 4px 16px rgb(0 0 0 / 15%);
  font-size: 14px;
  outline: none;

  &.univer-dark {
    border-color: var(--univer-gray-600);
    background: var(--univer-gray-700);
    color: var(--univer-white);
  }
`;

const PanelTitle = styled.h2`
  margin: 0;
  padding: 8px;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
`;

const SheetList = styled.div`
  display: grid;
  gap: 4px;
`;

const SheetRow = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`;

const ActionButton = styled.button`
  min-height: 40px;
  padding: 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;

  &:hover,
  &:active {
    background: var(--univer-gray-100);
  }
  &:focus-visible {
    outline: 2px solid var(--univer-primary-600);
    outline-offset: -2px;
  }
  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .univer-dark &:hover,
  .univer-dark &:active {
    background: var(--univer-gray-600);
  }
`;

const SheetButton = styled(ActionButton)`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  gap: 4px;
  text-align: start;
  overflow-wrap: anywhere;

  &[aria-current] {
    color: var(--univer-primary-600);
    font-weight: 600;
  }
  small {
    font-weight: normal;
  }
  .univer-dark &[aria-current] {
    color: var(--univer-primary-300);
  }
`;

const NativeMenu = styled(ContextMenuPanel)`
  && {
    min-width: 0;
    max-height: none !important;
    overflow: visible;
    padding: 0;
    border: 0;
    box-shadow: none;
  }
  button {
    min-height: 40px;
  }
`;

const OrderControls = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-top: 4px;
`;

const RenameForm = styled.form`
  display: grid;
  gap: 8px;
  padding: 8px;
`;

const NameInput = styled.input`
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  padding: 8px;
  border: 1px solid var(--univer-gray-300);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 16px;

  &:focus {
    outline: 2px solid var(--univer-primary-600);
    outline-offset: -1px;
  }
`;

const NameError = styled.div`
  color: var(--univer-red-500);
  overflow-wrap: anywhere;
`;

const ColorContent = styled.div`
  display: grid;
  justify-items: center;
  gap: 8px;
  max-width: 100%;
`;
