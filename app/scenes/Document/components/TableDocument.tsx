import {
  CommandType,
  DisposableCollection,
  DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY,
  DOCS_NORMAL_EDITOR_UNIT_ID_KEY,
  LocaleType,
  mergeWorksheetSnapshotWithDefault,
  RANGE_TYPE,
  ICommandService,
  IUndoRedoService,
  UndoCommand,
  RedoCommand,
  type IDisposable,
} from "@univerjs/core";
import { Vector2 } from "@univerjs/engine-render";
import { faEraser } from "@fortawesome/free-solid-svg-icons/faEraser";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  BuiltInUIPart,
  DocSelectionManagerService,
  FormulaBar,
  IEditorBridgeService,
  IEditorService,
  IMenuManagerService,
  IRibbonService,
  IRenderManagerService,
  INTERCEPTOR_POINT,
  Ribbon,
  RibbonPosition,
  ScrollToCellOperation,
  SheetCellEditorResizeService,
  SheetInterceptorService,
  SheetSkeletonManagerService,
  SetFrozenCommand,
  CancelFrozenCommand,
  SheetsSelectionsService,
  WorkbookPermissionService,
} from "@univerjs/preset-sheets-core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { createUniver } from "@univerjs/presets";
import "@univerjs/preset-sheets-core/lib/index.css";
import { observer } from "mobx-react";
import equal from "fast-deep-equal";
import copy from "copy-to-clipboard";
import {
  CloseIcon,
  CheckmarkIcon,
  CopyIcon,
  EditIcon,
  ImportIcon,
  TableIcon,
  MenuIcon,
} from "outline-icons";
import { v4 as uuid } from "uuid";
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FormEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Prompt, useHistory } from "react-router-dom";
import styled, { createGlobalStyle, css, useTheme } from "styled-components";
import { DocumentValidation } from "@shared/validations";
import { worksheetToCSV } from "@shared/utils/tableCSV";
import {
  createCSVWorksheet,
  type TableCSVImport,
} from "~/utils/tableCSVImport";
import {
  buildTablePasteValues,
  type TablePasteTarget,
} from "~/utils/tablePaste";
import { toast } from "sonner";
import {
  clearTableSelectionValues,
  selectionToTSV,
  type TableSelectionClear,
} from "~/utils/tableSelection";
import { isTouchDevice } from "@shared/utils/browser";
import {
  TableRosterSchema,
  type TablePresence,
} from "@shared/utils/tablePresence";
import {
  type TableDocumentContent,
  tableDocumentToMarkdown,
} from "@shared/utils/tableDocument";
import {
  getTableCellImage,
  getTableCellImageSize,
  setTableCellImage,
  setTableCellImageSize,
} from "@shared/utils/tableCellImage";
import Button from "~/components/Button";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import Modal from "~/components/Modal";
import Input from "~/components/Input";
import PageTitle from "~/components/PageTitle";
import { useSplitView } from "~/components/SplitView/context";
import useStores from "~/hooks/useStores";
import { TableDocumentMenu } from "~/menus/TableDocumentMenu";
import { WebsocketContext } from "~/components/WebsocketProvider";
import { TableCollaborationSession } from "~/stores/TableCollaborationSession";
import { patchTableCells } from "~/utils/tableCollaborationView";
import { observeCollaborationActivity } from "~/utils/collaborationCursor";
import { CollaborationCursorAvatars } from "~/components/CollaborationCursorAvatars";
import type Document from "~/models/Document";
import {
  getTableDraftKey,
  TableDocumentSession,
} from "~/stores/TableDocumentSession";
import { TABLE_SAVE_PROMPT, tableSaves } from "~/stores/TableSaveCoordinator";
import { download } from "~/utils/download";
import appHistory from "~/utils/history";
import { documentPath } from "~/utils/routeHelpers";
import { closeSplitPane } from "~/utils/splitView";
import { bindTableFormulaFocus } from "~/utils/tableFormulaFocus";
import {
  bindTableAutoFit,
  bindTableAutoHeightLifecycle,
} from "~/utils/tableAutoFit";
import { registerTableMultilineEditing } from "~/utils/tableMultiline";
import {
  bindTableMobileHeaderSelection,
  bindTableMobileInput,
  createTableMobileTextEditor,
  observeTableViewport,
} from "~/utils/tableMobile";
import {
  configureTableMobileMenu,
  createTablePreset,
} from "~/utils/tablePreset";
import { getTableWorkbook } from "~/utils/tableWorkbook";
import { registerTableScriptMenu } from "~/utils/tableScriptMenu";
import {
  registerTableCellImages,
  type TableCellImageController,
} from "~/utils/tableCellImage";
import { useTableSaveShortcut } from "../hooks/useTableSaveShortcut";
import Notices from "./Notices";
import { TableSheetControls } from "./TableSheetControls";
import { TableCollaborators } from "./TableCollaborators";
import { TableCellImageControl } from "./TableCellImageControl";

const TableCSVImportDialog = lazy(() =>
  import("./TableCSVImportDialog").then((module) => ({
    default: module.TableCSVImportDialog,
  }))
);

const TablePasteDialog = lazy(() =>
  import("./TablePasteDialog").then((module) => ({
    default: module.TablePasteDialog,
  }))
);

const ScriptPanel = lazy(() =>
  import("./TableScriptPanel").then((module) => ({
    default: module.TableScriptPanel,
  }))
);

interface Props {
  document: Document;
  table: TableDocumentContent;
  readOnly: boolean;
  abilities: Record<string, boolean>;
  shareId?: string;
  children?: ReactNode;
}

interface TableRuntime {
  prepareFreeze: () => {
    destination: string;
    frozenRows: number;
    frozenColumns: number;
    apply: (mode: TableFreezeMode) => Promise<void>;
  };
  getSelectionText: () => string;
  prepareClearSelection: () => TableSelectionClear;
  getPasteTarget: () => TablePasteTarget | undefined;
  importCSV: (data: TableCSVImport, name: string) => Promise<void>;
  exportCSV: () => Promise<{ name: string; text: string }>;
  commit: () => Promise<void>;
  flush: () => Promise<void>;
  setEditable: (editable: boolean) => void;
  setDarkMode: (dark: boolean) => void;
  setScriptsAvailable?: (available: boolean) => void;
  updatePresence?: (peers: TablePresence[]) => void;
  images: TableCellImageController;
}

type TableFreezeMode = "firstRow" | "firstColumn" | "selection" | "none";

/**
 * Renders a native Univer workbook with guarded autosave and recoverable drafts.
 *
 * @param props the document, saved workbook and current access permissions.
 * @returns the workbook editor and Outline document actions.
 */
