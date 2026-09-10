import { createUniver } from "@univerjs/presets";
import { CommandType, LocaleType } from "@univerjs/core";
import type { ICommandInfo } from "@univerjs/core";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { SetScrollRelativeCommand } from "@univerjs/sheets-ui";
import "@univerjs/preset-sheets-core/lib/index.css";
import { MenuIcon } from "outline-icons";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styled from "styled-components";
import Button from "~/components/Button";
import DocumentMenu from "~/menus/DocumentMenu";
import usePolicy from "~/hooks/usePolicy";
import { DebouncedTableSave, tableSaves } from "~/stores/TableSaveCoordinator";
import { toast } from "sonner";
import type Document from "~/models/Document";
import useMediaQuery from "~/hooks/useMediaQuery";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";
import {
  findRibbonHeaderMenu,
  TABLE_DOCUMENT_MOBILE_MEDIA_QUERY,
} from "./TableDocumentLayout";
import {
  installMobileSheetGestures,
  MOBILE_SHEET_GESTURE_MEDIA_QUERY,
} from "./TableDocumentMobileGestures";

function createEmptyWorkbook() {
  return {
    id: "workbook",
    name: "工作簿",
    appVersion: "0.25.1",
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder: ["sheet-1"],
    sheets: {
      "sheet-1": {
        id: "sheet-1",
        name: "Sheet1",
        rowCount: 100,
        columnCount: 26,
        scrollTop: 0,
        scrollLeft: 0,
        cellData: {},
        rowData: {},
        mergeData: [],
      },
    },
  };
}

function getWorkbookData(saved: Record<string, unknown> | null) {
  if (
    saved?.appVersion &&
    saved.locale &&
    saved.styles &&
    saved.sheetOrder &&
    saved.sheets
  ) {
    return saved;
  }

  const snapshot = createEmptyWorkbook() as {
    sheetOrder: string[];
    sheets: Record<
      string,
      { name: string; scrollTop: number; scrollLeft: number }
    >;
  };
  const firstSheetId = snapshot.sheetOrder[0];
  if (firstSheetId && snapshot.sheets[firstSheetId]) {
    snapshot.sheets[firstSheetId].name = "Sheet1";
    snapshot.sheets[firstSheetId].scrollTop = 0;
    snapshot.sheets[firstSheetId].scrollLeft = 0;
  }
  return snapshot;
}

const Workspace = styled.div`
  position: relative;
  height: 100vh;
  width: 100%;
  overflow: hidden;
  overscroll-behavior: none;

  @media ${TABLE_DOCUMENT_MOBILE_MEDIA_QUERY} {
    height: 100dvh;
    display: block;
  }
`;

const Frame = styled.div<{ $permissionReady: boolean; $shared: boolean }>`
  height: 100%;
  width: 100%;
  position: relative;
  overflow: hidden;
  overscroll-behavior: none;
  box-sizing: border-box;
  padding-top: ${({ $shared }) => ($shared ? "36px" : "0")};
  pointer-events: ${({ $permissionReady }) =>
    $permissionReady ? "auto" : "none"};

  @media ${TABLE_DOCUMENT_MOBILE_MEDIA_QUERY} {
    flex: none;
    min-height: 0;
    height: 100%;

    [data-u-comp="ribbon-header-menu"] {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    [data-u-comp="ribbon-header-menu"] > [role="tablist"] {
      flex: 1 1 auto;
      width: auto;
      min-width: 0;
      box-sizing: border-box;
      justify-content: flex-start;
      overflow-x: auto;
      overflow-y: hidden;
      padding-left: 0;
      touch-action: pan-x;
      overscroll-behavior-x: contain;
      scrollbar-width: none;

      &::-webkit-scrollbar {
        display: none;
      }

      > * {
        flex: 0 0 auto;
      }
    }
  }

  @media ${MOBILE_SHEET_GESTURE_MEDIA_QUERY} {
    canvas {
      touch-action: none;
    }
  }

  [class*="footer"],
  [class*="Footer"] {
    min-height: 32px !important;
    height: 32px !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    margin-top: 0 !important;
    margin-bottom: 0 !important;
  }
`;

