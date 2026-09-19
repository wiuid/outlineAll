import { CommandType, RANGE_TYPE } from "@univerjs/core";
import type { CommandListener, IRange } from "@univerjs/core";
import { bindTableAutoFit, getTableAutoFitRanges } from "./tableAutoFit";

const row = (start: number, end = start): IRange => ({
  startRow: start,
  endRow: end,
  startColumn: 0,
  endColumn: 9,
  rangeType: RANGE_TYPE.ROW,
});
const column = (start: number, end = start): IRange => ({
  startRow: 0,
  endRow: 19,
  startColumn: start,
  endColumn: end,
  rangeType: RANGE_TYPE.COLUMN,
});
const all: IRange = { ...row(0, 19), rangeType: RANGE_TYPE.ALL };

describe("header double-click auto-fit ranges", () => {
  it("fits each selected row, including disjoint ranges", () => {
    expect(
      getTableAutoFitRanges("row", [row(2)], [row(1, 3), row(8, 9)], 20, 10)
    ).toEqual([
      { startRow: 1, endRow: 3, startColumn: 0, endColumn: 9 },
      { startRow: 8, endRow: 9, startColumn: 0, endColumn: 9 },
    ]);
  });
  it("fits every disjoint selected column", () => {
    expect(
      getTableAutoFitRanges(
        "column",
        [column(3, 4)],
        [column(0), column(3, 4)],
        20,
        10
      )
    ).toEqual([
      { startRow: 0, endRow: 19, startColumn: 0, endColumn: 0 },
      { startRow: 0, endRow: 19, startColumn: 3, endColumn: 4 },
    ]);
  });
  it.each(["row", "column"] as const)(
    "supports whole-sheet %s fitting",
    (axis) => {
      expect(
        getTableAutoFitRanges(
          axis,
          [axis === "row" ? row(3) : column(3)],
          [all],
          20,
          10
        )
      ).toEqual([{ startRow: 0, endRow: 19, startColumn: 0, endColumn: 9 }]);
    }
  );
  it("preserves a boundary outside the selection", () => {
    const targets = [row(8)];
    expect(getTableAutoFitRanges("row", targets, [row(1, 3)], 20, 10)).toBe(
      targets
    );
  });
  it("does not expand ordinary cell selections or the opposite axis", () => {
    const targets = [column(1)];
    expect(
      getTableAutoFitRanges(
        "column",
        targets,
        [row(0, 19), { ...all, rangeType: RANGE_TYPE.NORMAL }],
        20,
        10
      )
    ).toBe(targets);
  });
  it("merges overlapping selections without mutating them", () => {
    const selected = [row(4, 8), row(2, 6), row(9)];
    const before = structuredClone(selected);
    expect(getTableAutoFitRanges("row", [row(5)], selected, 20, 10)).toEqual([
      { startRow: 2, endRow: 9, startColumn: 0, endColumn: 9 },
    ]);
    expect(selected).toEqual(before);
  });
});

describe("native gesture command binding", () => {
  it("expands explicit header commands but ignores collaborative replays", () => {
    let listener: CommandListener = () => {};
    const unsubscribe = vi.fn();
    const registration = bindTableAutoFit(
      {
        beforeCommandExecuted: (callback) => {
          listener = callback;
          return { dispose: unsubscribe };
        },
      },
      () => ({
        worksheet: { getRowCount: () => 20, getColumnCount: () => 10 },
        ranges: [row(1, 3)],
      })
    );
    const execute = (options = {}) => {
      const params = { ranges: [row(2)] };
      listener(
        {
          id: "sheet.command.set-row-is-auto-height",
          type: CommandType.COMMAND,
          params,
        },
        options
      );
      return params.ranges;
    };
    expect(execute({ fromCollab: true })).toEqual([row(2)]);
    expect(execute()).toEqual([
      { startRow: 1, endRow: 3, startColumn: 0, endColumn: 9 },
    ]);
    registration.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
