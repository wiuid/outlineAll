import { RANGE_TYPE } from "@univerjs/core";
import type {
  ICommandService,
  IDisposable,
  IRange,
  Worksheet,
} from "@univerjs/core";
import { z } from "zod";

interface AutoFitSelection {
  worksheet: Pick<Worksheet, "getRowCount" | "getColumnCount">;
  ranges: readonly IRange[];
}

/**
 * Expands a header auto-fit to all selected rows or columns containing its anchor.
 *
 * @param axis the dimension being resized.
 * @param targets the ranges supplied by the native header gesture.
 * @param selected the current selection ranges.
 * @param rowCount the current worksheet's row count.
 * @param columnCount the current worksheet's column count.
 * @returns full row or column ranges, or the original targets outside a selection.
 */
export function getTableAutoFitRanges(
  axis: "row" | "column",
  targets: IRange[],
  selected: readonly IRange[],
  rowCount: number,
  columnCount: number
): IRange[] {
  const type = axis === "row" ? RANGE_TYPE.ROW : RANGE_TYPE.COLUMN;
  const start = axis === "row" ? "startRow" : "startColumn";
  const end = axis === "row" ? "endRow" : "endColumn";
  const ranges = selected.filter(
    (range) => range.rangeType === type || range.rangeType === RANGE_TYPE.ALL
  );
  if (
    !targets.some((target) =>
      ranges.some(
        (range) => target[start] >= range[start] && target[end] <= range[end]
      )
    )
  ) {
    return targets;
  }

  // Merge overlaps without visiting every cell in a whole-sheet selection.
  const intervals = ranges
    .map((range) => ({ start: range[start], end: range[end] }))
    .sort((a, b) => a.start - b.start);
  const merged: typeof intervals = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged.map((interval) => ({
    startRow: axis === "row" ? interval.start : 0,
    endRow: axis === "row" ? interval.end : rowCount - 1,
    startColumn: axis === "column" ? interval.start : 0,
    endColumn: axis === "column" ? interval.end : columnCount - 1,
  }));
}

/**
 * Completes native multi-selection header double-click auto-fit behavior.
 * Measurement, permissions, mutations and undo remain owned by Univer.
 *
 * @param commands the native command service.
 * @param selection reads the active worksheet and selection at gesture time.
 * @returns a disposable that removes the gesture and command listeners.
 */
export function bindTableAutoFit(
  commands: Pick<ICommandService, "beforeCommandExecuted">,
  selection: () => AutoFitSelection | undefined
): IDisposable {
  const subscription = commands.beforeCommandExecuted((command, options) => {
    // Header double-clicks supply an explicit single row or column. Menu
    // commands omit ranges; collaboration replays mutations, not commands.
    if (options?.fromCollab || options?.onlyLocal) {
      return;
    }
    const axis =
      command.id === "sheet.command.set-col-auto-width"
        ? "column"
        : command.id === "sheet.command.set-row-is-auto-height"
          ? "row"
          : undefined;
    const params = command.params;
    if (!axis || !params || !("ranges" in params)) {
      return;
    }
    const parsed = rangesSchema.safeParse(params.ranges);
    const current = selection();
    if (!parsed.success || !current) {
      return;
    }
    params.ranges = getTableAutoFitRanges(
      axis,
      parsed.data,
      current.ranges,
      current.worksheet.getRowCount(),
      current.worksheet.getColumnCount()
    );
  });
  return {
    dispose: () => {
      subscription.dispose();
    },
  };
}

const rangesSchema = z.array(
  z.object({
    startRow: z.number().int().nonnegative(),
    endRow: z.number().int().nonnegative(),
    startColumn: z.number().int().nonnegative(),
    endColumn: z.number().int().nonnegative(),
  })
);
