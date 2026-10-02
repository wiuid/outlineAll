import { InterceptorEffectEnum } from "@univerjs/core";
import type { ICellCustomRender, IDisposable } from "@univerjs/core";
import type {
  INTERCEPTOR_POINT,
  SheetInterceptorService,
} from "@univerjs/preset-sheets-core";
import type {
  TableCellImage,
  TableCellImageSize,
} from "@shared/utils/tableCellImage";
import {
  getTableCellImage,
  getTableCellImageSize,
} from "@shared/utils/tableCellImage";
import type { TableSelection } from "@shared/utils/tablePresence";
import { sanitizeUrl } from "@shared/utils/urls";

/** A cell captured before opening a file picker or beginning an upload. */
export interface TableCellImageTarget {
  sheetId: string;
  sheetName?: string;
  address?: string;
  row: number;
  column: number;
  selection?: TableSelection;
  content: string;
  occupied: boolean;
  image?: TableCellImage;
  size?: TableCellImageSize;
}

/** Native workbook operations used by the accessible image controls. */
export interface TableCellImageController {
  getSelectedImage?: () => TableCellImageTarget | undefined;
  subscribeSelection?: (listener: () => void) => () => void;
  subscribeViewRequest?: (listener: () => void) => () => void;
  getTarget: () => Promise<TableCellImageTarget>;
  setImage: (
    target: TableCellImageTarget,
    image: TableCellImage | null,
    size?: TableCellImageSize | null
  ) => Promise<TableCellImageTarget>;
}

/**
 * Bounds editable display dimensions while preserving the attachment's aspect ratio.
 *
 * @param image the attachment's intrinsic dimensions.
 * @returns initial display dimensions within the cell size limits.
 */
export function getDefaultTableCellImageSize(
  image: TableCellImage
): TableCellImageSize {
  const scale = Math.min(2048 / image.width, 2048 / image.height, 1);
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

/**
 * Fits intrinsic pixels into the viewer without upscaling small images.
 *
 * @param width the intrinsic image width.
 * @param height the intrinsic image height.
 * @param viewportWidth the available viewer width.
 * @param viewportHeight the available viewer height.
 * @returns the fitting zoom scale.
 */
export function getTableCellImageViewScale(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number
): number {
  if (width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return 1;
  }
  return Math.min(viewportWidth / width, viewportHeight / height, 1);
}

/**
 * Fits an image inside its cell without stretching or spilling into neighbors.
 *
 * @param width the image's intrinsic width.
 * @param height the image's intrinsic height.
 * @param cellWidth the cell or merged range width.
 * @param cellHeight the cell or merged range height.
 * @returns a centered rectangle with a small cell inset.
 */
export function fitTableCellImage(
  width: number,
  height: number,
  cellWidth: number,
  cellHeight: number
): { x: number; y: number; width: number; height: number } {
  const availableWidth = Math.max(0, cellWidth - 8);
  const availableHeight = Math.max(0, cellHeight - 8);
  const scale = Math.min(availableWidth / width, availableHeight / height, 1);
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  return {
    x: (cellWidth - fittedWidth) / 2,
    y: (cellHeight - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
  };
}

/**
 * Draws attachment-backed cell images using Univer's native render interceptor.
 * Runtime images and render callbacks are never added to the saved workbook.
 *
 * @param interceptors the workbook's native cell interceptors.
 * @param repaint requests a fresh frame after an attachment finishes loading.
 * @param point the native cell content interceptor point.
 * @returns a disposable that releases subscriptions and cached image elements.
 */
export function registerTableCellImages(
  interceptors: SheetInterceptorService,
  repaint: () => void,
  point: typeof INTERCEPTOR_POINT.CELL_CONTENT
): IDisposable {
  const cache = new Map<string, HTMLImageElement>();
  let disposed = false;
  const render: ICellCustomRender = {
    drawWith: (ctx, info) => {
      const metadata = getTableCellImage(info.data);
      if (!metadata || disposed) {
        return;
      }
      let image = cache.get(metadata.src);
      if (!image) {
        image = new Image();
        image.onload = () => {
          if (!disposed) {
            repaint();
          }
        };
        image.onerror = () => {
          if (!disposed) {
            repaint();
          }
        };
        cache.set(metadata.src, image);
        image.src = sanitizeUrl(metadata.src) ?? "";
      }
      const coordinates = info.primaryWithCoord;
      const { startX, startY, endX, endY } =
        coordinates.isMerged || coordinates.isMergedMainCell
          ? coordinates.mergeInfo
          : coordinates;
      const cellWidth = endX - startX;
      const cellHeight = endY - startY;
      const size = getTableCellImageSize(info.data) ?? metadata;
      const rect = fitTableCellImage(
        size.width,
        size.height,
        cellWidth,
        cellHeight
      );
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, startY, cellWidth, cellHeight);
      ctx.clip();
      if (image.complete && image.naturalWidth > 0) {
        ctx.drawImage(
          image,
          startX + rect.x,
          startY + rect.y,
          rect.width,
          rect.height
        );
      } else {
        const failed = image.complete && image.naturalWidth === 0;
        ctx.strokeStyle = failed ? "#c93838" : "#888888";
        ctx.strokeRect(
          startX + rect.x,
          startY + rect.y,
          rect.width,
          rect.height
        );
        if (failed) {
          ctx.beginPath();
          ctx.moveTo(startX + rect.x, startY + rect.y);
          ctx.lineTo(
            startX + rect.x + rect.width,
            startY + rect.y + rect.height
          );
          ctx.moveTo(startX + rect.x + rect.width, startY + rect.y);
          ctx.lineTo(startX + rect.x, startY + rect.y + rect.height);
          ctx.stroke();
        }
      }
      ctx.restore();
    },
  };
  const subscription = interceptors.intercept(point, {
    effect: InterceptorEffectEnum.Style,
    priority: 11,
    handler: (cell, context, next) => {
      const image = getTableCellImage(context.rawData);
      if (!image) {
        return next(cell);
      }
      const size = getTableCellImageSize(context.rawData);
      return next({
        ...cell,
        custom: context.rawData?.custom,
        customRender: [...(cell?.customRender ?? []), render],
        coverable: false,
        fontRenderExtension: { ...cell?.fontRenderExtension, isSkip: true },
        interceptorAutoHeight: () =>
          size ? size.height + 8 : Math.min(image.height + 8, 160),
        interceptorAutoWidth: () =>
          size ? size.width + 8 : Math.min(image.width + 8, 200),
      });
    },
  });
  return {
    dispose: () => {
      disposed = true;
      subscription.dispose();
      for (const image of cache.values()) {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
      }
      cache.clear();
    },
  };
}