export const TableDocument = observer(function TableDocument({
  document,
  table,
  readOnly,
  abilities,
  shareId,
  children,
}: Props) {
  const { auth, dialogs, ui, tableScripts } = useStores();
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const history = useHistory();
  const { isSplitView, pane } = useSplitView();
  const socket = useContext(WebsocketContext);
  // Keep the same runtime when a phone rotates or its keyboard opens.
  const [mobile] = useState(isTouchDevice);
  const editable = !readOnly && !!auth.user && !!abilities.update;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const darkRef = useRef(theme.isDark);
  darkRef.current = theme.isDark;
  const containerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const runtimeRef = useRef<TableRuntime>();
  const mobileEditingRef = useRef<{
    start: () => void;
    cancel: () => Promise<void>;
  }>();
  const getImageController = useCallback(() => runtimeRef.current?.images, []);
  const sessionUseCountsRef = useRef(
    new Map<TableDocumentSession | TableCollaborationSession, number>()
  );
  const [collaborationClientId] = useState(() => uuid());
  const [ready, setReady] = useState(false);
  const [importCSVOpen, setImportCSVOpen] = useState(false);
  const [pasteRequest, setPasteRequest] = useState<{
    target: TablePasteTarget;
    initialText?: string;
  }>();
  const [cellEditing, setCellEditing] = useState(false);
  const [homeToolsVisible, setHomeToolsVisible] = useState(true);
  const [selectionLabel, setSelectionLabel] = useState("");
  const [freezeTarget, setFreezeTarget] =
    useState<ReturnType<TableRuntime["prepareFreeze"]>>();
  const [freezeBusy, setFreezeBusy] = useState(false);
  const freezeRunning = useRef(false);
  const [renameRequest, setRenameRequest] = useState<{
    originalTitle: string;
    value: string;
  }>();
  const [editorError, setEditorError] = useState(false);
  const reportEditorError = useCallback((_error: unknown) => {
    setEditorError(true);
  }, []);
  const scriptSession = tableScripts.getSession(document.id);
  const [scriptMaximized, setScriptMaximized] = useState(false);
  const scriptTrigger = useRef<Element | null>(null);
  const ownsDocument = document.createdBy?.id === auth.user?.id;
  const scriptsAvailable =
    !mobile &&
    editable &&
    !shareId &&
    ownsDocument &&
    !!scriptSession.capabilities?.canDevelop;

  useEffect(() => {
    if (!mobile && editable && !shareId) {
      void scriptSession.loadCapabilities().catch(() => {
        /* A missing API does not affect the spreadsheet. */
      });
    }
  }, [editable, mobile, ownsDocument, scriptSession, shareId]);

  const createSession = useCallback(
    (content: TableDocumentContent) => {
      const draftKey =
        editable && auth.user && auth.team
          ? getTableDraftKey(auth.team.id, auth.user.id, document.id)
          : undefined;
      let storage: Storage | undefined;
      try {
        storage = draftKey ? localStorage : undefined;
      } catch {
        // Saving remains available even if browser storage is disabled.
      }
      // A legacy snapshot draft keeps its existing recovery path. New native
      // sessions use operation-level collaboration; public shares remain viewers.
      let legacyDraft = false;
      try {
        legacyDraft = !!(draftKey && storage?.getItem(draftKey));
      } catch {
        /* Storage can be unavailable. */
      }
      if (content.version === 2 && auth.user && !shareId && !legacyDraft) {
        return new TableCollaborationSession({
          documentId: document.id,
          title: document.title,
          revision: document.revision,
          workbook: getTableWorkbook(content, document.title),
          draftKey,
          storage,
        });
      }
      return new TableDocumentSession({
        title: document.title,
        revision: document.revision,
        workbook: getTableWorkbook(content, document.title),
        save: (request) => document.store.updateTable(document.id, request),
        draftKey,
        storage,
      });
    },
    [auth.team, auth.user, document, editable, shareId]
  );
  const [session, setSession] = useState(() => createSession(table));
  const sessionLoaded =
    !(session instanceof TableCollaborationSession) || session.loaded;

  useEffect(() => {
    const useCounts = sessionUseCountsRef.current;
    useCounts.set(session, (useCounts.get(session) ?? 0) + 1);
    return () => {
      queueMicrotask(() => {
        const nextCount = (useCounts.get(session) ?? 1) - 1;
        if (nextCount > 0) {
          useCounts.set(session, nextCount);
          return;
        }
        useCounts.delete(session);
        session.dispose();
      });
    };
  }, [session]);

  useEffect(() => {
    if (!(session instanceof TableCollaborationSession)) {
      return;
    }
    const refresh = () => {
      void session.refresh().catch(() => {
        /* Recovery is shown in the table. */
      });
    };
    const watch = () => {
      socket?.emit("table.watch", {
        documentId: document.id,
        clientId: collaborationClientId,
      });
      refresh();
    };
    const changed = (event: { documentId: string }) => {
      if (event.documentId === document.id) {
        refresh();
      }
    };
    const revoked = (event: { documentId: string }) => {
      if (event.documentId === document.id) {
        runtimeRef.current?.setEditable(false);
        refresh();
        void document.store.fetch(document.id, { force: true }).catch(() => {
          /* The API enforces current access. */
        });
      }
    };
    const roster = (input: object) => {
      const event = TableRosterSchema.safeParse(input);
      if (!event.success || event.data.documentId !== document.id) {
        return;
      }
      const peers = event.data.peers;
      session.updatePeers(peers);
      runtimeRef.current?.updatePresence?.(peers);
    };
    const disconnected = () => {
      session.updatePeers([]);
      runtimeRef.current?.updatePresence?.([]);
    };
    watch();
    socket?.on("authenticated", watch);
    socket?.on("table.changed", changed);
    socket?.on("table.revoked", revoked);
    socket?.on("table.roster", roster);
    socket?.on("disconnect", disconnected);
    window.addEventListener("online", watch);
    window.addEventListener("focus", refresh);
    // Repairs missed notifications after a Redis or background-tab interruption.
    const interval = setInterval(refresh, 15000);
    return () => {
      clearInterval(interval);
      socket?.emit("table.unwatch", {
        documentId: document.id,
        clientId: collaborationClientId,
      });
      socket?.off("authenticated", watch);
      socket?.off("table.changed", changed);
      socket?.off("table.revoked", revoked);
      socket?.off("table.roster", roster);
      socket?.off("disconnect", disconnected);
      window.removeEventListener("online", watch);
      window.removeEventListener("focus", refresh);
    };
  }, [collaborationClientId, document, session, socket]);

  const handleSave = useCallback(async () => {
    try {
      if (session instanceof TableCollaborationSession && !session.loaded) {
        await session.load();
      }
      await runtimeRef.current?.flush();
    } catch (error) {
      if (!session.error) {
        reportEditorError(error);
      }
    }
  }, [reportEditorError, session]);

  useTableSaveShortcut(handleSave);

  const handleImportCSV = useCallback(
    async (data: TableCSVImport, name: string) => {
      const runtime = runtimeRef.current;
      if (!runtime) {
        throw new Error(t("This table is no longer available."));
      }
      await runtime.importCSV(data, name);
    },
    [t]
  );

  const handleExportCSV = useCallback(async () => {
    if (!abilities.download || !ready) {
      return;
    }
    try {
      const result = await runtimeRef.current?.exportCSV();
      if (!result) {
        return;
      }
      const url = URL.createObjectURL(
        new Blob([result.text], { type: "text/csv;charset=utf-8" })
      );
      const link = window.document.createElement("a");
      link.href = url;
      link.download =
        `${document.title}-${result.name}`.replace(/[\\/:*?"<>|]/g, "_") +
        ".csv";
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error(t("Unable to export this worksheet as CSV."));
    }
  }, [abilities.download, ready, document.title, t]);

  useEffect(() => {
    const container = containerRef.current;
    const toolbar = toolbarRef.current;
    if (!container || !toolbar || !sessionLoaded) {
      return;
    }
    let alive = true;
    let permissionsInitialized = false;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    let capturePending = false;
    let applyingRemote = false;
    let remotePending = false;
    let commitMobileTextEditor = () => {};
    const uiDisposables = new DisposableCollection();
    const host = container.ownerDocument.createElement("div");
    host.className = "outline-univer-host";
    container.appendChild(host);
    let dispose = () => {
      host.remove();
    };
    try {
      const locale = i18n.language.startsWith("zh")
        ? LocaleType.ZH_CN
        : LocaleType.EN_US;
      const { univer, univerAPI } = createUniver({
        locale,
        locales: { [LocaleType.ZH_CN]: zhCN, [LocaleType.EN_US]: enUS },
        darkMode: darkRef.current,
        presets: [createTablePreset(host, mobile)],
      });
      dispose = () => {
        uiDisposables.dispose();
        univer.dispose();
        host.remove();
      };
      const autoHeightTasks = bindTableAutoHeightLifecycle(
        univer.__getInjector().get(ICommandService),
        session.table.workbook.id
      );
      uiDisposables.add(autoHeightTasks);
      let workbook = univerAPI.createWorkbook(session.table.workbook);
      uiDisposables.add(
        bindTableAutoFit(univer.__getInjector().get(ICommandService), () => {
          const worksheet = workbook.getWorkbook().getActiveSheet();
          if (!worksheet) {
            return;
          }
          return {
            worksheet,
            ranges: univer
              .__getInjector()
              .get(SheetsSelectionsService)
              .getCurrentSelections()
              .map((selection) => selection.range),
          };
        })
      );
      uiDisposables.add(
        registerTableMultilineEditing(
          univer.__getInjector().get(SheetInterceptorService)
        )
      );
      uiDisposables.add(
        registerTableCellImages(
          univer.__getInjector().get(SheetInterceptorService),
          () => {
            const render = univer
              .__getInjector()
              .get(IRenderManagerService)
              .getRenderById(workbook.getId());
            render?.mainComponent?.makeDirty();
            render?.scene.makeDirty();
          },
          INTERCEPTOR_POINT.CELL_CONTENT
        )
      );
      const collaboration =
        session instanceof TableCollaborationSession ? session : undefined;
      let sharedSnapshot =
        collaboration && !collaboration.conflict
          ? collaboration.snapshot()
          : session.table.workbook;
      const scriptMenu =
        !mobile && !shareId
          ? registerTableScriptMenu(
              univer.__getInjector(),
              i18n.language.startsWith("zh"),
              (mode) => {
                void scriptSession.open(mode).catch(() => {
                  /* Displayed in the panel. */
                });
              }
            )
          : undefined;
      if (scriptMenu) {
        uiDisposables.add(scriptMenu);
        // Univer moves focus to its canvas before invoking a menu command.
        const handleToolbarInteraction = (event: Event) => {
          if (!(event.target instanceof Element)) {
            return;
          }
          const button = event.target.closest("button");
          if (button && toolbar.contains(button)) {
            scriptTrigger.current = button;
          }
        };
        toolbar.addEventListener("focusin", handleToolbarInteraction);
        toolbar.addEventListener("click", handleToolbarInteraction, true);
        uiDisposables.add({
          dispose: () => {
            toolbar.removeEventListener("focusin", handleToolbarInteraction);
            toolbar.removeEventListener(
              "click",
              handleToolbarInteraction,
              true
            );
          },
        });
      }
      session.initialize(workbook.save());
      let highlights: IDisposable[] = [];
      let renderedPresence: string | undefined;
      let presenceFrame: number | undefined;
      let presenceTimer: ReturnType<typeof setTimeout> | undefined;
      const clearHighlights = () => {
        if (presenceFrame !== undefined) {
          cancelAnimationFrame(presenceFrame);
          presenceFrame = undefined;
        }
        for (const highlight of highlights) {
          highlight.dispose();
        }
        highlights = [];
        renderedPresence = undefined;
      };
      const updatePresence = (peers: TablePresence[]) => {
        if (!collaboration || !alive) {
          clearHighlights();
          return;
        }
        const canvas = univer
          .__getInjector()
          .get(IRenderManagerService)
          .getRenderById(workbook.getId())
          ?.engine.getCanvasElement();
        if (!canvas?.isConnected) {
          clearHighlights();
          presenceFrame = requestAnimationFrame(() => {
            presenceFrame = undefined;
            updatePresence(collaboration.peers);
          });
          return;
        }
        const sheet = workbook.getActiveSheet();
        const otherPeers = peers.filter(
          (peer) =>
            peer.clientId !== collaborationClientId &&
            peer.userId !== auth.user?.id
        );
        const signature = JSON.stringify(
          otherPeers.map((peer) => ({
            clientId: peer.clientId,
            name: peer.name,
            avatarUrl: peer.avatarUrl,
            color: peer.color,
            editing: peer.selection?.editing,
            range:
              peer.selection?.sheetId === sheet.getSheetId()
                ? collaboration.selectionRange(peer.selection)
                : null,
          }))
        );
        if (signature === renderedPresence) {
          return;
        }
        clearHighlights();
        renderedPresence = signature;
        const editors = new Map<
          string,
          { row: number; column: number; peers: TablePresence[] }
        >();
        for (const peer of otherPeers) {
          if (peer.selection?.sheetId !== sheet.getSheetId()) {
            continue;
          }
          const range = collaboration.selectionRange(peer.selection);
          if (!range) {
            continue;
          }
          if (peer.selection.editing) {
            const key = `${range.startRow}:${range.startColumn}`;
            const group = editors.get(key) ?? {
              row: range.startRow,
              column: range.startColumn,
              peers: [],
            };
            if (!group.peers.some((member) => member.userId === peer.userId)) {
              group.peers.push(peer);
            }
            editors.set(key, group);
          }
          highlights.push(
            sheet
              .getRange(
                range.startRow,
                range.startColumn,
                range.endRow - range.startRow + 1,
                range.endColumn - range.startColumn + 1
              )
              .highlight({
                stroke: peer.color,
                strokeWidth: peer.selection.editing ? 3 : 2,
                fill: `${peer.color}12`,
                widgets: {},
                widgetSize: 0,
                autofillSize: 0,
                rowHeaderFill: "transparent",
                columnHeaderFill: "transparent",
              })
          );
        }
        for (const group of editors.values()) {
          const users = group.peers.map((peer) => ({
            id: peer.userId,
            name: peer.name,
            avatarUrl: peer.avatarUrl,
            color: peer.color,
          }));
          const popup = sheet.getRange(group.row, group.column).attachPopup({
            componentKey: () => <CollaborationCursorAvatars users={users} />,
            direction: "horizontal-top",
            offset: [4, 0],
            hideOnInvisible: true,
            showOnSelectionMoving: true,
            mask: false,
            zIndex: 3,
          });
          if (popup) {
            highlights.push(popup);
          }
        }
      };
      let activelyEditing = false;
      const sendPresence = () => {
        if (!collaboration || !socket?.connected || !alive) {
          return;
        }
        const sheet = workbook.getActiveSheet();
        const range =
          sheet.getSelection()?.getActiveRange()?.getRange() ??
          workbook.getActiveCell()?.getRange();
        socket.emit("table.presence", {
          documentId: document.id,
          clientId: collaborationClientId,
          selection:
            !collaboration.conflict && range
              ? (collaboration.selection(
                  sheet.getSheetId(),
                  range,
                  activelyEditing
                ) ?? null)
              : null,
        });
      };
      const schedulePresence = () => {
        if (presenceTimer) {
          return;
        }
        presenceTimer = setTimeout(() => {
          presenceTimer = undefined;
          sendPresence();
          updatePresence(collaboration?.peers ?? []);
        }, 250);
      };
      if (collaboration) {
        const activity = observeCollaborationActivity(
          () =>
            editableRef.current &&
            workbook.isCellEditing() &&
            host.contains(host.ownerDocument.activeElement),
          (editing) => {
            activelyEditing = editing;
            schedulePresence();
          }
        );
        for (const event of [
          univerAPI.Event.SelectionChanged,
          univerAPI.Event.ActiveSheetChanged,
          univerAPI.Event.SheetEditStarted,
          univerAPI.Event.SheetEditEnded,
        ]) {
          uiDisposables.add(
            univerAPI.addEvent(event, () => {
              activity.refresh();
              schedulePresence();
            })
          );
        }
        socket?.on("authenticated", schedulePresence);
        const presenceHeartbeat = setInterval(schedulePresence, 15000);
        schedulePresence();
        uiDisposables.add({
          dispose: () => {
            clearTimeout(presenceTimer);
            clearInterval(presenceHeartbeat);
            socket?.off("authenticated", schedulePresence);
            clearHighlights();
            activity.dispose();
          },
        });
      }
      const editorService = univer.__getInjector().get(IEditorService);
      uiDisposables.add({
        dispose: bindTableFormulaFocus(host, {
          isActive: () =>
            editorService.getFocusEditor()?.getEditorId() ===
            DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY,
          restore: () =>
            editorService
              .getEditor(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY)
              ?.focus(),
        }),
      });

      // A native UI part keeps Univer's injector, menus and popup context;
      // the portal places its responsive Ribbon beside Outline's title.
      uiDisposables.add(
        univerAPI.registerUIPart(BuiltInUIPart.GLOBAL, () =>
          createPortal(
            <Ribbon ribbonType="classic" headerMenu={!mobile} />,
            toolbar
          )
        )
      );
      uiDisposables.add(
        univerAPI.addEvent(univerAPI.Event.SheetEditStarted, () => {
          if (alive) {
            setCellEditing(workbook.isCellEditing());
          }
        })
      );
      uiDisposables.add(
        univerAPI.addEvent(univerAPI.Event.SheetEditEnded, () => {
          if (alive) {
            setCellEditing(false);
          }
        })
      );

      if (mobile) {
        const subscription = univer
          .__getInjector()
          .get(IRibbonService)
          .activatedTab$.subscribe((tab) => {
            if (alive) {
              setHomeToolsVisible(tab === RibbonPosition.START);
            }
          });
        uiDisposables.add({ dispose: () => subscription.unsubscribe() });
        // The mobile preset provides formula editing services but omits the
        // header UI. Keep the native address, editor and expand controls.
        uiDisposables.add(
          univerAPI.registerUIPart(BuiltInUIPart.HEADER, () => (
            <MobileFormulaBar />
          ))
        );
        configureTableMobileMenu(
          univer.__getInjector().get(IMenuManagerService)
        );
        const input = bindTableMobileInput(host);
        const textEditor = createTableMobileTextEditor(host);
        commitMobileTextEditor = textEditor.commit;
        const mobileEditing = {
          start: () => {
            if (alive && editableRef.current && !session.conflict) {
              workbook.startEditing();
            }
          },
          cancel: async () => {
            textEditor.cancel();
            await workbook.abortEditingAsync();
          },
        };
        mobileEditingRef.current = mobileEditing;
        uiDisposables.add({
          dispose: () => {
            if (mobileEditingRef.current === mobileEditing) {
              mobileEditingRef.current = undefined;
            }
          },
        });
        uiDisposables.add(input);
        uiDisposables.add(textEditor);
        let headerCanvas: HTMLCanvasElement | undefined;
        let disposeHeaderSelection = () => {};
        const bindHeaderSelection = () => {
          const render = univer
            .__getInjector()
            .get(IRenderManagerService)
            .getRenderById(workbook.getId());
          const canvas = render?.engine.getCanvasElement();
          if (!render || !canvas || canvas === headerCanvas) {
            return;
          }
          disposeHeaderSelection();
          headerCanvas = canvas;
          const skeletons = render.with(SheetSkeletonManagerService);
          disposeHeaderSelection = bindTableMobileHeaderSelection(canvas, {
            getTarget: (clientX, clientY, axis) => {
              const skeleton = skeletons.getCurrentSkeleton();
              if (!skeleton) {
                return;
              }
              const bounds = canvas.getBoundingClientRect();
              let offsetX = clientX - bounds.left;
              let offsetY = clientY - bounds.top;
              const rowHeader = skeleton.rowHeaderWidthAndMarginLeft;
              const columnHeader = skeleton.columnHeaderHeightAndMarginTop;
              const targetAxis =
                axis ??
                (offsetX < rowHeader && offsetY >= columnHeader
                  ? "row"
                  : offsetY < columnHeader && offsetX >= rowHeader
                    ? "column"
                    : undefined);
              if (!targetAxis) {
                return;
              }
              if (targetAxis === "row") {
                offsetX = Math.max(1, rowHeader / 2);
                offsetY = Math.min(
                  Math.max(columnHeader + 1, offsetY),
                  bounds.height - 1
                );
              } else {
                offsetX = Math.min(
                  Math.max(rowHeader + 1, offsetX),
                  bounds.width - 1
                );
                offsetY = Math.max(1, columnHeader / 2);
              }
              const point = render.scene.getCoordRelativeToViewport(
                Vector2.FromArray([offsetX, offsetY])
              );
              const scroll = render.scene.getScrollXYInfoByViewport(point);
              const { scaleX, scaleY } = render.scene.getAncestorScale();
              const cell = skeleton.getCellWithCoordByOffset(
                point.x,
                point.y,
                scaleX,
                scaleY,
                scroll
              );
              if (!cell) {
                return;
              }
              return {
                axis: targetAxis,
                index:
                  targetAxis === "row" ? cell.actualRow : cell.actualColumn,
              };
            },
            select: (axis, first, last) => {
              const sheet = workbook.getActiveSheet();
              const start = Math.min(first, last);
              const end = Math.max(first, last);
              const range =
                axis === "row"
                  ? {
                      startRow: start,
                      endRow: end,
                      startColumn: 0,
                      endColumn: sheet.getMaxColumns() - 1,
                      rangeType: RANGE_TYPE.ROW,
                    }
                  : {
                      startRow: 0,
                      endRow: sheet.getMaxRows() - 1,
                      startColumn: start,
                      endColumn: end,
                      rangeType: RANGE_TYPE.COLUMN,
                    };
              univer
                .__getInjector()
                .get(SheetsSelectionsService)
                .setSelections(workbook.getId(), sheet.getSheetId(), [
                  { range, primary: null, style: null },
                ]);
            },
          });
        };
        const headerObserver = new MutationObserver(bindHeaderSelection);
        headerObserver.observe(host, { childList: true, subtree: true });
        bindHeaderSelection();
        uiDisposables.add({
          dispose: () => {
            headerObserver.disconnect();
            disposeHeaderSelection();
          },
        });
        uiDisposables.add(
          univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, (event) => {
            if (
              getTableCellImage(
                event.worksheet.getSheet().getCellRaw(event.row, event.column)
              )
            ) {
              event.cancel = true;
              return;
            }
            if (!editableRef.current) {
              event.cancel = true;
              return;
            }
            input.setEditing(true);
            queueMicrotask(() => {
              if (alive) {
                input.setEditing(workbook.isCellEditing());
              }
            });
          })
        );
        uiDisposables.add(
          univerAPI.addEvent(univerAPI.Event.SheetEditEnded, () => {
            input.setEditing(false);
          })
        );
        uiDisposables.add(
          univerAPI.addEvent(univerAPI.Event.SheetEditStarted, (event) => {
            const range = event.worksheet.getRange(event.row, event.column);
            const cell = range.getCellData();
            if (
              cell?.f ||
              cell?.p ||
              cell?.si ||
              (cell?.v !== null &&
                cell?.v !== undefined &&
                typeof cell.v !== "string")
            ) {
              return;
            }
            const bridge = univer.__getInjector().get(IEditorBridgeService);
            const layout = bridge.getEditCellLayout();
            const canvas = host.querySelector<HTMLCanvasElement>(
              '[id^="univer-sheet-main-canvas_"]'
            );
            if (!layout || !canvas) {
              return;
            }
            const position = layout.position;
            const getBounds = () => {
              const canvasBounds = canvas.getBoundingClientRect();
              return new DOMRect(
                canvasBounds.left + position.startX,
                canvasBounds.top + position.startY,
                position.endX - position.startX,
                position.endY - position.startY
              );
            };
            void workbook.endEditingAsync(false).then((ended) => {
              if (!ended || !alive || !editableRef.current) {
                return;
              }
              setCellEditing(true);
              textEditor.open({
                ariaLabel: t("Edit cell"),
                getBounds,
                value: typeof cell?.v === "string" ? cell.v : "",
                onCommit: (value) => range.setValue(value),
                onClose: () => {
                  if (alive) {
                    setCellEditing(false);
                  }
                },
              });
            });
          })
        );
        if (workspaceRef.current) {
          uiDisposables.add({
            dispose: observeTableViewport(workspaceRef.current, () => {
              if (!alive || !workbook.isCellEditing()) {
                return;
              }
              const cell = workbook.getActiveCell();
              if (cell) {
                univerAPI.syncExecuteCommand(ScrollToCellOperation.id, {
                  unitId: workbook.getId(),
                  range: cell.getRange(),
                });
                // The native inline editor retains its position while scrolling.
                // Refresh layout only, preserving its uncommitted text and IME.
                const injector = univer.__getInjector();
                injector.get(IEditorBridgeService).refreshEditCellPosition();
                injector.get(SheetCellEditorResizeService).fitTextSize(() => {
                  if (alive && workbook.isCellEditing()) {
                    injector.get(DocSelectionManagerService).refreshSelection({
                      unitId: DOCS_NORMAL_EDITOR_UNIT_ID_KEY,
                      subUnitId: DOCS_NORMAL_EDITOR_UNIT_ID_KEY,
                    });
                  }
                });
              }
            }),
          });
        }
      }

      const capture = () => {
        clearTimeout(captureTimer);
        capturePending = false;
        if (editableRef.current) {
          session.capture(workbook.save());
        }
      };
      const syncUndo = () => {
        if (!collaboration || workbook.isCellEditing()) {
          return;
        }
        const undo = univer.__getInjector().get(IUndoRedoService);
        undo.clearUndoRedo(workbook.getId());
        for (
          let i = 0;
          i < collaboration.undoCount + collaboration.redoCount;
          i++
        ) {
          undo.pushUndoRedo({
            unitID: workbook.getId(),
            undoMutations: [],
            redoMutations: [],
          });
        }
        for (let i = 0; i < collaboration.redoCount; i++) {
          undo.popUndoToRedo();
        }
      };
      const applyRemote = () => {
        if (
          !alive ||
          !collaboration ||
          collaboration.conflict ||
          applyingRemote
        ) {
          return;
        }
        if (workbook.isCellEditing() || capturePending) {
          remotePending = true;
          return;
        }
        remotePending = false;
        applyingRemote = true;
        try {
          const next = collaboration.snapshot();
          const activeSheet = workbook.getActiveSheet();
          const cell = workbook.getActiveCell()?.getRange();
          const position = collaboration.locate(
            activeSheet.getSheetId(),
            cell?.startRow ?? 0,
            cell?.startColumn ?? 0
          );
          const scroll = activeSheet.getScrollState();
          if (!patchTableCells(univerAPI, workbook, sharedSnapshot, next)) {
            const sheetId = activeSheet.getSheetId();
            clearHighlights();
            autoHeightTasks.cancel();
            univerAPI.disposeUnit(workbook.getId());
            workbook = univerAPI.createWorkbook(next);
            const sheet =
              workbook.getSheetBySheetId(sheetId) ?? workbook.getActiveSheet();
            workbook.setActiveSheet(sheet);
            sheet.getRange(position.row, position.column).activate();
            sheet.scrollToCell(
              scroll.sheetViewStartRow,
              scroll.sheetViewStartColumn
            );
            setEditable(editableRef.current);
          }
          sharedSnapshot = next;
          collaboration.initialize(workbook.save());
          updatePresence(collaboration.peers);
          syncUndo();
        } catch (error) {
          reportEditorError(error);
        } finally {
          applyingRemote = false;
        }
      };
      if (collaboration) {
        uiDisposables.add({
          dispose: collaboration.subscribe(() => {
            queueMicrotask(applyRemote);
          }),
        });
        uiDisposables.add(
          univerAPI.addEvent(univerAPI.Event.SheetEditEnded, () => {
            if (remotePending) {
              setTimeout(applyRemote, 0);
            }
          })
        );
        const commands = univer.__getInjector().get(ICommandService);
        // This service is lazy and registers the default commands on first use.
        // Initialize it before replacing the spreadsheet undo handlers.
        univer
          .__getInjector()
          .get(IUndoRedoService)
          .clearUndoRedo(workbook.getId());
        for (const [command, direction] of [
          [UndoCommand, "undo"],
          [RedoCommand, "redo"],
        ] as const) {
          commands.unregisterCommand(command.id);
          uiDisposables.add(
            commands.registerCommand({
              ...command,
              handler: (accessor) => {
                if (workbook.isCellEditing()) {
                  return command.handler(accessor);
                }
                if (!editableRef.current || collaboration.conflict) {
                  return false;
                }
                if (capturePending) {
                  capture();
                }
                collaboration[direction]();
                applyRemote();
                return true;
              },
            })
          );
        }
      }
      const commit = async () => {
        if (!editableRef.current) {
          return;
        }
        commitMobileTextEditor();
        const wasEditing = workbook.isCellEditing();
        if (wasEditing) {
          const committed = await workbook.endEditingAsync(true);
          if (!committed) {
            throw new Error(
              t("Finish editing the current cell before continuing.")
            );
          }
        }
        if (wasEditing || capturePending || session.dirty) {
          capture();
        }
      };
      const flush = async () => {
        await commit().catch((error: unknown) => {
          reportEditorError(error);
          throw error;
        });
        if (editableRef.current) {
          await session.flush();
        }
      };
      const guard = workbook.onBeforeCommandExecute((command, options) => {
        if (
          !editableRef.current &&
          !applyingRemote &&
          command.type === CommandType.MUTATION &&
          !options?.fromCollab &&
          !options?.onlyLocal &&
          !command.id.startsWith("formula.")
        ) {
          throw new Error(t("This table is read only."));
        }
      });
      const subscription = workbook.onCommandExecuted((command, options) => {
        if (
          !editableRef.current ||
          applyingRemote ||
          options?.fromCollab ||
          command.type !== CommandType.MUTATION ||
          options?.onlyLocal ||
          command.id.startsWith("formula.")
        ) {
          return;
        }
        collaboration?.track(command);
        capturePending = true;
        clearTimeout(captureTimer);
        captureTimer = setTimeout(() => {
          try {
            capture();
            if (collaboration) {
              applyRemote();
            }
          } catch (error) {
            reportEditorError(error);
          }
        }, 0);
      });
      const setEditable = (canEdit: boolean) => {
        if (alive) {
          setReady(false);
        }
        workbook.setEditable(canEdit);
        const permission = workbook.getWorkbookPermission();
        void (
          canEdit ? permission.setEditable() : permission.setReadOnly()
        ).then(
          () => {
            if (alive && permissionsInitialized) {
              setReady(true);
            }
          },
          (error: unknown) => {
            reportEditorError(error);
          }
        );
      };
      const getSelection = () => {
        const selections = univer
          .__getInjector()
          .get(SheetsSelectionsService)
          .getCurrentSelections();
        const selection = selections[0];
        if (!alive || !selection || selections.length !== 1) {
          throw new Error(t("Select one continuous range of cells."));
        }
        const sheet = workbook.getActiveSheet();
        const range = sheet.getRange(selection.range);
        const bounds = range.getRange();
        const cellCount =
          (bounds.endRow - bounds.startRow + 1) *
          (bounds.endColumn - bounds.startColumn + 1);
        if (cellCount > 50_000) {
          throw new Error(t("Select up to 50,000 cells for this operation."));
        }
        return { range, bounds, cellCount, sheet };
      };
      const getImageTarget = () => {
        const cell = workbook.getActiveCell();
        if (!alive || !cell) {
          throw new Error(t("Select a cell first."));
        }
        const sheet = workbook.getActiveSheet();
        const sheetId = sheet.getSheetId();
        const range = cell.getRange();
        const data = sheet
          .getSheet()
          .getCellRaw(range.startRow, range.startColumn);
        return {
          sheetId,
          sheetName: sheet.getSheetName(),
          address: cell.getA1Notation(),
          row: range.startRow,
          column: range.startColumn,
          selection: collaboration?.selection(sheetId, range, false),
          content: JSON.stringify(data),
          occupied: !!(
            data?.f ||
            data?.p ||
            data?.si ||
            (data?.v !== undefined && data.v !== null && data.v !== "")
          ),
          image: getTableCellImage(data),
          size: getTableCellImageSize(data),
        };
      };
      const runtime: TableRuntime = {
        prepareFreeze: () => {
          const sheet = workbook.getActiveSheet();
          const range = workbook.getActiveRange()?.getA1Notation();
          const activeCell = workbook.getActiveCell();
          const cell = activeCell?.getA1Notation();
          const cellRange = activeCell?.getRange();
          const previousFreeze = structuredClone(sheet.getFreeze());
          const assertTarget = () => {
            if (!alive || !editableRef.current || session.conflict) {
              throw new Error(
                t("This table is read only or no longer available.")
              );
            }
            const currentSheet = workbook.getActiveSheet();
            if (
              currentSheet.getSheetId() !== sheet.getSheetId() ||
              workbook.getActiveRange()?.getA1Notation() !== range ||
              workbook.getActiveCell()?.getA1Notation() !== cell
            ) {
              throw new Error(t("The selection changed. Select it again."));
            }
            if (!equal(currentSheet.getFreeze(), previousFreeze)) {
              throw new Error(
                t("The freeze settings changed. Open the freeze menu again.")
              );
            }
          };
          return {
            destination: `${sheet.getSheetName()} · ${cell ?? range ?? ""}`,
            frozenRows: Math.max(0, previousFreeze.ySplit),
            frozenColumns: Math.max(0, previousFreeze.xSplit),
            apply: async (mode) => {
              assertTarget();
              await commit();
              assertTarget();
              if (mode === "selection" && !cellRange) {
                throw new Error(t("Select a cell first."));
              }
              const rows =
                mode === "firstRow"
                  ? 1
                  : mode === "selection"
                    ? Math.max(1, cellRange?.startRow ?? 0)
                    : 0;
              const columns =
                mode === "firstColumn"
                  ? 1
                  : mode === "selection"
                    ? Math.max(1, cellRange?.startColumn ?? 0)
                    : 0;
              const params = {
                unitId: workbook.getId(),
                subUnitId: sheet.getSheetId(),
                startRow: rows || -1,
                startColumn: columns || -1,
                ySplit: rows,
                xSplit: columns,
              };
              if (
                !(await univerAPI.executeCommand(
                  mode === "none"
                    ? CancelFrozenCommand.id
                    : SetFrozenCommand.id,
                  params
                ))
              ) {
                throw new Error(t("Could not update this table."));
              }
              await commit();
            },
          };
        },
        getSelectionText: () => {
          const { range } = getSelection();
          return selectionToTSV(range.getDisplayValues());
        },
        prepareClearSelection: () => {
          if (!editableRef.current || session.conflict) {
            throw new Error(
              t("This table is read only or no longer available.")
            );
          }
          const { range, bounds, cellCount, sheet } = getSelection();
          const sheetId = sheet.getSheetId();
          const previous = structuredClone(range.getCellDatas());
          const merges = structuredClone(
            sheet.getSheet().getSnapshot().mergeData ?? []
          );
          if (
            merges.some(
              (merge) =>
                merge.startRow <= bounds.endRow &&
                merge.endRow >= bounds.startRow &&
                merge.startColumn <= bounds.endColumn &&
                merge.endColumn >= bounds.startColumn
            )
          ) {
            throw new Error(
              t("Unmerge the destination cells before clearing data.")
            );
          }
          const rowCount = sheet.getMaxRows();
          const columnCount = sheet.getMaxColumns();
          return {
            destination: `${sheet.getSheetName()} · ${range.getA1Notation()}`,
            cellCount,
            apply: async () => {
              await commit();
              const destination = workbook.getSheetBySheetId(sheetId);
              if (
                !alive ||
                !editableRef.current ||
                session.conflict ||
                !destination
              ) {
                throw new Error(
                  t("This table is read only or no longer available.")
                );
              }
              const target = destination.getRange(bounds);
              if (
                rowCount !== destination.getMaxRows() ||
                columnCount !== destination.getMaxColumns() ||
                !equal(previous, target.getCellDatas()) ||
                !equal(
                  merges,
                  destination.getSheet().getSnapshot().mergeData ?? []
                )
              ) {
                throw new Error(
                  t(
                    "The selection changed. Select the cells again before clearing their contents."
                  )
                );
              }
              target.setValues(clearTableSelectionValues(previous));
              if (
                target
                  .getCellDatas()
                  .some((row) =>
                    row.some(
                      (cell) =>
                        (cell?.v !== null && cell?.v !== undefined) ||
                        cell?.f ||
                        cell?.p ||
                        cell?.si ||
                        cell?.custom?.outlineImage
                    )
                  )
              ) {
                throw new Error(
                  t(
                    "Could not clear this selection. Check the destination editing permissions."
                  )
                );
              }
              await commit();
            },
          };
        },
        getPasteTarget: () => {
          const sheet = workbook.getActiveSheet();
          const selection = workbook.getActiveRange()?.getRange();
          if (!selection || !editableRef.current || session.conflict) {
            return undefined;
          }
          const sheetId = sheet.getSheetId();
          const { startRow, startColumn } = selection;
          return {
            prepare: (data) => {
              const currentSheet = workbook.getSheetBySheetId(sheetId);
              if (
                !alive ||
                !editableRef.current ||
                session.conflict ||
                !currentSheet ||
                startRow + data.rowCount > currentSheet.getMaxRows() ||
                startColumn + data.columnCount > currentSheet.getMaxColumns()
              ) {
                throw new Error(
                  t(
                    "This paste exceeds the worksheet size or the destination is no longer editable."
                  )
                );
              }
              const range = currentSheet.getRange(
                startRow,
                startColumn,
                data.rowCount,
                data.columnCount
              );
              const bounds = range.getRange();
              const merges = structuredClone(
                currentSheet.getSheet().getSnapshot().mergeData ?? []
              );
              if (
                merges.some(
                  (merge) =>
                    merge.startRow <= bounds.endRow &&
                    merge.endRow >= bounds.startRow &&
                    merge.startColumn <= bounds.endColumn &&
                    merge.endColumn >= bounds.startColumn
                )
              ) {
                throw new Error(
                  t("Unmerge the destination cells before pasting data.")
                );
              }
              const previous = structuredClone(range.getCellDatas());
              const rowCount = currentSheet.getMaxRows();
              const columnCount = currentSheet.getMaxColumns();
              const { values, occupiedCells } = buildTablePasteValues(
                data,
                previous
              );
              return {
                destination: `${currentSheet.getSheetName()} · ${range.getA1Notation()}`,
                occupiedCells,
                apply: async () => {
                  await commit();
                  const destination = workbook.getSheetBySheetId(sheetId);
                  if (
                    !alive ||
                    !editableRef.current ||
                    session.conflict ||
                    !destination
                  ) {
                    throw new Error(
                      t("This table is read only or no longer available.")
                    );
                  }
                  const target = destination.getRange(
                    startRow,
                    startColumn,
                    data.rowCount,
                    data.columnCount
                  );
                  if (
                    rowCount !== destination.getMaxRows() ||
                    columnCount !== destination.getMaxColumns() ||
                    !equal(previous, target.getCellDatas()) ||
                    !equal(
                      merges,
                      destination.getSheet().getSnapshot().mergeData ?? []
                    )
                  ) {
                    throw new Error(
                      t(
                        "The destination changed. Preview the paste again before replacing its contents."
                      )
                    );
                  }
                  target.setValues(values);
                  const written = target.getCellDatas();
                  if (
                    !values.every((row, index) =>
                      row.every(
                        (cell, column) =>
                          written[index]?.[column]?.v === cell.v &&
                          !written[index]?.[column]?.f &&
                          !written[index]?.[column]?.p &&
                          !written[index]?.[column]?.si
                      )
                    )
                  ) {
                    throw new Error(
                      t(
                        "Could not paste this data. Check the destination editing permissions."
                      )
                    );
                  }
                  await commit();
                },
              };
            },
          };
        },
        importCSV: async (data, name) => {
          await commit();
          if (!alive || !editableRef.current || session.conflict) {
            throw new Error(
              t("This table is read only or no longer available.")
            );
          }
          const snapshot = workbook.save();
          const sheet = mergeWorksheetSnapshotWithDefault(
            createCSVWorksheet(
              data,
              name,
              workbook.getSheets().map((item) => item.getSheetName())
            )
          );
          const id = uuid();
          const candidate = {
            ...snapshot,
            sheetOrder: [...snapshot.sheetOrder, id],
            sheets: { ...snapshot.sheets, [id]: { ...sheet, id } },
          };
          // Validate the complete document limit before executing any mutation.
          tableDocumentToMarkdown({
            format: "outline-table",
            version: 2,
            workbook: candidate,
          });
          workbook.insertSheet(sheet.name, { sheet: { ...sheet, id } });
          await commit();
        },
        exportCSV: async () => {
          await commit();
          if (!alive) {
            throw new Error(t("This table is no longer available."));
          }
          const sheet = workbook.getActiveSheet();
          return {
            name: sheet.getSheetName(),
            text: worksheetToCSV(sheet.getSheet().getSnapshot()),
          };
        },
        commit,
        flush,
        setEditable,
        setDarkMode: (dark) => univerAPI.toggleDarkMode(dark),
        setScriptsAvailable: scriptMenu?.setAvailable,
        updatePresence,
        images: {
          subscribeViewRequest: (listener) => {
            const subscription = univerAPI.addEvent(
              univerAPI.Event.BeforeSheetEditStart,
              (event) => {
                if (
                  getTableCellImage(
                    event.worksheet
                      .getSheet()
                      .getCellRaw(event.row, event.column)
                  )
                ) {
                  event.cancel = true;
                  listener();
                }
              }
            );
            return () => subscription.dispose();
          },
          getSelectedImage: () => {
            if (!alive || !workbook.getActiveCell()) {
              return;
            }
            const selections = univer
              .__getInjector()
              .get(SheetsSelectionsService)
              .getCurrentSelections();
            if (
              selections.length !== 1 ||
              selections[0].range.rangeType === RANGE_TYPE.ROW ||
              selections[0].range.rangeType === RANGE_TYPE.COLUMN
            ) {
              return;
            }
            const target = getImageTarget();
            return target.image ? target : undefined;
          },
          subscribeSelection: (listener) => {
            const subscriptions = [
              univerAPI.addEvent(univerAPI.Event.SelectionChanged, listener),
              univerAPI.addEvent(univerAPI.Event.SheetValueChanged, listener),
              univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, listener),
              univer
                .__getInjector()
                .get(ICommandService)
                .onCommandExecuted((command) => {
                  if (command.type === CommandType.MUTATION) {
                    listener();
                  }
                }),
            ];
            return () =>
              subscriptions.forEach((subscription) => subscription.dispose());
          },
          getTarget: async () => {
            if (!alive) {
              throw new Error(t("This table is no longer available."));
            }
            await commit();
            if (!alive) {
              throw new Error(t("This table is no longer available."));
            }
            return getImageTarget();
          },
          setImage: async (target, image, size) => {
            if (!alive || !editableRef.current || session.conflict) {
              throw new Error(
                t("This table is read only or no longer available.")
              );
            }
            await commit();
            if (!alive || !editableRef.current || session.conflict) {
              throw new Error(
                t("This table is read only or no longer available.")
              );
            }
            const range = target.selection
              ? collaboration?.selectionRange(target.selection)
              : undefined;
            const sheet = workbook.getSheetBySheetId(target.sheetId);
            if (!sheet || (target.selection && !range)) {
              throw new Error(
                t("The selected cell was removed. Select a cell and try again.")
              );
            }
            const row = range?.startRow ?? target.row;
            const column = range?.startColumn ?? target.column;
            const cell = sheet.getRange(row, column);
            const data = sheet.getSheet().getCellRaw(row, column);
            if (JSON.stringify(data) !== target.content) {
              throw new Error(
                t(
                  "This cell changed. Select it again before updating its image."
                )
              );
            }
            const next =
              image && size !== undefined
                ? setTableCellImageSize(setTableCellImage(data, image), size)
                : setTableCellImage(data, image);
            cell.setValue(next);
            if (
              !equal(
                sheet.getSheet().getCellRaw(row, column)?.custom,
                next.custom
              )
            ) {
              throw new Error(
                t(
                  "Could not update this image. Check the cell editing permissions."
                )
              );
            }
            if (image) {
              const displaySize = getTableCellImageSize(next);
              const worksheet = sheet.getSheet();
              sheet.setRowHeight(
                row,
                Math.max(
                  worksheet.getRowHeight(row),
                  displaySize
                    ? displaySize.height + 8
                    : Math.min(image.height + 8, 160)
                )
              );
              sheet.setColumnWidth(
                column,
                Math.max(
                  worksheet.getColumnWidth(column),
                  displaySize
                    ? displaySize.width + 8
                    : Math.min(image.width + 8, 200)
                )
              );
            }
            await commit();
            const current = sheet.getSheet().getCellRaw(row, column);
            return {
              sheetId: sheet.getSheetId(),
              sheetName: sheet.getSheetName(),
              address: cell.getA1Notation(),
              row,
              column,
              selection: collaboration?.selection(
                sheet.getSheetId(),
                cell.getRange(),
                false
              ),
              content: JSON.stringify(current),
              occupied: false,
              image: getTableCellImage(current),
              size: getTableCellImageSize(current),
            };
          },
        },
      };
      runtimeRef.current = runtime;
      if (mobile) {
        const selections = univer.__getInjector().get(SheetsSelectionsService);
        const updateSelectionLabel = () => {
          if (!alive) {
            return;
          }
          const current = selections.getCurrentSelections();
          const selection = current[0];
          const sheet = workbook.getActiveSheet();
          const range = selection ? sheet.getRange(selection.range) : undefined;
          setSelectionLabel(
            current.length > 1
              ? t("{{ count }} ranges selected", { count: current.length })
              : range
                ? `${sheet.getSheetName()} · ${range.getA1Notation()}`
                : ""
          );
        };
        const selectionSubscription =
          selections.selectionMoveEnd$.subscribe(updateSelectionLabel);
        uiDisposables.add({
          dispose: () => selectionSubscription.unsubscribe(),
        });
        const selectionSetSubscription =
          selections.selectionSet$.subscribe(updateSelectionLabel);
        uiDisposables.add({
          dispose: () => selectionSetSubscription.unsubscribe(),
        });
        const selectionMovingSubscription =
          selections.selectionMoving$.subscribe(updateSelectionLabel);
        uiDisposables.add({
          dispose: () => selectionMovingSubscription.unsubscribe(),
        });
        uiDisposables.add(
          univerAPI.addEvent(
            univerAPI.Event.ActiveSheetChanged,
            updateSelectionLabel
          )
        );
        updateSelectionLabel();
      }
      uiDisposables.add(
        univerAPI.addEvent(univerAPI.Event.BeforeClipboardPaste, (event) => {
          if (
            workbook.isCellEditing() ||
            host.ownerDocument.activeElement?.classList.contains(
              "outline-table-mobile-text-editor"
            ) ||
            !event.text ||
            !/[\t\r\n]/.test(event.text)
          ) {
            return;
          }
          event.cancel = true;
          const target = runtime.getPasteTarget();
          if (target && alive) {
            setPasteRequest({ target, initialText: event.text });
          }
        })
      );
      if (mobile) {
        uiDisposables.add(
          univerAPI.registerUIPart(BuiltInUIPart.FOOTER, () => (
            <TableSheetControls
              host={host}
              beforeAction={commit}
              onError={reportEditorError}
            />
          ))
        );
      }
      setEditable(editableRef.current);
      // Univer hydrates permissions asynchronously after creating the workbook.
      // Apply Outline's access again afterwards so native menus stay read only.
      const permissionInitSubscription = univer
        .__getInjector()
        .get(WorkbookPermissionService)
        .unitPermissionInitStateChange$.subscribe((initialized: boolean) => {
          permissionsInitialized = initialized;
          if (alive && initialized) {
            setEditable(editableRef.current);
          }
        });
      const unregister = tableSaves.register({
        documentId: document.id,
        updateMetadata: (send) => session.updateMetadata(send),
        hasPending: () =>
          editableRef.current &&
          (session.hasPending || capturePending || workbook.isCellEditing()),
        flush,
      });
      const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        if (
          !editableRef.current ||
          (!session.hasPending && !capturePending && !workbook.isCellEditing())
        ) {
          return;
        }
        void commit().catch(reportEditorError);
        event.preventDefault();
        event.returnValue = "";
      };
      const handleOnline = () => {
        if (!session.conflict && session.hasPending) {
          void flush().catch(() => {
            /* The editor displays the save error. */
          });
        }
      };
      window.addEventListener("beforeunload", handleBeforeUnload);
      window.addEventListener("online", handleOnline);
      return () => {
        alive = false;
        permissionInitSubscription.unsubscribe();
        clearTimeout(captureTimer);
        window.removeEventListener("beforeunload", handleBeforeUnload);
        window.removeEventListener("online", handleOnline);
        unregister();
        if (runtimeRef.current === runtime) {
          runtimeRef.current = undefined;
        }
        void flush()
          .catch(() => {
            /* Keep the recoverable local draft on failure. */
          })
          .finally(() => {
            subscription.dispose();
            guard.dispose();
            dispose();
          });
      };
    } catch (error) {
      reportEditorError(error);
      dispose();
    }
    return undefined;
    // A session keeps its own snapshot and revision across live model updates.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessionLoaded]);

  useEffect(() => {
    runtimeRef.current?.setEditable(editable);
  }, [editable]);
  useEffect(() => {
    runtimeRef.current?.setDarkMode(theme.isDark);
  }, [theme.isDark]);
  useEffect(() => {
    runtimeRef.current?.setScriptsAvailable?.(scriptsAvailable);
  }, [ready, scriptsAvailable]);

  const handleCopySelection = async () => {
    if (!abilities.download) {
      return;
    }
    try {
      const text = runtimeRef.current?.getSelectionText();
      if (text === undefined) {
        return;
      }
      const copied = navigator.clipboard
        ? await navigator.clipboard.writeText(text).then(
            () => true,
            () => copy(text, { format: "text/plain" })
          )
        : copy(text, { format: "text/plain" });
      if (!copied) {
        toast.error(
          t("Could not copy this selection. Check your clipboard permissions.")
        );
        return;
      }
      toast.success(t("Copied to clipboard"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("Could not copy this selection.")
      );
    }
  };
  const handleRenameSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameRequest || !editable || !sessionLoaded || session.conflict) {
      return;
    }
    if (session.title !== renameRequest.originalTitle) {
      toast.error(t("The title changed. Open rename again."));
      return;
    }
    const title = renameRequest.value.trim();
    if (!title) {
      return;
    }
    session.setTitle(title);
    setRenameRequest(undefined);
    void handleSave();
  };
  const handleClearSelection = () => {
    try {
      const operation = runtimeRef.current?.prepareClearSelection();
      if (!operation) {
        return;
      }
      dialogs.openModal({
        title: t("Clear selection"),
        content: (
          <ConfirmationDialog
            danger
            submitText={t("Clear contents")}
            onSubmit={operation.apply}
          >
            {t(
              "Clear the contents and images in {{ destination }} ({{ count }} cells)? Cell formatting will be preserved.",
              { destination: operation.destination, count: operation.cellCount }
            )}
          </ConfirmationDialog>
        ),
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("Could not clear this selection.")
      );
    }
  };

  const handleDownload = useCallback(async () => {
    try {
      await runtimeRef.current?.commit();
      download(
        tableDocumentToMarkdown(session.table),
        `${session.title || t("Untitled")}.md`,
        "text/markdown"
      );
    } catch (error) {
      reportEditorError(error);
    }
  }, [reportEditorError, session, t]);

  const handleReload = useCallback(() => {
    dialogs.openModal({
      title: t("Reload server version"),
      content: (
        <ConfirmationDialog
          submitText={t("Reload")}
          danger
          onSubmit={async () => {
            const latest = await document.store.fetch(document.id, {
              force: true,
            });
            session.discard();
            if (latest.tableContent) {
              setSession(createSession(latest.tableContent));
            }
          }}
        >
          {t(
            "Your unsaved local changes will be discarded. Download a local copy first if you want to keep them."
          )}
        </ConfirmationDialog>
      ),
    });
  }, [createSession, dialogs, document, session, t]);

  const handleSaveCopy = useCallback(async () => {
    try {
      await runtimeRef.current?.commit();
      const copy = await document.store.create(
        {
          title: t("{{title}} (local copy)", {
            title: session.title || t("Untitled"),
          }),
          collectionId: document.collectionId,
          parentDocumentId: document.parentDocumentId,
          fullWidth: true,
        },
        {
          text: tableDocumentToMarkdown(session.table),
          publish: !!document.collectionId,
        }
      );
      session.discard();
      history.push(documentPath(copy));
    } catch (error) {
      reportEditorError(error);
    }
  }, [document, history, reportEditorError, session, t]);

  const handleCloseSplitPane = useCallback(() => {
    closeSplitPane(appHistory, pane);
  }, [pane]);

  const state = !editable
    ? "readonly"
    : session.conflict
      ? "conflict"
      : session.error
        ? "error"
        : !sessionLoaded || !ready
          ? "loading"
          : session.isSaving
            ? "saving"
            : session.dirty || cellEditing
              ? "pending"
              : "saved";
  const status = !editable
    ? t("Read only")
    : session.conflict
      ? t("Save conflict")
      : session.error
        ? t("Not saved")
        : !sessionLoaded || !ready
          ? t("Loading…")
          : session.isSaving
            ? t("Saving…")
            : session.dirty || cellEditing
              ? t("Unsaved changes")
              : t("All changes saved");

  return (
    <Workspace
      ref={workspaceRef}
      data-table-document={document.id}
      data-table-mobile={mobile}
      data-table-save-state={state}
    >
      {mobile && <MobileViewportStyles />}
      {mobile && <MobileNativeEditorStyles />}
      <PageTitle title={session.title || t("Untitled")} />
      <Prompt when={editable} message={TABLE_SAVE_PROMPT} />
      <Toolbar
        data-table-toolbar
        $mobile={mobile}
        $home={homeToolsVisible || cellEditing}
      >
        <TitleArea data-table-title-area>
          {!shareId && (
            <SidebarButton
              aria-label={t("Open sidebar")}
              icon={<MenuIcon />}
              neutral
              onClick={ui.toggleMobileSidebar}
            />
          )}
          <TitleDetails>
            <TitleInput
              ref={titleRef}
              aria-label={t("Document title")}
              maxLength={DocumentValidation.maxTitleLength}
              placeholder={t("Untitled")}
              title={session.title || t("Untitled")}
              value={session.title}
              readOnly={!editable || !sessionLoaded || mobile}
              onChange={(event) => session.setTitle(event.target.value)}
              onBlur={() => {
                if (editable && session.dirty && !session.conflict) {
                  void handleSave();
                }
              }}
            />
            <SaveStatus
              role="status"
              aria-live="polite"
              aria-atomic="true"
              title={status}
              $failed={state === "error" || state === "conflict"}
              data-table-save-status
            >
              {status}
            </SaveStatus>
          </TitleDetails>
        </TitleArea>
        <NativeTools
          ref={toolbarRef}
          data-table-native-tools
          className={theme.isDark ? "univer-dark" : undefined}
          aria-label={t("Table tools")}
        />
        <CellActions
          $mobile={mobile}
          $visible={!mobile || homeToolsVisible || cellEditing}
          role="group"
          aria-label={t("Selection tools")}
          data-table-cell-tools
        >
          {mobile && editable && (
            <Button
              neutral
              icon={<TableIcon />}
              aria-label={t("Freeze")}
              title={t("Freeze")}
              disabled={!ready || cellEditing || session.conflict}
              onClick={() =>
                setFreezeTarget(runtimeRef.current?.prepareFreeze())
              }
            />
          )}
          <TableCellImageControl
            documentId={document.id}
            editable={editable}
            ready={ready && sessionLoaded}
            workspaceRef={workspaceRef}
            getController={getImageController}
            canDownload={!!abilities.download}
            mobile={mobile}
          />
          {mobile && abilities.download && (
            <Button
              neutral
              icon={<CopyIcon />}
              aria-label={t("Copy selection")}
              title={t("Copy selection")}
              disabled={!ready || cellEditing || !selectionLabel}
              onClick={handleCopySelection}
            />
          )}
          {mobile && editable && (
            <>
              <Button
                neutral
                icon={<ImportIcon />}
                aria-label={t("Paste data")}
                title={t("Paste data")}
                disabled={!ready || cellEditing || session.conflict}
                onClick={() => {
                  const target = runtimeRef.current?.getPasteTarget();
                  if (target) {
                    setPasteRequest({ target });
                  }
                }}
              />
              <Button
                neutral
                icon={<ClearContentsIcon icon={faEraser} />}
                aria-label={t("Clear contents")}
                title={t("Clear contents")}
                disabled={
                  !ready || cellEditing || session.conflict || !selectionLabel
                }
                onClick={handleClearSelection}
              />
            </>
          )}
          {editable && mobile && !cellEditing && (
            <Button
              neutral
              icon={<EditIcon />}
              aria-label={t("Edit cell")}
              title={t("Edit cell")}
              disabled={!ready || !sessionLoaded || session.conflict}
              onClick={() => mobileEditingRef.current?.start()}
            />
          )}
          {editable && mobile && cellEditing && (
            <Button
              neutral
              icon={<CloseIcon />}
              aria-label={t("Cancel editing")}
              title={t("Cancel editing")}
              disabled={!ready}
              onPointerDown={(event: PointerEvent<HTMLButtonElement>) =>
                event.preventDefault()
              }
              onMouseDown={(event: MouseEvent<HTMLButtonElement>) =>
                event.preventDefault()
              }
              onClick={() => {
                void mobileEditingRef.current?.cancel().catch((error) => {
                  toast.error(error.message);
                });
              }}
            />
          )}
          {editable && mobile && cellEditing && (
            <Button
              neutral
              icon={<CheckmarkIcon />}
              aria-label={t("Done")}
              title={t("Done")}
              disabled={!ready}
              onClick={handleSave}
            />
          )}
        </CellActions>
        <DocumentActions data-table-document-actions>
          {session instanceof TableCollaborationSession && (
            <TableCollaborators
              document={document}
              session={session}
              mobile={mobile}
            />
          )}
          {auth.user && (
            <TableDocumentMenu
              document={document}
              editable={editable}
              saveDisabled={!ready || session.isSaving || session.conflict}
              status={status}
              onSave={handleSave}
              onExportCSV={handleExportCSV}
              onImportCSV={() => setImportCSVOpen(true)}
              onPaste={() => {
                const target = runtimeRef.current?.getPasteTarget();
                if (target) {
                  setPasteRequest({ target });
                }
              }}
              onRename={
                editable
                  ? () => {
                      if (mobile) {
                        setRenameRequest({
                          originalTitle: session.title,
                          value: session.title,
                        });
                        return;
                      }
                      titleRef.current?.focus();
                      titleRef.current?.select();
                    }
                  : undefined
              }
            />
          )}
          {isSplitView && (
            <Button
              aria-label={t("Close pane")}
              icon={<CloseIcon />}
              neutral
              borderOnHover
              onClick={handleCloseSplitPane}
            />
          )}
        </DocumentActions>
      </Toolbar>
      <Notices document={document} readOnly={readOnly} />
      <Modal
        isOpen={!!renameRequest}
        onRequestClose={() => setRenameRequest(undefined)}
        title={t("Rename")}
      >
        <RenameForm onSubmit={handleRenameSubmit}>
          <Input
            label={t("Document title")}
            value={renameRequest?.value ?? ""}
            maxLength={DocumentValidation.maxTitleLength}
            placeholder={t("Untitled")}
            disabled={!editable || !sessionLoaded || session.conflict}
            onChange={(event) => {
              const value = event.target.value;
              setRenameRequest((request) =>
                request ? { ...request, value } : undefined
              );
            }}
          />
          <RenameActions>
            <Button neutral onClick={() => setRenameRequest(undefined)}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                !editable ||
                !sessionLoaded ||
                session.conflict ||
                !renameRequest?.value.trim()
              }
            >
              {t("Rename")}
            </Button>
          </RenameActions>
        </RenameForm>
      </Modal>
      <Modal
        isOpen={!!freezeTarget}
        onRequestClose={() => {
          if (!freezeRunning.current) {
            setFreezeTarget(undefined);
          }
        }}
        title={t("Freeze")}
      >
        <FreezeOptions>
          <p>{freezeTarget?.destination}</p>
          <p data-table-freeze-status>
            {t("Frozen rows: {{ rows }}; frozen columns: {{ columns }}", {
              rows: freezeTarget?.frozenRows ?? 0,
              columns: freezeTarget?.frozenColumns ?? 0,
            })}
          </p>
          {(
            [
              ["firstRow", t("Freeze first row")],
              ["firstColumn", t("Freeze first column")],
              ["selection", t("Freeze to current cell")],
              ["none", t("Unfreeze")],
            ] satisfies [TableFreezeMode, string][]
          ).map(([mode, label]) => (
            <Button
              key={mode}
              disabled={
                freezeBusy ||
                !editable ||
                session.conflict ||
                (mode === "none" &&
                  !freezeTarget?.frozenRows &&
                  !freezeTarget?.frozenColumns)
              }
              onClick={async () => {
                if (!freezeTarget || freezeRunning.current) {
                  return;
                }
                freezeRunning.current = true;
                setFreezeBusy(true);
                try {
                  await freezeTarget.apply(mode);
                  setFreezeTarget(undefined);
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : t("Could not update this table.")
                  );
                } finally {
                  freezeRunning.current = false;
                  setFreezeBusy(false);
                }
              }}
            >
              {label}
            </Button>
          ))}
          {freezeBusy && <p role="status">{t("Saving…")}</p>}
        </FreezeOptions>
      </Modal>
      {pasteRequest && (
        <Suspense fallback={null}>
          <TablePasteDialog
            target={pasteRequest.target}
            initialText={pasteRequest.initialText}
            editable={editable && ready && !session.conflict}
            onClose={() => setPasteRequest(undefined)}
          />
        </Suspense>
      )}
      {importCSVOpen && (
        <Suspense fallback={null}>
          <TableCSVImportDialog
            editable={editable && ready && !session.conflict}
            onClose={() => setImportCSVOpen(false)}
            onImport={handleImportCSV}
          />
        </Suspense>
      )}
      {editorError && (
        <Notice role="alert">
          <span>
            {t(
              "The table editor could not complete that action. Your workbook remains open."
            )}
          </span>
          <NoticeActions>
            <Button neutral onClick={() => setEditorError(false)}>
              {t("Dismiss")}
            </Button>
          </NoticeActions>
        </Notice>
      )}
      {session.error && (
        <Notice role="alert">
          <span>
            {session.conflict
              ? t(
                  "This document has a newer version. Automatic saving is paused and your local changes are preserved."
                )
              : t(
                  "Could not save this table. Your local changes are still available."
                )}
          </span>
          <NoticeActions>
            <Button neutral onClick={handleDownload}>
              {t("Download local copy")}
            </Button>
            {editable && (
              <Button neutral onClick={handleSaveCopy}>
                {t("Save as new table")}
              </Button>
            )}
            {!session.conflict && (
              <Button neutral onClick={handleSave}>
                {t("Retry")}
              </Button>
            )}
            <Button neutral onClick={handleReload}>
              {t("Reload server version")}
            </Button>
          </NoticeActions>
        </Notice>
      )}
      {session.storageFailed && (
        <Notice role="alert">
          {t(
            "Local backup is unavailable. Keep this tab open until your changes are saved."
          )}
        </Notice>
      )}
      {session.restored && !session.conflict && (
        <Notice role="status">
          {t("Recovered your unsaved local changes.")}
        </Notice>
      )}
      <Grid
        ref={containerRef}
        $ready={ready}
        aria-label={t("Spreadsheet")}
        aria-busy={!ready}
      />
      {scriptsAvailable && scriptSession.mode && (
        <Suspense fallback={null}>
          <ScriptPanel
            session={scriptSession}
            maximized={scriptMaximized}
            onMaximize={() => setScriptMaximized((value) => !value)}
            returnFocusTo={scriptTrigger.current}
          />
        </Suspense>
      )}
      {children}
    </Workspace>
  );
});