const Header = styled.div<{ $inMobileRibbon: boolean }>`
  position: absolute;
  z-index: 20;
  top: 0;
  left: 0;
  width: 260px;
  height: 36px;
  padding: 6px 16px;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  background: transparent;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  @media ${TABLE_DOCUMENT_MOBILE_MEDIA_QUERY} {
    position: ${(props) => (props.$inMobileRibbon ? "static" : "absolute")};
    top: ${(props) => (props.$inMobileRibbon ? "auto" : "0")};
    left: ${(props) => (props.$inMobileRibbon ? "auto" : "0")};
    z-index: 20;
    flex: 0 0 40%;
    order: -1;
    width: 40%;
    min-width: 0;
    max-width: 160px;
    height: 36px;
    padding: 2px 4px;
    background: transparent;
    pointer-events: auto;
  }
`;

const MobileMenuButton = styled(Button)`
  pointer-events: auto;
  display: none;

  @media ${TABLE_DOCUMENT_MOBILE_MEDIA_QUERY} {
    display: inline-flex;
    flex: 0 0 32px;
    width: 32px;
    height: 32px;
    padding: 0;
    margin-right: 4px;
  }
`;

const Title = styled.button`
  pointer-events: auto;
  flex: 1 1 auto;
  width: 0;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;

  @media ${TABLE_DOCUMENT_MOBILE_MEDIA_QUERY} {
    flex: 1 1 auto;
    width: 0;
    max-width: none;
  }

  &:hover {
    background: rgba(0, 0, 0, 0.06);
  }
`;

const ReadOnlyTitle = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const TitleInput = styled.input`
  pointer-events: auto;
  flex: 1 1 auto;
  width: 0;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid #4c9aff;
  border-radius: 4px;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  @media ${TABLE_DOCUMENT_MOBILE_MEDIA_QUERY} {
    flex: 1 1 auto;
    width: 0;
    max-width: none;
  }
`;

const ErrorPanel = styled.pre`
  position: absolute;
  bottom: 32px;
  z-index: 30;
  margin: 24px;
  padding: 16px;
  white-space: pre-wrap;
  color: #b42318;
  background: #fef3f2;
  border: 1px solid #fecdca;
  border-radius: 6px;
`;

type Props = { document: Document; readOnly: boolean; isShared?: boolean };

