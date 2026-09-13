import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { observer } from "mobx-react";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { depths } from "@shared/styles";
import {
  TableScriptLimits,
  type TableScriptRunStatus,
} from "@shared/types/tableScript";
import Button from "~/components/Button";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import useStores from "~/hooks/useStores";
import type { TableScriptSession } from "~/stores/TableScriptsStore";
import { download } from "~/utils/download";
import { previewTableScriptCron } from "~/utils/tableScriptCron";
import { TableScriptCronPicker } from "./TableScriptCronPicker";
import {
  handleTablePythonEscape,
  TablePythonEditor,
} from "./TablePythonEditor";

interface Props {
  session: TableScriptSession;
  maximized: boolean;
  onMaximize: () => void;
  returnFocusTo: Element | null;
}

/**
 * Provides Python editing and schedules in a maximizable desktop dialog.
 *
 * @param props the transient session, sizing controls and focus restoration target.
 * @returns a modal editor that preserves the native workbook underneath it.
 */
export const TableScriptPanel = observer(function TableScriptPanel({
  session,
  maximized,
  onMaximize,
  returnFocusTo,
}: Props) {
  const { t, i18n } = useTranslation();
  const { dialogs } = useStores();
  const zh = i18n.language.startsWith("zh");
  const title = zh ? "开发（Python）" : t("Development (Python)");
  const scheduleLabel = zh ? "定时任务" : t("Scheduled tasks");
  const schedule = session.mode === "schedule";
  const mode = schedule ? "schedule" : "development";
  const schedulePreview = useMemo(
    () => previewTableScriptCron(session.cron, session.timezone),
    [session.cron, session.timezone]
  );
  const scheduleInvalid = schedulePreview.length === 0;
  const handleCronChange = useCallback(
    (cron: string) => session.edit({ cron }),
    [session]
  );
  const handleModeChange = useCallback(
    (value: string) => {
      if (value === "development" || value === "schedule") {
        session.setMode(value);
      }
    },
    [session]
  );
  const handleClose = useCallback(() => session.setMode(undefined), [session]);
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        handleClose();
      }
    },
    [handleClose]
  );
  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      if (returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected) {
        returnFocusTo.focus({ preventScroll: true });
      }
    },
    [returnFocusTo]
  );
  const handleAction = useCallback((action: () => Promise<void>) => {
    void action().catch(() => {
      /* The session displays the request error. */
    });
  }, []);

  const handleSave = useCallback(() => {
    if (schedule && scheduleInvalid) {
      return;
    }
    handleAction(() => (schedule ? session.saveSchedule() : session.save()));
  }, [handleAction, schedule, scheduleInvalid, session]);

  const handleReplace = useCallback(
    (action: () => Promise<void>) => {
      if (!session.dirty) {
        handleAction(action);
        return;
      }
      dialogs.openModal({
        title: t("Discard changes?"),
        content: (
          <ConfirmationDialog
            danger
            submitText={t("Discard")}
            onSubmit={action}
          >
            {zh
              ? "此脚本有未保存的修改。继续将丢弃当前修改。"
              : t(
                  "This script has unsaved changes. Continuing will discard them."
                )}
          </ConfirmationDialog>
        ),
      });
    },
    [dialogs, handleAction, session, t, zh]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(
          `[data-table-script-panel="${session.documentId}"]`
        )
      ) {
        return;
      }
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        (event.code !== "KeyS" && event.key.toLowerCase() !== "s")
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        !event.repeat &&
        !event.isComposing &&
        session.selected &&
        !session.busy
      ) {
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleSave, session]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!active || document.hidden) {
        return;
      }
      void session.refreshRuns().catch(() => {
        /* A manual refresh remains available. */
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session, session.selected?.id]);

  const handleDelete = () => {
    dialogs.openModal({
      title: t("Delete script"),
      content: (
        <ConfirmationDialog
          danger
          submitText={t("Delete")}
          onSubmit={() => session.remove()}
        >
          {zh
            ? "删除此脚本，同时停用它的定时任务。"
            : t("Delete this script and disable its schedule.")}
        </ConfirmationDialog>
      ),
    });
  };

  const statusLabels: Record<TableScriptRunStatus, string> = {
    queued: zh ? "排队中" : t("Queued"),
    running: zh ? "运行中" : t("Running"),
    stopping: zh ? "停止中" : t("Stopping"),
    succeeded: zh ? "成功" : t("Succeeded"),
    failed: zh ? "失败" : t("Failed"),
    cancelled: zh ? "已停止" : t("Stopped"),
    timed_out: zh ? "已超时" : t("Timed out"),
  };
  const run = session.selectedRun;

  return (
    <Dialog.Root open={!!session.mode} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Tabs.Root value={mode} onValueChange={handleModeChange} asChild>
          <Panel
            $maximized={maximized}
            data-table-script-panel={session.documentId}
            data-table-script-maximized={maximized}
            aria-describedby={undefined}
            onCloseAutoFocus={handleCloseAutoFocus}
            onEscapeKeyDown={handleTablePythonEscape}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Heading>
              <VisuallyHidden.Root asChild>
                <Dialog.Title asChild>
                  <strong>{schedule ? scheduleLabel : title}</strong>
                </Dialog.Title>
              </VisuallyHidden.Root>
              <ModeTabs aria-label={zh ? "开发工具" : t("Development tools")}>
                <ModeTab value="development">{title}</ModeTab>
                <ModeTab value="schedule">{scheduleLabel}</ModeTab>
              </ModeTabs>
              <Spacer />
              <Button neutral onClick={onMaximize} aria-pressed={maximized}>
                {maximized
                  ? zh
                    ? "恢复窗口"
                    : t("Restore window")
                  : zh
                    ? "最大化"
                    : t("Maximize")}
              </Button>
              <Button neutral onClick={handleClose} aria-label={t("Close")}>
                {t("Close")}
              </Button>
            </Heading>
            {!session.capabilities?.executionEnabled && (
              <Message role="status">
                {zh
                  ? "隔离执行服务尚未配置。可以编辑和保存脚本，暂时无法运行或启用定时任务。"
                  : t(
                      "The isolated execution service is not configured. You can edit and save scripts; execution and schedules are unavailable."
                    )}
              </Message>
            )}
            {(session.error || session.conflict) && (
              <Message role="alert">
                {session.conflict
                  ? zh
                    ? "脚本已被其他人修改，当前草稿已保留。请先下载副本，再重新加载。"
                    : t(
                        "The script changed on the server. Your draft is preserved. Download a copy before reloading."
                      )
                  : session.error}
                {session.selected && (
                  <Button
                    neutral
                    onClick={() =>
                      download(
                        session.source,
                        session.name || "script.py",
                        "text/x-python"
                      )
                    }
                  >
                    {t("Download")}
                  </Button>
                )}
                {session.conflict && session.selected && (
                  <Button
                    neutral
                    disabled={session.busy}
                    onClick={() => {
                      const id = session.selected?.id;
                      if (id) {
                        handleReplace(() => session.select(id));
                      }
                    }}
                  >
                    {t("Reload")}
                  </Button>
                )}
              </Message>
            )}
            <Body value={mode} tabIndex={-1}>
              <ScriptList aria-label={zh ? "脚本列表" : t("Scripts")}>
                <Button
                  neutral
                  disabled={
                    session.busy ||
                    session.scripts.length >=
                      TableScriptLimits.scriptsPerDocument
                  }
                  onClick={() => handleReplace(() => session.create())}
                >
                  ＋ {t("New")}
                </Button>
                {session.scripts.map((script) => (
                  <ScriptButton
                    key={script.id}
                    type="button"
                    aria-current={
                      session.selected?.id === script.id ? "true" : undefined
                    }
                    disabled={session.busy}
                    onClick={() => {
                      if (script.id !== session.selected?.id) {
                        handleReplace(() => session.select(script.id));
                      }
                    }}
                    title={script.name}
                  >
                    <span>{script.name}</span>
                    {script.scheduleEnabled && (
                      <small aria-label={scheduleLabel}>◷</small>
                    )}
                  </ScriptButton>
                ))}
              </ScriptList>
              <EditorArea>
                {session.selected ? (
                  <>
                    <Actions>
                      <NameInput
                        aria-label={zh ? "脚本名称" : t("Script name")}
                        value={session.name}
                        readOnly={schedule}
                        maxLength={100}
                        onChange={(event) =>
                          session.edit({ name: event.target.value })
                        }
                      />
                      <Button
                        neutral
                        disabled={
                          session.busy ||
                          session.conflict ||
                          (schedule
                            ? !session.scheduleDirty || scheduleInvalid
                            : !session.codeDirty)
                        }
                        onClick={handleSave}
                      >
                        {session.busy ? t("Saving…") : t("Save")}
                      </Button>
                      {!schedule && (
                        <Button
                          disabled={
                            session.busy ||
                            session.conflict ||
                            !!session.activeRun ||
                            !session.capabilities?.executionEnabled
                          }
                          onClick={() => handleAction(() => session.run())}
                        >
                          {zh ? "运行" : t("Run")}
                        </Button>
                      )}
                      <Button
                        neutral
                        disabled={
                          session.busy ||
                          !session.activeRun ||
                          session.activeRun.status === "stopping"
                        }
                        onClick={() => handleAction(() => session.stop())}
                      >
                        {zh ? "停止" : t("Stop")}
                      </Button>
                      <Button
                        neutral
                        disabled={
                          session.busy ||
                          session.conflict ||
                          !!session.activeRun
                        }
                        onClick={handleDelete}
                        aria-label={t("Delete script")}
                      >
                        ×
                      </Button>
                    </Actions>
                    {schedule ? (
                      <ScheduleForm
                        onSubmit={(event) => {
                          event.preventDefault();
                          handleSave();
                        }}
                      >
                        <TableScriptCronPicker
                          key={session.selected.id}
                          value={session.cron}
                          onChange={handleCronChange}
                        />
                        <label>
                          {zh ? "时区" : t("Timezone")}
                          <Field
                            value={session.timezone}
                            maxLength={100}
                            placeholder="Asia/Shanghai"
                            onChange={(event) =>
                              session.edit({ timezone: event.target.value })
                            }
                          />
                        </label>
                        <Preview aria-live="polite">
                          {scheduleInvalid ? (
                            <span role="status">
                              {session.cron.trim().length > 100
                                ? zh
                                  ? "规则过长，请使用间隔或范围缩短选择。"
                                  : t(
                                      "This rule is too long. Use intervals or ranges to shorten it."
                                    )
                                : zh
                                  ? "当前规则或时区无效，无法计算执行时间。请调整后再保存。"
                                  : t(
                                      "This rule or timezone has no valid execution time. Adjust it before saving."
                                    )}
                            </span>
                          ) : (
                            <>
                              <strong>
                                {zh
                                  ? "接下来三次执行时间"
                                  : t("Next three occurrences")}{" "}
                                ({session.timezone})
                              </strong>
                              <ol>
                                {schedulePreview.map((date) => (
                                  <li key={date.toISOString()}>
                                    {date.toLocaleString(i18n.language, {
                                      timeZone: session.timezone,
                                      year: "numeric",
                                      month: "2-digit",
                                      day: "2-digit",
                                      weekday: "short",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                      hourCycle: "h23",
                                      timeZoneName: "shortOffset",
                                    })}
                                  </li>
                                ))}
                              </ol>
                              <Hint>
                                {zh
                                  ? "按当前选择预览，保存并启用后生效。"
                                  : t(
                                      "Preview of your current selection. Save and enable the schedule to apply it."
                                    )}
                              </Hint>
                            </>
                          )}
                        </Preview>
                        <label>
                          <input
                            type="checkbox"
                            checked={session.scheduleEnabled}
                            disabled={
                              !session.capabilities?.executionEnabled &&
                              !session.selected.scheduleEnabled
                            }
                            onChange={(event) =>
                              session.edit({
                                scheduleEnabled: event.target.checked,
                              })
                            }
                          />{" "}
                          {zh ? "启用定时任务" : t("Enable schedule")}
                        </label>
                        <Hint>
                          {zh
                            ? "使用已保存的脚本和执行时的表格数据。关闭网页后仍会执行；失败不会自动重试。"
                            : t(
                                "Runs the saved script with the spreadsheet data available at execution, even when this page is closed. Failed runs are not retried."
                              )}
                        </Hint>
                        {session.selected.nextRunAt && (
                          <p>
                            {zh
                              ? "已保存计划的下次执行："
                              : t("Next run of the saved schedule:")}{" "}
                            {new Date(
                              session.selected.nextRunAt
                            ).toLocaleString(i18n.language, {
                              timeZone: session.selected.timezone,
                            })}{" "}
                            ({session.selected.timezone})
                          </p>
                        )}
                        {session.codeDirty && (
                          <Message>
                            {zh
                              ? "代码尚未保存。定时任务将继续使用上次保存的代码。"
                              : t(
                                  "Your code has unsaved changes. Scheduled runs will use the last saved version."
                                )}
                          </Message>
                        )}
                      </ScheduleForm>
                    ) : (
                      <TablePythonEditor
                        key={session.selected.id}
                        value={session.source}
                        onChange={(value) => session.setSource(value)}
                      />
                    )}
                    <Console>
                      <ConsoleHeading>
                        <strong>
                          {zh ? "运行记录 / 输出" : t("Run history / Output")}
                        </strong>
                        <Spacer />
                        <Button
                          neutral
                          onClick={() =>
                            handleAction(() => session.refreshRuns())
                          }
                        >
                          {t("Refresh")}
                        </Button>
                      </ConsoleHeading>
                      {session.runs.length > 0 && (
                        <RunSelect
                          aria-label={zh ? "运行记录" : t("Run history")}
                          value={run?.id ?? ""}
                          onChange={(event) =>
                            session.selectRun(event.target.value)
                          }
                        >
                          {session.runs.map((item) => (
                            <option key={item.id} value={item.id}>
                              {new Date(item.createdAt).toLocaleString(
                                i18n.language
                              )}{" "}
                              · {statusLabels[item.status]} ·{" "}
                              {item.trigger === "schedule"
                                ? scheduleLabel
                                : zh
                                  ? "手动"
                                  : t("Manual")}
                            </option>
                          ))}
                        </RunSelect>
                      )}
                      {session.hasMoreRuns && (
                        <Button
                          neutral
                          onClick={() =>
                            handleAction(() => session.refreshRuns(true))
                          }
                        >
                          {t("Load more")}
                        </Button>
                      )}
                      <Output
                        tabIndex={0}
                        aria-label={zh ? "脚本输出" : t("Script output")}
                        data-private
                      >
                        {run
                          ? run.output || statusLabels[run.status]
                          : zh
                            ? "运行脚本后在这里查看输出和错误。"
                            : t(
                                "Run a script to view its output and errors here."
                              )}
                      </Output>
                      {run && (
                        <Hint>
                          {zh ? "脚本版本" : t("Script revision")}{" "}
                          {run.scriptRevision} ·{" "}
                          {zh ? "表格版本" : t("Spreadsheet revision")}{" "}
                          {run.documentRevision ?? "—"}
                        </Hint>
                      )}
                    </Console>
                    <Status role="status">
                      {session.dirty
                        ? t("Unsaved changes")
                        : t("All changes saved")}{" "}
                      · Python 3.13 / requests ·{" "}
                      {zh ? "最长运行" : t("Time limit")}{" "}
                      {session.capabilities?.executionSeconds ?? 60}s
                    </Status>
                  </>
                ) : (
                  <Empty>
                    {session.busy
                      ? t("Loading…")
                      : zh
                        ? "点击“新建”创建 Python 脚本。"
                        : t("Create a Python script to get started.")}
                  </Empty>
                )}
              </EditorArea>
            </Body>
          </Panel>
        </Tabs.Root>
      </Dialog.Portal>
    </Dialog.Root>
  );
});