const MobileViewportStyles = createGlobalStyle`
  @media screen {
    html,
    body {
      overflow: hidden;
      overflow: clip;
      overscroll-behavior-y: none;
    }

    /* The workbook owns scrolling. Keep the ordinary document's scroll frame
       from moving the table when the software keyboard changes the viewport. */
    body [data-page-scroll] {
      position: fixed;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      overflow: clip;
      overscroll-behavior: none;
    }
  }
`;

const FreezeOptions = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  button {
    min-height: 44px;
  }
`;
const RenameForm = styled.form`
  width: 100%;
  min-width: 0;
`;
const RenameActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  button {
    min-height: 44px;
  }
`;
const ClearContentsIcon = styled(FontAwesomeIcon)`
  width: 24px;
  height: 24px;
  padding: 3px;
  box-sizing: border-box;
`;
const CellActions = styled.div<{ $mobile: boolean; $visible: boolean }>`
  grid-column: 3;
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  ${({ $mobile, $visible }) =>
    $mobile &&
    css`
      display: ${$visible ? "flex" : "none"};
      grid-column: 1;
      grid-row: 3;
      min-width: 0;
      padding-inline: 4px;
      border-top: 1px solid ${({ theme }) => theme.divider};
      height: 44px;
      box-sizing: border-box;
      button {
        min-width: 36px;
        min-height: 40px;
      }
    `}
`;

