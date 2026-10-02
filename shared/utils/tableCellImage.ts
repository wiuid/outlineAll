import type { ICellData, IWorkbookData, Nullable } from "@univerjs/core";
import { z } from "zod";

/** A stored attachment displayed inside a native worksheet cell. */
export const TableCellImageSchema = z.strictObject({
  attachmentId: z.uuid(),
  src: z.string().max(4096).refine(isImageSource),
  name: z.string().max(255),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
});

/** Serializable image metadata; image bytes remain in attachment storage. */
export type TableCellImage = z.infer<typeof TableCellImageSchema>;

/** Bounded display dimensions, stored separately from the attachment metadata. */
export const TableCellImageSizeSchema = z.strictObject({
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
});

/** The requested display dimensions of a cell image in pixels. */
export type TableCellImageSize = z.infer<typeof TableCellImageSizeSchema>;

/** An image and its native worksheet coordinates. */
export interface TableCellImageLocation {
  sheetId: string;
  row: number;
  column: number;
  image: TableCellImage;
}

/**
 * Reads valid image metadata without accepting executable or embedded URLs.
 *
 * @param cell the saved or intercepted native cell.
 * @returns the cell image, or undefined for missing or invalid metadata.
 */
export function getTableCellImage(
  cell: Nullable<ICellData>
): TableCellImage | undefined {
  if (
    cell?.f ||
    cell?.p ||
    cell?.si ||
    (cell?.v !== undefined && cell.v !== null && cell.v !== "")
  ) {
    return undefined;
  }
  const result = TableCellImageSchema.safeParse(cell?.custom?.outlineImage);
  return result.success ? result.data : undefined;
}

/**
 * Reads valid display dimensions without accepting orphaned size metadata.
 *
 * @param cell the native cell containing the image.
 * @returns the saved display size, or undefined for default sizing.
 */
export function getTableCellImageSize(
  cell: Nullable<ICellData>
): TableCellImageSize | undefined {
  if (!getTableCellImage(cell)) {
    return undefined;
  }
  const result = TableCellImageSizeSchema.safeParse(
    cell?.custom?.outlineImageSize
  );
  return result.success ? result.data : undefined;
}

/**
 * Updates display dimensions without replacing the image attachment or cell formatting.
 *
 * @param cell the existing image cell.
 * @param size the requested dimensions, or null for default sizing.
 * @returns the updated native cell data.
 * @throws when the cell has no image or the requested dimensions are invalid.
 */
export function setTableCellImageSize(
  cell: Nullable<ICellData>,
  size: TableCellImageSize | null
): ICellData {
  if (!getTableCellImage(cell)) {
    throw new Error("This cell has no image.");
  }
  return {
    ...cell,
    custom: {
      ...cell?.custom,
      outlineImageSize: size ? TableCellImageSizeSchema.parse(size) : null,
    },
  };
}

/**
 * Replaces cell content with an image while retaining formatting and other metadata.
 *
 * @param cell the previous cell data.
 * @param image the new image, or null to remove the image.
 * @returns native cell data suitable for a normal, undoable value command.
 */
export function setTableCellImage(
  cell: Nullable<ICellData>,
  image: TableCellImage | null
): ICellData {
  return {
    ...cell,
    ...(image
      ? { v: null, p: null, f: null, si: null, t: null, ref: null }
      : {}),
    custom: {
      ...cell?.custom,
      outlineImage: image ? TableCellImageSchema.parse(image) : null,
      outlineImageSize: null,
    },
  };
}

/**
 * Collects only recognized cell images for attachment tracking and public sharing.
 *
 * @param workbook the native workbook snapshot.
 * @returns image metadata and coordinates, including hidden worksheets.
 */
export function getTableCellImages(
  workbook: IWorkbookData
): TableCellImageLocation[] {
  const images: TableCellImageLocation[] = [];
  for (const [sheetId, sheet] of Object.entries(workbook.sheets)) {
    const data = sheet.cellData;
    if (!data) {
      continue;
    }
    for (const row of Object.keys(data)) {
      const cells = data[Number(row)];
      for (const column of Object.keys(cells)) {
        const image = getTableCellImage(cells[Number(column)]);
        if (image) {
          images.push({
            sheetId,
            row: Number(row),
            column: Number(column),
            image,
          });
        }
      }
    }
  }
  return images;
}

function isImageSource(src: string): boolean {
  if (/^\/api\/attachments\.redirect\?id=[\da-f-]{36}$/i.test(src)) {
    return true;
  }
  try {
    const url = new URL(src);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