// Shared deletion/discard dialogs must appear above this editor window.
const Overlay = styled(Dialog.Overlay)`
  position: fixed;
  inset: 0;
  z-index: ${depths.overlay - 2};
  background: ${({ theme }) => theme.modalBackdrop};
`;
const Panel = styled(Dialog.Content)<{ $maximized: boolean }>`
  position: fixed;
  inset: 0;
  margin: auto;
  z-index: ${depths.overlay - 1};
  width: ${({ $maximized }) =>
    $maximized ? "100%" : "min(1200px, calc(100% - 64px))"};
  height: ${({ $maximized }) =>
    $maximized ? "100vh" : "min(840px, calc(100vh - 64px))"};
  height: ${({ $maximized }) =>
    $maximized ? "100dvh" : "min(840px, calc(100dvh - 64px))"};
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  outline: none;
  background: ${({ theme }) => theme.background};
  color: ${({ theme }) => theme.text};
  border: ${({ $maximized, theme }) =>
    $maximized ? "0" : `1px solid ${theme.divider}`};
  border-radius: ${({ $maximized }) => ($maximized ? 0 : 10)}px;
  box-shadow: ${({ theme }) => theme.modalShadow};
  font-size: 13px;
`;
const Heading = styled.header`
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 0 12px;
  border-bottom: 1px solid ${({ theme }) => theme.divider};
`;
const Spacer = styled.span`
  flex: 1;
`;
const ModeTabs = styled(Tabs.List)`
  display: flex;
  align-self: stretch;
  flex-shrink: 0;
  gap: 20px;
`;
const ModeTab = styled(Tabs.Trigger)`
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: ${({ theme }) => theme.textSecondary};
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  cursor: var(--pointer);

  &[data-state="active"],
  &:hover {
    color: ${({ theme }) => theme.accent};
  }

  &[data-state="active"]::after {
    content: "";
    position: absolute;
    bottom: -1px;
    inset-inline: 0;
    height: 2px;
    border-radius: 2px;
    background: currentColor;
  }

  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.inputBorderFocused};
    outline-offset: -4px;
    border-radius: 4px;
  }
`;
const Message = styled.div`
  display: flex;
  flex-shrink: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  background: ${({ theme }) => theme.backgroundSecondary};
  line-height: 1.5;
`;
const Body = styled(Tabs.Content)`
  display: flex;
  flex: 1;
  min-height: 0;
  border-top: 1px solid ${({ theme }) => theme.divider};
`;
const ScriptList = styled.nav`
  width: 136px;
  flex-shrink: 0;
  overflow: auto;
  padding: 8px;
  border-inline-end: 1px solid ${({ theme }) => theme.divider};
`;
const ScriptButton = styled.button`
  display: flex;
  width: 100%;
  gap: 4px;
  align-items: center;
  margin-top: 6px;
  padding: 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
  &[aria-current="true"],
  &:hover {
    background: ${({ theme }) => theme.backgroundSecondary};
  }
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
`;
const EditorArea = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
`;
const Actions = styled.div`
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px;
  align-items: center;
  border-bottom: 1px solid ${({ theme }) => theme.divider};
