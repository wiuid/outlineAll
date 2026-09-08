declare module "@univerjs/presets" {
  export function createUniver(options: any): { univer: { dispose(): void }; univerAPI: any };
}

declare module "@univerjs/preset-sheets-core" {
  export function UniverSheetsCorePreset(options?: any): any;
}

declare module "@univerjs/preset-sheets-core/lib/index.css";

declare module "@univerjs/preset-sheets-core/locales/zh-CN" {
  const locale: Record<string, unknown>;
  export default locale;
}
