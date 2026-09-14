import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import {
  CommandType,
  DisposableCollection,
  DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY,
  DOCS_NORMAL_EDITOR_UNIT_ID_KEY,
  LocaleType,
  ICommandService,
  IUndoRedoService,
  UndoCommand,
  RedoCommand,
  type IDisposable,
} from "@univerjs/core";
import {
  BuiltInUIPart,
  DocSelectionManagerService,
  FormulaBar,
  IEditorBridgeService,
  IEditorService,
  IMenuManagerService,
  IRenderManagerService,
  Ribbon,
  ScrollToCellOperation,
  SheetCellEditorResizeService,
  WorkbookPermissionService,
} from "@univerjs/preset-sheets-core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { createUniver } from "@univerjs/presets";
import "@univerjs/preset-sheets-core/lib/index.css";
import { observer } from "mobx-react";
import { MenuIcon } from "outline-icons";
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Prompt, useHistory } from "react-router-dom";
import styled, { createGlobalStyle, useTheme } from "styled-components";
import { isTouchDevice } from "@shared/utils/browser";
import {
  TableRosterSchema,
  type TablePresence,
} from "@shared/utils/tablePresence";
import {
  type TableDocumentContent,
  tableDocumentToMarkdown,
} from "@shared/utils/tableDocument";
import Button from "~/components/Button";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import PageTitle from "~/components/PageTitle";
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
import { documentPath } from "~/utils/routeHelpers";
import { bindTableFormulaFocus } from "~/utils/tableFormulaFocus";
import {
  bindTableMobileInput,
  observeTableViewport,
} from "~/utils/tableMobile";
import {
  configureTableMobileMenu,
  createTablePreset,
} from "~/utils/tablePreset";
import { getTableWorkbook } from "~/utils/tableWorkbook";
import { registerTableScriptMenu } from "~/utils/tableScriptMenu";
import { useTableSaveShortcut } from "../hooks/useTableSaveShortcut";
import Notices from "./Notices";
import { TableSheetControls } from "./TableSheetControls";
import { TableCollaborators } from "./TableCollaborators";

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
  commit: () => Promise<void>;
  flush: () => Promise<void>;
  setEditable: (editable: boolean) => void;
  setDarkMode: (dark: boolean) => void;
  setScriptsAvailable?: (available: boolean) => void;
  updatePresence?: (peers: TablePresence[]) => void;
}

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
  const [ready, setReady] = useState(false);
  const [cellEditing, setCellEditing] = useState(false);
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
    if (!(session instanceof TableCollaborationSession)) {
      return;
    }
    const refresh = () => {
      void session.refresh().catch(() => {
        /* Recovery is shown in the table. */
      });
    };
    const watch = () => {
      socket?.emit("table.watch", { documentId: document.id });
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
      socket?.emit("table.unwatch");
      socket?.off("authenticated", watch);
      socket?.off("table.changed", changed);
      socket?.off("table.revoked", revoked);
      socket?.off("table.roster", roster);
      socket?.off("disconnect", disconnected);
      window.removeEventListener("online", watch);
      window.removeEventListener("focus", refresh);
      session.dispose();
    };
  }, [document, session, socket]);

  const handleSave = useCallback(async () => {
    try {
      if (session instanceof TableCollaborationSession && !session.loaded) {
        await session.load();
      }
      await runtimeRef.current?.flush();
    } catch (error) {
      session.reportError(error);
    }
  }, [session]);

  useTableSaveShortcut(handleSave);

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
      let workbook = univerAPI.createWorkbook(session.table.workbook);
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
        const signature = JSON.stringify(
          peers
            .filter((peer) => peer.clientId !== socket?.id)
            .map((peer) => ({
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
        for (const peer of peers) {
          if (
            peer.clientId === socket?.id ||
            peer.selection?.sheetId !== sheet.getSheetId()
          ) {
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
          createPortal(<Ribbon ribbonType="classic" />, toolbar)
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
        uiDisposables.add(input);
        uiDisposables.add(
          univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, (event) => {
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
          session.reportError(error);
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
        try {
          await commit();
          if (editableRef.current) {
            await session.flush();
          }
        } catch (error) {
          session.reportError(error);
          throw error;
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
            session.reportError(error);
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
            session.reportError(error);
          }
        );
      };
      const runtime: TableRuntime = {
        commit,
        flush,
        setEditable,
        setDarkMode: (dark) => univerAPI.toggleDarkMode(dark),
        setScriptsAvailable: scriptMenu?.setAvailable,
        updatePresence,
      };
      runtimeRef.current = runtime;
      if (mobile) {
        uiDisposables.add(
          univerAPI.registerUIPart(BuiltInUIPart.FOOTER, () => (
            <TableSheetControls
              host={host}
              beforeAction={commit}
              onError={(error) => session.reportError(error)}
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
        void commit().catch((error: unknown) => session.reportError(error));
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
        session.dispose();
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
            session.dispose();
            dispose();
          });
      };
    } catch (error) {
      session.reportError(error);
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

  const handleDownload = useCallback(async () => {
    try {
      await runtimeRef.current?.commit();
      download(
        tableDocumentToMarkdown(session.table),
        `${session.title || t("Untitled")}.md`,
        "text/markdown"
      );
    } catch (error) {
      session.reportError(error);
    }
  }, [session, t]);

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
      session.reportError(error);
    }
  }, [document, history, session, t]);

  const state = !editable
    ? "readonly"
    : session.conflict
      ? "conflict"
      : session.error
        ? "error"
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
      <PageTitle title={session.title || t("Untitled")} />
      <Prompt when={editable} message={TABLE_SAVE_PROMPT} />
      <VisuallyHidden.Root role="status" aria-live="polite">
        {status}
      </VisuallyHidden.Root>
      <Toolbar data-table-toolbar>
        <TitleArea>
          {!shareId && (
            <SidebarButton
              aria-label={t("Open sidebar")}
              icon={<MenuIcon />}
              neutral
              onClick={ui.toggleMobileSidebar}
            />
          )}
          <TitleInput
            ref={titleRef}
            aria-label={t("Document title")}
            placeholder={t("Untitled")}
            title={session.title || t("Untitled")}
            value={session.title}
            readOnly={!editable || !sessionLoaded}
            onChange={(event) => session.setTitle(event.target.value)}
            onBlur={() => {
              if (editable && session.dirty && !session.conflict) {
                void handleSave();
              }
            }}
          />
        </TitleArea>
        <NativeTools
          ref={toolbarRef}
          className={theme.isDark ? "univer-dark" : undefined}
          aria-label={t("Table tools")}
        />
        <DocumentActions>
          {session instanceof TableCollaborationSession && (
            <TableCollaborators
              document={document}
              session={session}
              mobile={mobile}
            />
          )}
          {editable && mobile && cellEditing && (
            <Button neutral disabled={!ready} onClick={handleSave}>
              {t("Done")}
            </Button>
          )}
          {auth.user && (
            <TableDocumentMenu
              document={document}
              editable={editable}
              saveDisabled={!ready || session.isSaving || session.conflict}
              status={status}
              onSave={handleSave}
              onRename={
                editable
                  ? () => {
                      titleRef.current?.focus();
                      titleRef.current?.select();
                    }
                  : undefined
              }
            />
          )}
        </DocumentActions>
      </Toolbar>
      <Notices document={document} readOnly={readOnly} />
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

const Workspace = styled.div`
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
const Toolbar = styled.div`
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, min(40%, 240px)) minmax(0, 1fr) auto;
  grid-template-rows: 48px 44px;
  align-items: center;
  flex-shrink: 0;
  box-sizing: border-box;
  border-bottom: 1px solid ${({ theme }) => theme.divider};
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
  padding: 6px;
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
  grid-column: 3;
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