function formatError(error: unknown) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function TableDocument({ document, readOnly, isShared = false }: Props) {
  const { ui, auth } = useStores();
  const can = usePolicy(document);
  const editable = !readOnly && Boolean(auth.user && can.update);
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const isMobile = useMediaQuery(TABLE_DOCUMENT_MOBILE_MEDIA_QUERY);
  const [error, setError] = useState<string | null>(null);
  const [permissionReady, setPermissionReady] = useState(editable);
  const [ribbonHeaderMenu, setRibbonHeaderMenu] = useState<HTMLElement | null>(
    null
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const disposeTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const cleanupRef = useRef<(() => void) | undefined>();
  const disposeNowRef = useRef<(() => void) | undefined>();
  const resourceDocumentIdRef = useRef<string>();
  const applyPermissionRef = useRef<((canEdit: boolean) => void) | undefined>();
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(document.title);
  const displayTitle = document.title || "无标题";

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  const saveTitle = async () => {
    if (!editableRef.current) {
      return;
    }
    const nextTitle = draftTitle.trim();
    if (nextTitle === document.title.trim()) {
      setIsEditingTitle(false);
      return;
    }

    try {
      await tableSaves.flush();
      await document.store.update({ id: document.id, title: nextTitle });
      setIsEditingTitle(false);
    } catch (titleError) {
      setError(`标题保存失败：${formatError(titleError)}`);
      // eslint-disable-next-line no-console
      console.error("[table-page] title save failed", titleError);
    }
  };

  const cancelTitleEdit = () => {
    setDraftTitle(document.title);
    setIsEditingTitle(false);
  };

  useEffect(() => {
    clearTimeout(disposeTimerRef.current);
    if (cleanupRef.current) {
      if (resourceDocumentIdRef.current === document.id) {
        return cleanupRef.current;
      }
      disposeNowRef.current?.();
    }
    if (!containerRef.current) {
      return;
    }
    const containerElement = containerRef.current;

    try {
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_CN,
        locales: { [LocaleType.ZH_CN]: zhCN },
        presets: [
          UniverSheetsCorePreset({
            container: containerRef.current,
            toolbar: editableRef.current,
            formulaBar: editableRef.current,
            footer: {
              sheetBar: true,
              statisticBar: false,
              menus: false,
              zoomSlider: true,
            },
          }),
        ],
      });
      const workbook = univerAPI.createWorkbook(
        getWorkbookData(document.tableData)
      );
      const readOnlyGuard = workbook.onBeforeCommandExecute(
        (command: ICommandInfo) => {
          // Univer 0.25.1's editable permission does not cover every command
          // path. Mutations are the authoritative class of snapshot changes.
          if (!editableRef.current && command.type === CommandType.MUTATION) {
            throw new Error("Table is read-only");
          }
        }
      );
      const applyPermission = (canEdit: boolean) => {
        setPermissionReady(false);
        // Gate edits inside Univer, not just in the visible toolbar or save path.
        workbook.setEditable(canEdit);
        const permission = workbook.getWorkbookPermission();
        void (
          canEdit ? permission.setEditable() : permission.setReadOnly()
        ).then(
          () => setPermissionReady(true),
          (permissionError: unknown) => {
            setError(`表格权限设置失败：${formatError(permissionError)}`);
          }
        );
      };
      applyPermissionRef.current = applyPermission;

      let isCellEditing = false;
      const editStartedSubscription = univerAPI.addEvent(
        univerAPI.Event.SheetEditStarted,
        () => {
          isCellEditing = true;
        }
      );
      const editEndedSubscription = univerAPI.addEvent(
        univerAPI.Event.SheetEditEnded,
        () => {
          isCellEditing = false;
        }
      );
      const disposeMobileGestures = installMobileSheetGestures({
        root: containerElement,
        isEditing: () => isCellEditing,
        scrollBy: (offsetX, offsetY) => {
          // Univer 0.25.1 has no relative-pixel scroll facade. This exported
          // command is the same stable path used by its wheel controller.
          void univerAPI.executeCommand(SetScrollRelativeCommand.id, {
            offsetX,
            offsetY,
          });
        },
        getZoom: () => workbook.getActiveSheet().getZoom(),
        setZoom: (zoom) => workbook.getActiveSheet().zoom(zoom),
      });

      let ribbonObserver: MutationObserver | undefined;
      let ribbonFrame = 0;
      const captureRibbonHeaderMenu = () => {
        const ribbonHeader = findRibbonHeaderMenu(containerElement);
        if (!ribbonHeader) {
          return;
        }
        setRibbonHeaderMenu(ribbonHeader);
        ribbonObserver?.disconnect();
      };
      ribbonObserver = new MutationObserver(captureRibbonHeaderMenu);
      ribbonObserver.observe(containerElement, {
        childList: true,
        subtree: true,
      });
      ribbonFrame = requestAnimationFrame(captureRibbonHeaderMenu);

      let mounted = true;
      const reportSaveError = (saveError: unknown) => {
        const message = `表格保存失败：${formatError(saveError)}`;
        if (mounted) {
          setError(message);
        }
        toast.error(message);
      };
      const pendingSave = new DebouncedTableSave(async () => {
        if (!editableRef.current) {
          throw new Error("Table is no longer editable");
        }
        const tableData = workbook.save();
        await client.post(
          "/documents.update",
          {
            id: document.id,
            tableData,
            done: true,
          },
          { tableSave: true }
        );
        document.tableData = tableData;
        if (mounted) {
          setError(null);
        }
      }, reportSaveError);
      const flush = async () => {
        if (workbook.isCellEditing()) {
          if (!editableRef.current || !(await workbook.endEditingAsync(true))) {
            throw new Error(
              "Finish editing the current cell before leaving the table"
            );
          }
          pendingSave.schedule();
        }
        await pendingSave.flush();
      };
      const unregister = tableSaves.register({
        hasPending: () =>
          pendingSave.hasPending ||
          (editableRef.current && workbook.isCellEditing()),
        flush,
      });
      const subscription = workbook.onCommandExecuted(() => {
        if (editableRef.current) {
          pendingSave.schedule();
        }
      });

      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        mounted = false;
        readOnlyGuard.dispose();
        disposeMobileGestures();
        editStartedSubscription.dispose();
        editEndedSubscription.dispose();
        cancelAnimationFrame(ribbonFrame);
        ribbonObserver?.disconnect();
        setRibbonHeaderMenu(null);
        subscription.dispose();
        unregister();
        univer.dispose();
        if (cleanupRef.current === cleanup) {
          cleanupRef.current = undefined;
          disposeNowRef.current = undefined;
          resourceDocumentIdRef.current = undefined;
          if (applyPermissionRef.current === applyPermission) {
            applyPermissionRef.current = undefined;
          }
        }
      };
      const disposeNow = () => {
        clearTimeout(disposeTimerRef.current);
        mounted = false;
        const saving = flush();
        release();
        void saving.catch(reportSaveError);
      };
      const cleanup = () => {
        clearTimeout(disposeTimerRef.current);
        disposeTimerRef.current = setTimeout(() => {
          mounted = false;
          void flush().catch(reportSaveError).finally(release);
        }, 0);
      };
      cleanupRef.current = cleanup;
      disposeNowRef.current = disposeNow;
      resourceDocumentIdRef.current = document.id;
      return cleanup;
    } catch (initializationError) {
      setError(`表格初始化失败：${formatError(initializationError)}`);
      // eslint-disable-next-line no-console
      console.error("[table-page] initialization failed", initializationError);
    }
    return undefined;
  }, [document]);

  useEffect(() => {
    applyPermissionRef.current?.(editable);
  }, [editable]);

  const inMobileRibbon = isMobile && Boolean(ribbonHeaderMenu);
  const header = (
    <Header $inMobileRibbon={inMobileRibbon}>
      <MobileMenuButton
        aria-label="打开导航栏"
        icon={<MenuIcon />}
        neutral
        onClick={ui.toggleMobileSidebar}
      />
      {!editable ? (
        <ReadOnlyTitle title={displayTitle}>{displayTitle}</ReadOnlyTitle>
      ) : isEditingTitle ? (
        <TitleInput
          ref={titleInputRef}
          value={draftTitle}
          placeholder="无标题"
          aria-label="文档标题"
          onChange={(event) => setDraftTitle(event.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveTitle();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelTitleEdit();
            }
          }}
        />
      ) : (
        <Title
          type="button"
          title="点击重命名"
          onClick={() => {
            setDraftTitle(document.title);
            setIsEditingTitle(true);
          }}
        >
          {displayTitle}
        </Title>
      )}
    </Header>
  );

  const menu = !isShared && auth.user ? (
    <TableActions $inMobileRibbon={inMobileRibbon}>
      <DocumentMenu
        document={document}
        align="end"
        neutral
        showDisplayOptions
        onRename={
          editable
            ? () => {
                setDraftTitle(document.title);
                setIsEditingTitle(true);
              }
            : undefined
        }
      />
    </TableActions>
  ) : null;

  return (
    <Workspace>
      {inMobileRibbon && ribbonHeaderMenu
        ? createPortal(
            <>
              {header}
              {menu}
            </>,
            ribbonHeaderMenu
          )
        : header}
      {!inMobileRibbon && menu}
      {error && <ErrorPanel role="alert">{error}</ErrorPanel>}
      <Frame ref={containerRef} $permissionReady={permissionReady} $shared={isShared} />
    </Workspace>
  );
}

const TableActions = styled.div<{ $inMobileRibbon: boolean }>`
  position: absolute;
  top: 0;
  right: 4px;
  height: 36px;
  z-index: 21;
  display: flex;
  align-items: center;
  background: ${({ theme }) => theme.background};

  @media ${TABLE_DOCUMENT_MOBILE_MEDIA_QUERY} {
    position: ${({ $inMobileRibbon }) =>
      $inMobileRibbon ? "static" : "absolute"};
    flex: 0 0 36px;
    order: 2;
  }
`;

export default observer(TableDocument);
