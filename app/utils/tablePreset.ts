import {
  ContextMenuPosition,
  type IMenuManagerService,
  MenuItemType,
  SetTabColorCommand,
  SheetPasteCommand,
  UniverMobileUIPlugin,
  UniverSheetsCorePreset,
  UniverSheetsMobileUIPlugin,
  UniverSheetsUIPlugin,
  UniverUIPlugin,
} from "@univerjs/preset-sheets-core";

/**
 * Uses Univer's native touch UI while retaining every plugin in the core preset.
 *
 * @param container the element hosting the workbook.
 * @param mobile whether touch is the primary input method.
 * @returns the core preset with the appropriate UI plugins.
 */
export function createTablePreset(
  container: HTMLElement,
  mobile: boolean
): ReturnType<typeof UniverSheetsCorePreset> {
  const preset = UniverSheetsCorePreset({
    container,
    disableAutoFocus: true,
    // Render the native Ribbon in Outline's title row through a UI part portal.
    toolbar: false,
  });
  if (!mobile) {
    return preset;
  }

  // The core preset currently registers desktop UI plugins even on touch
  // devices. Replace those registrations and keep their existing options.
  preset.plugins = preset.plugins.map((entry) => {
    const plugin = Array.isArray(entry) ? entry[0] : entry;
    const options = Array.isArray(entry) ? entry[1] : undefined;
    if (plugin === UniverUIPlugin) {
      return [UniverMobileUIPlugin, options];
    }
    if (plugin === UniverSheetsUIPlugin) {
      return [UniverSheetsMobileUIPlugin, options];
    }
    return entry;
  });
  return preset;
}

/**
 * Adapts paste parameters and the worksheet color entry for native touch menus.
 *
 * @param menus the menu manager for this mobile workbook.
 */
export function configureTableMobileMenu(menus: IMenuManagerService): void {
  const paste = menus
    .getFlatMenuByPositionKey(ContextMenuPosition.MAIN_AREA)
    .find(({ key }) => key === SheetPasteCommand.name)?.item;
  if (paste) {
    // Univer 0.25.1's mobile dispatcher omits empty paste parameters, but its
    // permission check requires them. Retain the native permission observables.
    menus.mergeMenu({
      [SheetPasteCommand.name]: {
        menuItemFactory: () => ({ ...paste, params: paste.params ?? {} }),
      },
    });
  }

  const color = menus
    .getFlatMenuByPositionKey(ContextMenuPosition.FOOTER_TABS)
    .find(({ key }) => key === SetTabColorCommand.id)?.item;
  if (!color) {
    return;
  }
  // The desktop submenu cannot fit beside the menu on a phone. Open the same
  // registered color picker inside the mobile management panel instead.
  menus.mergeMenu({
    [SetTabColorCommand.id]: {
      menuItemFactory: () => ({ ...color, type: MenuItemType.BUTTON }),
    },
  });
}
