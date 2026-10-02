import {
  CommandType,
  DisposableCollection,
  ICommandService,
  LocaleType,
} from "@univerjs/core";
import type { FWorkbook } from "@univerjs/sheets/facade";
import {
  CalculationMode,
  INTERCEPTOR_POINT,
  IRenderManagerService,
  SheetInterceptorService,
  WorkbookPermissionService,
} from "@univerjs/preset-sheets-core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { createUniver } from "@univerjs/presets";
import "@univerjs/preset-sheets-core/lib/index.css";
import { observer } from "mobx-react";
import { BackIcon, HistoryIcon } from "outline-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled, { useTheme } from "styled-components";
import { RevisionHelper } from "@shared/utils/RevisionHelper";
import {
  getTableCellImage,
  getTableCellImageSize,
} from "@shared/utils/tableCellImage";
import type { TableDocumentContent } from "@shared/utils/tableDocument";
import { restoreRevision } from "~/actions/definitions/revisions";
import Button from "~/components/Button";
import PageTitle from "~/components/PageTitle";
import Time from "~/components/Time";
import useMobile from "~/hooks/useMobile";
import usePolicy from "~/hooks/usePolicy";
import type Document from "~/models/Document";
import type Revision from "~/models/Revision";
import { documentPath, documentHistoryPath } from "~/utils/routeHelpers";
import { bindTableAutoHeightLifecycle } from "~/utils/tableAutoFit";
import {
  registerTableCellImages,
  type TableCellImageController,
} from "~/utils/tableCellImage";
import { createTablePreset } from "~/utils/tablePreset";
import { getTableWorkbook } from "~/utils/tableWorkbook";
import { TableCellImageControl } from "./TableCellImageControl";

interface Props {
  document: Document;
  revision: Revision;
  table: TableDocumentContent;
}

/**
 * Displays a detached historical workbook without collaboration or autosave.
 *
 * @param props the document, historical revision and stored table.
 * @returns a read-only workbook with worksheet navigation and a restore action.
 */
