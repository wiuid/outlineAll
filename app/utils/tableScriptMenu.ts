import {
  CommandType,
  DisposableCollection,
  ICommandService,
  type Injector,
} from "@univerjs/core";
import {
  IMenuManagerService,
  MenuItemType,
} from "@univerjs/preset-sheets-core";
import { BehaviorSubject } from "rxjs";
import type { TableScriptPanelMode } from "~/stores/TableScriptsStore";

/**
 * Adds script tools through Univer's menu and command services.
 *
 * @param injector the current workbook's native service injector.
 * @param chinese whether the workbook uses the Chinese locale.
 * @param open opens the authorized Outline panel without rebuilding the workbook.
 * @returns availability updates and disposal for this workbook's lifetime.
 */
export function registerTableScriptMenu(
  injector: Injector,
  chinese: boolean,
  open: (mode: TableScriptPanelMode) => void
) {
  const disposables = new DisposableCollection();
  const hidden = new BehaviorSubject(true);
  const commands = injector.get(ICommandService);
  const menus = injector.get(IMenuManagerService);
  const entries: { id: string; mode: TableScriptPanelMode; title: string }[] = [
    {
      id: "outline.operation.table-scripts",
      mode: "development",
      title: chinese ? "开发（Python）" : "Development (Python)",
    },
    {
      id: "outline.operation.table-schedules",
      mode: "schedule",
      title: chinese ? "定时任务" : "Scheduled tasks",
    },
  ];
  for (const entry of entries) {
    disposables.add(
      commands.registerCommand({
        id: entry.id,
        type: CommandType.OPERATION,
        handler: () => {
          if (hidden.value) {
            return false;
          }
          open(entry.mode);
          return true;
        },
      })
    );
  }
  menus.appendRootMenu({
    ribbon: {
      "ribbon.advanced": {
        order: 4,
        title: chinese ? "高级" : "Advanced",
        "ribbon.advanced.scripts": {
          order: 0,
          ...Object.fromEntries(
            entries.map((entry, order) => [
              entry.id,
              {
                order,
                menuItemFactory: () => ({
                  id: entry.id,
                  title: entry.title,
                  tooltip: entry.title,
                  type: MenuItemType.BUTTON,
                  hidden$: hidden,
                }),
              },
            ])
          ),
        },
      },
    },
  });
  return {
    setAvailable: (available: boolean) => {
      hidden.next(!available);
    },
    dispose: () => {
      hidden.next(true);
      hidden.complete();
      disposables.dispose();
    },
  };
}