const Workspace = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  background: ${({ theme }) => theme.background};
  color: ${({ theme }) => theme.text};

  &[data-table-mobile="true"] {
    position: relative;
    top: var(--table-viewport-offset, 0px);
    height: var(--table-viewport-height, 100dvh);
    box-sizing: border-box;
    padding-bottom: env(safe-area-inset-bottom, 0px);

    /* The native mobile header assumes a full-screen workbook. */
    .outline-univer-host header.univer-w-screen {
      width: 100%;
      min-width: 0;
    }

    .outline-univer-host footer {
      display: flex;
      flex: none;
      min-width: 0;
      height: 40px;
    }

    .outline-univer-host footer > [role="tablist"] {
      flex: 1;
      min-width: 0;
      width: auto;
      touch-action: pan-x;
      -webkit-touch-callout: none;
    }

    footer [role="tab"][aria-selected="true"] > [aria-hidden="true"] {
      background-color: var(
        --table-sheet-active-color,
        var(--univer-blue-600)
      ) !important;
    }

    .univer-dark
      footer
      [role="tab"][aria-selected="true"]
      > [aria-hidden="true"] {
      background-color: var(
        --table-sheet-active-color,
        var(--univer-blue-400)
      ) !important;
    }

    [data-table-sheet-pressed] {
      opacity: 0.65;
    }
  }
