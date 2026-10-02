import { LocaleType } from "@univerjs/core";
import type { IWorkbookData } from "@univerjs/core";
import {
  getTableCellImage,
  getTableCellImageSize,
  getTableCellImages,
  setTableCellImage,
  setTableCellImageSize,
  TableCellImageSchema,
} from "./tableCellImage";
import { getTableDocument, tableDocumentToMarkdown } from "./tableDocument";

const image = {
  attachmentId: "f4a4e331-c5a5-4e78-a365-24975280b4a1",
  src: "/api/attachments.redirect?id=f4a4e331-c5a5-4e78-a365-24975280b4a1",
  name: "screenshot.png",
  width: 640,
  height: 480,
};

describe("cell image metadata", () => {
  it("resizes without changing attachments and resets size on replacement", () => {
    const original = setTableCellImage(
      { s: "style", custom: { tag: "keep" } },
      image
    );
    const resized = setTableCellImageSize(original, { width: 120, height: 90 });
    expect(getTableCellImage(resized)).toEqual(image);
    expect(getTableCellImageSize(resized)).toEqual({ width: 120, height: 90 });
    expect(resized.s).toBe("style");
    expect(resized.custom?.tag).toBe("keep");
    expect(getTableCellImageSize(original)).toBeUndefined();
    expect(
      getTableCellImageSize(setTableCellImageSize(resized, null))
    ).toBeUndefined();
    expect(
      getTableCellImageSize(setTableCellImage(resized, image))
    ).toBeUndefined();
    expect(
      getTableCellImageSize(setTableCellImage(resized, null))
    ).toBeUndefined();
  });
  it.each([
    { width: 0, height: 10 },
    { width: 12.5, height: 10 },
    { width: 2049, height: 10 },
    { width: 10, height: 2049 },
  ])("rejects invalid display sizes %j", (size) => {
    expect(() =>
      setTableCellImageSize(setTableCellImage(null, image), size)
    ).toThrow();
    expect(
      getTableCellImageSize({
        custom: { outlineImage: image, outlineImageSize: size },
      })
    ).toBeUndefined();
  });
  it("ignores orphaned display dimensions on non-image cells", () => {
    expect(() =>
      setTableCellImageSize({ v: "text" }, { width: 40, height: 30 })
    ).toThrow("no image");
    expect(
      getTableCellImageSize({
        custom: { outlineImageSize: { width: 40, height: 30 } },
      })
    ).toBeUndefined();
  });
  it("replaces content without removing formatting or unrelated metadata", () => {
    const cell = setTableCellImage(
      {
        f: "=SUM(A1:A5)",
        v: 10,
        s: { bg: { rgb: "#ff0000" } },
        custom: { tag: "keep" },
      },
      image
    );
    expect(cell.f).toBeNull();
    expect(cell.v).toBeNull();
    expect(cell.s).toEqual({ bg: { rgb: "#ff0000" } });
    expect(cell.custom?.tag).toBe("keep");
    expect(getTableCellImage(cell)).toEqual(image);
    const removed = setTableCellImage(cell, null);
    expect(getTableCellImage(removed)).toBeUndefined();
    expect(removed.custom?.tag).toBe("keep");
    expect(removed.s).toEqual(cell.s);
  });

  it.each([
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "blob:https://example.com/id",
    "//example.com/image.png",
    "https://user:password@example.com/image.png",
  ])("rejects unsafe or nonportable image source %s", (src) => {
    expect(TableCellImageSchema.safeParse({ ...image, src }).success).toBe(
      false
    );
  });

  it("preserves images through the document transport and includes hidden sheets", () => {
    const workbook: IWorkbookData = {
      id: "image-book",
      name: "Images",
      appVersion: "0.25.1",
      locale: LocaleType.EN_US,
      sheetOrder: ["main", "hidden"],
      sheets: {
        main: {
          id: "main",
          name: "Main",
          rowCount: 10,
          columnCount: 4,
          cellData: {
            1: {
              2: setTableCellImageSize(setTableCellImage(null, image), {
                width: 120,
                height: 90,
              }),
            },
          },
        },
        hidden: {
          id: "hidden",
          name: "Hidden",
          hidden: 1,
          rowCount: 10,
          columnCount: 4,
          cellData: { 3: { 0: setTableCellImage(null, image) } },
        },
      },
      styles: {},
    };
    const markdown = tableDocumentToMarkdown({
      format: "outline-table",
      version: 2,
      workbook,
    });
    const source = markdown.split("\n").slice(1, -1).join("\n");
    const restored = getTableDocument({
      type: "doc",
      content: [
        {
          type: "code_fence",
          attrs: { language: "outline-table" },
          content: [{ type: "text", text: source }],
        },
      ],
    });
    expect(restored?.version).toBe(2);
    if (restored?.version !== 2) {
      throw new Error("Expected native workbook");
    }
    expect(getTableCellImages(restored.workbook)).toEqual([
      { sheetId: "main", row: 1, column: 2, image },
      { sheetId: "hidden", row: 3, column: 0, image },
    ]);
    expect(
      getTableCellImageSize(restored.workbook.sheets.main.cellData?.[1]?.[2])
    ).toEqual({ width: 120, height: 90 });
  });
});
