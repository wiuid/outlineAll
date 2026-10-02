import { LocaleType } from "@univerjs/core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import {
  INTERCEPTOR_POINT,
  SheetInterceptorService,
  UniverSheetsNodeCorePreset,
} from "@univerjs/preset-sheets-node-core";
import { createUniver } from "@univerjs/presets";
import {
  getTableCellImage,
  setTableCellImage,
  setTableCellImageSize,
} from "@shared/utils/tableCellImage";
import {
  fitTableCellImage,
  getDefaultTableCellImageSize,
  getTableCellImageViewScale,
  registerTableCellImages,
} from "./tableCellImage";
import { createTableWorkbook } from "./tableWorkbook";

const image = {
  attachmentId: "f4a4e331-c5a5-4e78-a365-24975280b4a1",
  src: "/api/attachments.redirect?id=f4a4e331-c5a5-4e78-a365-24975280b4a1",
  name: "test.png",
  width: 640,
  height: 480,
};

describe("native cell images", () => {
  it("bounds display dimensions without reducing stored image resolution", () => {
    const original = { ...image, width: 12000, height: 3000 };
    expect(getDefaultTableCellImageSize(original)).toEqual({
      width: 2048,
      height: 512,
    });
    expect(original.width).toBe(12000);
    expect(
      getDefaultTableCellImageSize({ ...image, width: 1, height: 16000 })
    ).toEqual({ width: 1, height: 2048 });
    expect(getDefaultTableCellImageSize(image)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("fits intrinsic pixels to portrait and landscape viewports without upscaling", () => {
    expect(getTableCellImageViewScale(2400, 1600, 300, 600)).toBe(0.125);
    expect(getTableCellImageViewScale(400, 1600, 600, 300)).toBe(0.1875);
    expect(getTableCellImageViewScale(80, 60, 1200, 800)).toBe(1);
    expect(getTableCellImageViewScale(0, 60, 1200, 800)).toBe(1);
    expect(getTableCellImageViewScale(80, 60, 0, 800)).toBe(1);
  });
  it("fits portrait and landscape images inside cells and keeps their aspect ratio", () => {
    const landscape = fitTableCellImage(640, 480, 200, 160);
    expect(landscape).toEqual({ x: 4, y: 8, width: 192, height: 144 });
    const portrait = fitTableCellImage(480, 640, 200, 160);
    expect(portrait.width / portrait.height).toBe(0.75);
    expect(portrait.y).toBe(4);
    expect(fitTableCellImage(20, 10, 4, 4)).toEqual({
      x: 2,
      y: 2,
      width: 0,
      height: 0,
    });
  });

  it("adds rendering only to the view and supports native delete and undo", () => {
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: enUS },
      presets: [UniverSheetsNodeCorePreset()],
    });
    const snapshot = createTableWorkbook("Images");
    const sheetId = snapshot.sheetOrder[0];
    snapshot.sheets[sheetId].cellData = {
      0: { 0: setTableCellImage(null, image) },
    };
    const book = univerAPI.createWorkbook(snapshot);
    const registration = registerTableCellImages(
      univer.__getInjector().get(SheetInterceptorService),
      vi.fn(),
      INTERCEPTOR_POINT.CELL_CONTENT
    );
    try {
      const sheet = book.getActiveSheet();
      const rendered = sheet.getSheet().getCell(0, 0);
      expect(rendered?.customRender).toHaveLength(1);
      expect(rendered?.fontRenderExtension?.isSkip).toBe(true);
      expect(rendered?.coverable).toBe(false);
      expect(book.save().sheets[sheetId].cellData?.[0]?.[0]).not.toHaveProperty(
        "customRender"
      );
      expect(
        getTableCellImage(book.save().sheets[sheetId].cellData?.[0]?.[0])
      ).toEqual(image);
      sheet.getRange(0, 0).setValue(
        setTableCellImageSize(sheet.getSheet().getCellRaw(0, 0), {
          width: 120,
          height: 90,
        })
      );
      const resized = sheet.getSheet().getCell(0, 0);
      expect(resized?.interceptorAutoHeight?.()).toBe(98);
      expect(resized?.interceptorAutoWidth?.()).toBe(128);
      expect(book.save().sheets[sheetId].cellData?.[0]?.[0]).not.toHaveProperty(
        "customRender"
      );
      book.undo();
      expect(
        sheet.getRange(0, 0).getCellData()?.custom?.outlineImageSize
      ).toBeNull();
      univerAPI.syncExecuteCommand("sheet.command.clear-selection-content", {
        unitId: book.getId(),
        subUnitId: sheetId,
        ranges: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }],
      });
      expect(
        getTableCellImage(sheet.getRange(0, 0).getCellData())
      ).toBeUndefined();
      book.undo();
      expect(getTableCellImage(sheet.getRange(0, 0).getCellData())).toEqual(
        image
      );
      sheet.getRange(0, 0).setValue("New text");
      expect(
        getTableCellImage(sheet.getRange(0, 0).getCellData())
      ).toBeUndefined();
      expect(sheet.getRange(0, 0).getCellData()?.v).toBe("New text");
    } finally {
      registration.dispose();
      univer.dispose();
    }
  });
});