`;
const MobileNativeEditorStyles = createGlobalStyle`
  .outline-table-mobile-text-editor {
    position: fixed;
    z-index: 1200;
    box-sizing: border-box;
    max-width: calc(100vw - 8px);
    max-height: min(40vh, 240px);
    padding: 6px 8px;
    resize: none;
    overflow: auto;
    border: 2px solid var(--univer-primary-color, #274ac7);
    border-radius: 2px;
    outline: none;
    background: ${({ theme }) => theme.background};
    color: ${({ theme }) => theme.text};
    caret-color: ${({ theme }) => theme.text};
    font: 16px/1.4 sans-serif;
    white-space: pre-wrap;
    touch-action: manipulation;
    -webkit-user-select: text;
    user-select: text;
  }
`;
const Toolbar = styled.div<{ $mobile: boolean; $home: boolean }>`
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, min(40%, 240px)) minmax(0, 1fr) auto auto;
  grid-template-rows: 48px 44px;
  align-items: center;
  flex-shrink: 0;
  box-sizing: border-box;
  border-bottom: 1px solid ${({ theme }) => theme.divider};

  @media (pointer: coarse) {
    grid-template-rows: 60px 44px;
  }

  ${({ $mobile, $home }) =>
    $mobile &&
    css`
      grid-template-columns: ${$home ? "auto" : "0px"} minmax(0, 1fr) auto;
      grid-template-rows: 60px 36px 44px;

      > [data-table-title-area] {
        grid-column: 1 / 3;
      }

      > [data-table-document-actions] {
        grid-column: 3;
      }

      && [data-u-comp="ribbon-header-menu"] {
        grid-column: 1 / -1;
        grid-row: 2;
        overflow: hidden;
      }

      && [data-table-native-tools] > .univer-grid {
        grid-column: 2 / -1;
        grid-row: 3;
        padding-inline: 0 4px;
      }
    `}
