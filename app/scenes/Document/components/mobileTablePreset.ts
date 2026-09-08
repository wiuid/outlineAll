import type { Plugin, PluginCtor } from "@univerjs/core";
import { UniverSheetsUIPlugin } from "@univerjs/sheets-ui";

type PresetPlugin =
  | PluginCtor<Plugin>
  | [PluginCtor<Plugin>, ConstructorParameters<PluginCtor<Plugin>>[0]];

type SheetsPreset = {
  plugins: PresetPlugin[];
};

export function shouldUseMobileSheetsUI({
  coarsePointer,
}: {
  coarsePointer: boolean;
}) {
  return coarsePointer;
}

export function withMobileSheetsUI<T extends SheetsPreset>(
  preset: T,
  mobilePlugin: PluginCtor<Plugin>
): T {
  return {
    ...preset,
    plugins: preset.plugins.map((plugin) => {
      const pluginConstructor = Array.isArray(plugin) ? plugin[0] : plugin;

      if (pluginConstructor !== UniverSheetsUIPlugin) {
        return plugin;
      }

      return Array.isArray(plugin)
        ? [mobilePlugin, plugin[1]]
        : mobilePlugin;
    }),
  };
}