export const TableRevisionDocument = observer(function TableRevisionDocument({
  document,
  revision,
  table,
}: Props) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const mobile = useMobile();
  const can = usePolicy(document);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<FWorkbook>();
  const imageControllerRef = useRef<TableCellImageController>();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const snapshot = useMemo(
    () => getTableWorkbook(table, revision.title),
    [table, revision.title]
  );
  const [sheetId, setSheetId] = useState(snapshot.sheetOrder[0]);
  const getImageController = useCallback(() => imageControllerRef.current, []);
  const darkRef = useRef(theme.isDark);
  const setDarkModeRef = useRef<(dark: boolean) => void>();
  darkRef.current = theme.isDark;
  useEffect(() => {
    setDarkModeRef.current?.(theme.isDark);
  }, [theme.isDark]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let alive = true;
    setReady(false);
    setFailed(false);
    const host = container.ownerDocument.createElement("div");
    host.className = "outline-univer-host";
    container.appendChild(host);
    const disposables = new DisposableCollection();
    const locale = i18n.language.startsWith("zh")
      ? LocaleType.ZH_CN
      : LocaleType.EN_US;
    let disposeWorkbook = () => {};
    try {
      const { univer, univerAPI } = createUniver({
        locale,
        locales: { [LocaleType.ZH_CN]: zhCN, [LocaleType.EN_US]: enUS },
        darkMode: darkRef.current,
        presets: [createTablePreset(host, false)],
      });
      disposeWorkbook = () => univer.dispose();
      setDarkModeRef.current = (dark) => univerAPI.toggleDarkMode(dark);
      // Historical values must not be recalculated using today's date or data.
      univerAPI
        .getFormula()
        .setInitialFormulaComputing(CalculationMode.NO_CALCULATION);
      disposables.add(
        bindTableAutoHeightLifecycle(
          univer.__getInjector().get(ICommandService),
          snapshot.id
        )
      );
      const workbook = univerAPI.createWorkbook(snapshot);
      previewRef.current = workbook;
      const getImageTarget = () => {
        const cell = workbook.getActiveCell();
        if (!alive || !cell) {
          throw new Error(t("Select a cell first."));
        }
        const range = cell.getRange();
        const data = workbook
          .getActiveSheet()
          .getSheet()
          .getCellRaw(range.startRow, range.startColumn);
        return {
          sheetId: workbook.getActiveSheet().getSheetId(),
          sheetName: workbook.getActiveSheet().getSheetName(),
          address: cell.getA1Notation(),
          row: range.startRow,
          column: range.startColumn,
          content: JSON.stringify(data),
          occupied: false,
          image: getTableCellImage(data),
          size: getTableCellImageSize(data),
        };
      };
      imageControllerRef.current = {
        getTarget: async () => getImageTarget(),
        getSelectedImage: () => {
          if (!alive || !workbook.getActiveCell()) {
            return;
          }
          const target = getImageTarget();
          return target.image ? target : undefined;
        },
        subscribeSelection: (listener) => {
          const subscriptions = [
            univerAPI.addEvent(univerAPI.Event.SelectionChanged, listener),
            univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, listener),
          ];
          return () =>
            subscriptions.forEach((subscription) => subscription.dispose());
        },
        setImage: async () => {
          throw new Error(t("This table is read only."));
        },
      };
      disposables.add(
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
      disposables.add(
        workbook.onBeforeCommandExecute((command, options) => {
          if (
            command.type === CommandType.MUTATION &&
            !options?.onlyLocal &&
            !command.id.startsWith("formula.")
          ) {
            throw new Error(t("This table is read only."));
          }
        })
      );
      const setReadOnly = () => {
        workbook.setEditable(false);
        void workbook
          .getWorkbookPermission()
          .setReadOnly()
          .then(() => {
            if (alive) {
              setReady(true);
            }
          })
          .catch(() => {
            if (alive) {
              setFailed(true);
            }
          });
      };
      const subscription = univer
        .__getInjector()
        .get(WorkbookPermissionService)
        .unitPermissionInitStateChange$.subscribe((initialized: boolean) => {
          if (alive && initialized) {
            setReadOnly();
          }
        });
      disposables.add({ dispose: () => subscription.unsubscribe() });
      setReadOnly();
      setSheetId(snapshot.sheetOrder[0]);
    } catch {
      setFailed(true);
    }
    return () => {
      alive = false;
      previewRef.current = undefined;
      imageControllerRef.current = undefined;
      setDarkModeRef.current = undefined;
      disposables.dispose();
      disposeWorkbook();
      host.remove();
    };
  }, [snapshot, i18n.language, t]);

  return (
    <Workspace ref={workspaceRef} data-table-revision={revision.id}>
      <PageTitle title={revision.title} />
      <Toolbar>
        <Button
          as={Link}
          to={documentPath(document)}
          icon={<BackIcon />}
          aria-label={t("Back to current version")}
          tooltip={{ content: t("Back to current version") }}
          neutral
        />
        {mobile && (
          <Button
            as={Link}
            to={documentHistoryPath(document)}
            icon={<HistoryIcon />}
            aria-label={t("History")}
            tooltip={{ content: t("History") }}
            neutral
          />
        )}
        <Title>
          <strong>{revision.title || t("Untitled")}</strong>
          <span>
            {t("History")} ·{" "}
            <Time dateTime={revision.createdAt} relative={false} /> ·{" "}
            {revision.createdBy?.name}
          </span>
        </Title>
        <TableCellImageControl
          documentId={document.id}
          editable={false}
          ready={ready}
          workspaceRef={workspaceRef}
          getController={getImageController}
          canDownload={!!can.download}
          mobile={mobile}
        />
        {can.update &&
          !document.isArchived &&
          !document.isDeleted &&
          revision.id !== RevisionHelper.latestId(document.id) && (
            <Button action={restoreRevision} disabled={!ready} neutral>
              {t("Restore")}
            </Button>
          )}
      </Toolbar>
      {mobile && (
        <SheetSelect
          aria-label={t("Worksheet")}
          value={sheetId}
          disabled={!ready}
          onChange={(event) => {
            previewRef.current?.setActiveSheet(event.target.value);
            setSheetId(event.target.value);
          }}
        >
          {snapshot.sheetOrder.map((id) => (
            <option key={id} value={id}>
              {snapshot.sheets[id].name}
            </option>
          ))}
        </SheetSelect>
      )}
      {failed && (
        <ErrorMessage role="alert">
          {t(
            "Could not open this table version. Return to the current version and try again."
          )}
        </ErrorMessage>
      )}
      <Container ref={containerRef} aria-busy={!ready} $mobile={mobile} />
    </Workspace>
  );
});

const Workspace = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  background: ${({ theme }) => theme.background};
`;
const Toolbar = styled.div`
  display: flex;
  align-items: center;
  flex: none;
  gap: 8px;
  min-height: 64px;
  padding: 8px;
  border-bottom: 1px solid ${({ theme }) => theme.divider};
`;
const Title = styled.div`
  flex: 1;
  min-width: 0;
  > strong,
  > span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  > strong {
    font-size: 14px;
  }
  > span {
    font-size: 12px;
    color: ${({ theme }) => theme.textSecondary};
  }
`;
const SheetSelect = styled.select`
  flex: none;
  width: calc(100% - 16px);
  margin: 8px;
  min-height: 36px;
  border: 1px solid ${({ theme }) => theme.divider};
  border-radius: 4px;
  color: ${({ theme }) => theme.text};
  background: ${({ theme }) => theme.background};
`;
const Container = styled.div<{ $mobile: boolean }>`
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  .outline-univer-host {
    width: 100%;
    height: 100%;
  }
  ${({ $mobile }) =>
    $mobile && ".outline-univer-host footer { display: none; }"}
`;
const ErrorMessage = styled.p`
  padding: 8px 16px;
  color: ${({ theme }) => theme.danger};
`;