`;
const TitleArea = styled.div`
  grid-column: 1;
  grid-row: 1;
  display: flex;
  align-items: center;
  min-width: 0;
  padding-inline-start: 8px;
`;
const TitleInput = styled.input`
  flex: 1;
  width: 100%;
  min-width: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 6px;
  box-sizing: border-box;
  min-height: 28px;
  text-overflow: ellipsis;
  @media (pointer: coarse) {
    font-size: 16px;
    min-height: 44px;
  }
  &:focus {
    border-color: ${({ theme }) => theme.inputBorderFocused};
    outline: none;
  }
`;
const TitleDetails = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
`;
const SaveStatus = styled.span<{ $failed: boolean }>`
  display: block;
  min-width: 0;
  padding-inline: 6px;
  font-size: 11px;
  line-height: 14px;
  color: ${({ theme, $failed }) =>
    $failed ? theme.danger : theme.textSecondary};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const NativeTools = styled.div`
  /* The two native Ribbon rows participate in Outline's header grid. */
  display: contents;

  > [data-u-comp="ribbon-header-menu"] {
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
    height: 100%;

    [role="tablist"] {
      justify-content: flex-start;
      box-sizing: border-box;
      padding-inline: 4px;
      background: transparent !important;
      border-radius: 0;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
    }

    [role="tab"] {
      flex-shrink: 0;
      white-space: nowrap;
    }
  }

  > .univer-grid {
    grid-column: 1 / -1;
    grid-row: 2;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    height: 44px;
    padding-inline: 8px;
    border-top: 1px solid ${({ theme }) => theme.divider};
    border-bottom: 0;
  }

  [data-u-comp="ribbon-toolbar"] {
    justify-content: flex-start;
    min-width: 0;
  }

  [data-u-comp="ribbon-toolbar-more"] {
    flex-shrink: 0;
    padding-inline-start: 4px;
  }

  @media (pointer: coarse) {
    button {
      min-width: 32px;
      min-height: 40px;
    }
  }
