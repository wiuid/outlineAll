import { UniverSheetsUIPlugin } from "@univerjs/sheets-ui";
import { describe, expect, it } from "vitest";
import {
  shouldUseMobileSheetsUI,
  withMobileSheetsUI,
} from "./mobileTablePreset";

describe("withMobileSheetsUI", () => {
  class OtherPlugin {}
  class MobilePlugin {}

  it("replaces only the desktop sheet UI plugin and preserves its configuration", () => {
    const sheetConfig = { footer: { zoomSlider: true }, toolbar: true };
    const preset = {
      plugins: [
        OtherPlugin,
        [UniverSheetsUIPlugin, sheetConfig],
      ],
    };

    const result = withMobileSheetsUI(preset, MobilePlugin as never);

    expect(result.plugins).toEqual([
      OtherPlugin,
      [MobilePlugin, sheetConfig],
    ]);
    expect(result.plugins).not.toBe(preset.plugins);
  });

  it("does not mutate a desktop preset when generating a mobile variant", () => {
    const preset = { plugins: [UniverSheetsUIPlugin] };

    withMobileSheetsUI(preset, MobilePlugin as never);

    expect(preset.plugins).toEqual([UniverSheetsUIPlugin]);
  });

  it("uses the native mobile sheet UI only for a coarse pointer viewport", () => {
    expect(shouldUseMobileSheetsUI({ coarsePointer: true })).toBe(true);
    expect(shouldUseMobileSheetsUI({ coarsePointer: false })).toBe(false);
  });
});
