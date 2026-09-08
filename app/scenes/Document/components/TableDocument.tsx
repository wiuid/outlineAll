import { createUniver } from "@univerjs/presets";
import { LocaleType } from "@univerjs/core";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import "@univerjs/preset-sheets-core/lib/index.css";
import { MenuIcon } from "outline-icons";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import Button from "~/components/Button";
import type Document from "~/models/Document";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";

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
    sheets: Record<string, { name: string; scrollTop: number; scrollLeft: number }>;
  };
  const firstSheetId = snapshot.sheetOrder[0];
  if (firstSheetId && snapshot.sheets[firstSheetId]) {
    snapshot.sheets[firstSheetId].name = "Sheet1";
    snapshot.sheets[firstSheetId].scrollTop = 0;
    snapshot.sheets[firstSheetId].scrollLeft = 0;
  }
  return snapshot;
}

const MOBILE_HEADER_WIDTH = 120;

const Workspace = styled.div`
  position: relative;
  height: 100vh;
  width: 100%;
  overflow: hidden;
  overscroll-behavior: none;

  @media (max-width: 768px) {
    height: 100dvh;
    display: block;
  }
`;

const Frame = styled.div`
  height: 100%;
  width: 100%;
  position: relative;
  overflow: hidden;
  overscroll-behavior: none;

  @media (max-width: 768px) {
    flex: none;
    min-height: 0;
    height: 100%;
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

const Header = styled.div`
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
  @media (max-width: 768px) {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 20;
    width: max-content;
    min-width: ${MOBILE_HEADER_WIDTH}px;
    max-width: 40vw;
    height: 36px;
    padding: 6px 8px;
    background: transparent;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
    pointer-events: none;
  }
`;

const MobileMenuButton = styled(Button)`
  pointer-events: auto;
  display: none;

  @media (max-width: 768px) {
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

  @media (max-width: 768px) {
    flex: 0 1 auto;
    width: auto;
    max-width: calc(40vw - 44px);
    margin-right: 4px;
  }

  &:hover {
    background: rgba(0, 0, 0, 0.06);
  }
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
  @media (max-width: 768px) {
    flex: 0 1 auto;
    width: auto;
    max-width: calc(40vw - 44px);
  }
`;

const ErrorPanel = styled.pre`
  margin: 24px;
  padding: 16px;
  white-space: pre-wrap;
  color: #b42318;
  background: #fef3f2;
  border: 1px solid #fecdca;
  border-radius: 6px;
`;

type Props = { document: Document; readOnly: boolean };

function formatError(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function TableDocument({ document, readOnly }: Props) {
  const { ui } = useStores();
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const disposeTimer = useRef<ReturnType<typeof setTimeout>>();
  const titleInputRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
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
    const nextTitle = draftTitle.trim();
    if (nextTitle === document.title.trim()) {
      setIsEditingTitle(false);
      return;
    }

    try {
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
    if (!containerRef.current) {
      return;
    }
    clearTimeout(disposeTimer.current);
    const containerElement = containerRef.current;

    try {
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_CN,
        locales: { [LocaleType.ZH_CN]: zhCN },
        presets: [
          UniverSheetsCorePreset({
            container: containerRef.current,
            toolbar: !readOnly,
            formulaBar: !readOnly,
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

      const mobileToolbarAdjustments: Array<{
        element: HTMLElement;
        marginLeft: string;
        width: string;
        overflowX: string;
        overflowY: string;
        touchAction: string;
        overscrollBehaviorX: string;
        paddingLeft: string;
        justifyContent: string;
      }> = [];
      let toolbarObserver: MutationObserver | undefined;
      let toolbarFrame = 0;
      const applyMobileToolbarOffset = () => {
        if (
          !window.matchMedia("(max-width: 768px)").matches ||
          mobileToolbarAdjustments.length
        ) {
          return;
        }
        const toolbar = containerElement.querySelector<HTMLElement>(
          '[data-u-comp="ribbon-header-menu"] > [role="tablist"]'
        );
        if (!toolbar) {
          return;
        }
        mobileToolbarAdjustments.push({
          element: toolbar,
          marginLeft: toolbar.style.marginLeft,
          width: toolbar.style.width,
          overflowX: toolbar.style.overflowX,
          overflowY: toolbar.style.overflowY,
          touchAction: toolbar.style.touchAction,
          overscrollBehaviorX: toolbar.style.overscrollBehaviorX,
          paddingLeft: toolbar.style.paddingLeft,
          justifyContent: toolbar.style.justifyContent,
        });
        const headerWidth =
          headerRef.current?.getBoundingClientRect().width ?? MOBILE_HEADER_WIDTH;
        toolbar.style.marginLeft = "0";
        toolbar.style.width = "100%";
        toolbar.style.paddingLeft = `${headerWidth}px`;
        toolbar.style.justifyContent = "flex-start";
        toolbar.style.overflowX = "auto";
        toolbar.style.overflowY = "hidden";
        toolbar.style.touchAction = "pan-x";
        toolbar.style.overscrollBehaviorX = "contain";
        toolbarObserver?.disconnect();
      };
      if (window.matchMedia("(max-width: 768px)").matches) {
        toolbarObserver = new MutationObserver(applyMobileToolbarOffset);
        toolbarObserver.observe(containerElement, {
          childList: true,
          subtree: true,
        });
        toolbarFrame = requestAnimationFrame(applyMobileToolbarOffset);
      }

      const subscription = workbook.onCommandExecuted(() => {
        if (readOnly) {
          return;
        }
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
          try {
            const tableData = workbook.save();
            await client.post("/documents.update", {
              id: document.id,
              tableData,
              done: true,
            });
            document.tableData = tableData;
          } catch (saveError) {
            setError(`表格保存失败：${formatError(saveError)}`);
            // eslint-disable-next-line no-console
            console.error("[table-page] save failed", saveError);
          }
        }, 800);
      });

      return () => {
        cancelAnimationFrame(toolbarFrame);
        toolbarObserver?.disconnect();
        mobileToolbarAdjustments.forEach(
          ({
            element,
            marginLeft,
            width,
            overflowX,
            overflowY,
            touchAction,
            overscrollBehaviorX,
            paddingLeft,
            justifyContent,
          }) => {
            element.style.marginLeft = marginLeft;
            element.style.width = width;
            element.style.overflowX = overflowX;
            element.style.overflowY = overflowY;
            element.style.touchAction = touchAction;
            element.style.overscrollBehaviorX = overscrollBehaviorX;
            element.style.paddingLeft = paddingLeft;
            element.style.justifyContent = justifyContent;
          }
        );
        clearTimeout(saveTimer.current);
        disposeTimer.current = setTimeout(() => {
          subscription?.dispose?.();
          univer.dispose();
        }, 0);
      };
    } catch (initializationError) {
      setError(`表格初始化失败：${formatError(initializationError)}`);
      // eslint-disable-next-line no-console
      console.error("[table-page] initialization failed", initializationError);
    }
    return undefined;
  }, [document, readOnly]);

  return (
    <Workspace>
      <Header ref={headerRef}>
        <MobileMenuButton
          aria-label="打开导航栏"
          icon={<MenuIcon />}
          neutral
          onClick={ui.toggleMobileSidebar}
        />
        {readOnly ? (
          <span title={displayTitle}>{displayTitle}</span>
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
      {error ? <ErrorPanel>{error}</ErrorPanel> : <Frame ref={containerRef} />}
    </Workspace>
  );
}

export default observer(TableDocument);