`;
const DocumentActions = styled.div`
  grid-column: 4;
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-inline: 4px 8px;

  @media (pointer: coarse) {
    > button {
      min-width: 40px;
      min-height: 44px;
    }
  }
`;
const MobileFormulaBar = styled(FormulaBar)`
  min-width: 0;
  min-height: 44px;

  > div:first-child {
    width: 72px;
    flex-shrink: 0;
  }

  > div:nth-child(2) {
    min-width: 0;

    > div:last-child > div:last-child {
      min-width: 32px;
      flex-shrink: 0;
    }
  }

  [data-u-comp="defined-name"] {
    width: 100%;

    input {
      font-size: 16px;
    }
  }
`;
const SidebarButton = styled(Button)`
  flex-shrink: 0;

  @media (pointer: coarse) {
    min-width: 40px;
    min-height: 44px;
  }

  @media (min-width: 768px) {
    display: none;
  }
`;
const Notice = styled.div`
  padding: 8px 16px;
  background: ${({ theme }) => theme.backgroundSecondary};
  border-bottom: 1px solid ${({ theme }) => theme.divider};
  font-size: 14px;
`;
const NoticeActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
`;
const Grid = styled.div<{ $ready: boolean }>`
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  pointer-events: ${({ $ready }) => ($ready ? "auto" : "none")};
  > .outline-univer-host {
    position: absolute;
    inset: 0;
  }
`;
