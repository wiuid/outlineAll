import { CellValueType, RichTextValue, toDisposable } from "@univerjs/core";
import type { IDisposable } from "@univerjs/core";
import type { SheetInterceptorService } from "@univerjs/preset-sheets-core";

/**
 * Presents external multiline values as native paragraphs when editing a cell.
 * The saved value stays untouched until Univer commits the user's edit.
 *
 * @param interceptors the current workbook's native cell interceptor service.
 * @returns a disposable that removes the editor conversion.
 */
export function registerTableMultilineEditing(
  interceptors: SheetInterceptorService
): IDisposable {
  const { writeCellInterceptor } = interceptors;
  return toDisposable(
    writeCellInterceptor.intercept(
      writeCellInterceptor.getInterceptPoints().BEFORE_CELL_EDIT,
      {
        handler: (cell, { worksheet, row, col }, next) => {
          if (
            !cell ||
            cell.p ||
            cell.f ||
            cell.si ||
            cell.isInArrayFormulaRange ||
            typeof cell.v !== "string" ||
            !/[\r\n]/.test(cell.v)
          ) {
            return next(cell);
          }

          // Reuse Univer's composed font style, including row and column styles.
          const model = worksheet.getCellDocumentModelWithFormula(
            cell,
            row,
            col
          )?.documentModel;
          const textRun = model?.getBody()?.textRuns?.[0];
          const text =
            (cell.t === CellValueType.FORCE_STRING ? "'" : "") +
            cell.v.replace(/\r\n|\n/g, "\r");
          const richText = RichTextValue.createByBody({
            dataStream: `${text}\r\n`,
            textRuns: textRun ? [{ ...textRun, st: 0, ed: text.length }] : [],
            sectionBreaks: [{ startIndex: text.length + 1 }],
          }).getData();
          model?.dispose();

          return next({ ...cell, p: richText });
        },
      }
    )
  );
}