`;
const NameInput = styled.input`
  width: 130px;
  min-width: 80px;
  flex: 1;
  color: inherit;
  background: transparent;
  border: 1px solid ${({ theme }) => theme.inputBorder};
  border-radius: 4px;
  padding: 6px;
`;
const ScheduleForm = styled.form`
  flex: 1;
  min-height: 120px;
  padding: 16px;
  overflow: auto;
  > label {
    display: block;
    margin: 12px 0 6px;
  }
`;
const Preview = styled.div`
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid ${({ theme }) => theme.divider};
  border-radius: 5px;
  line-height: 1.6;
  ol {
    margin: 6px 0;
    padding-inline-start: 20px;
    font-variant-numeric: tabular-nums;
  }
`;
const Field = styled(NameInput)`
  display: block;
  width: 100%;
  margin-top: 6px;
  box-sizing: border-box;
`;
const Hint = styled.div`
  color: ${({ theme }) => theme.textSecondary};
  font-size: 12px;
  line-height: 1.5;
`;
const Console = styled.section`
  height: 190px;
  min-height: 130px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 6px;
  border-top: 1px solid ${({ theme }) => theme.divider};
`;
const ConsoleHeading = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;
const RunSelect = styled.select`
  width: 100%;
  padding: 4px;
  color: inherit;
  background: ${({ theme }) => theme.background};
  border: 1px solid ${({ theme }) => theme.inputBorder};
`;
const Output = styled.pre`
  flex: 1;
  min-height: 36px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font:
    12px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
`;
const Status = styled.footer`
  flex-shrink: 0;
  padding: 6px 8px;
  font-size: 11px;
  color: ${({ theme }) => theme.textSecondary};
  border-top: 1px solid ${({ theme }) => theme.divider};
`;
const Empty = styled.p`
  padding: 16px;
  color: ${({ theme }) => theme.textSecondary};
`;
