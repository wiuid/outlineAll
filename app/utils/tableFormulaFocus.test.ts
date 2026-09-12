import {
  DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY,
  DOCS_NORMAL_EDITOR_UNIT_ID_KEY,
} from "@univerjs/core";
import { bindTableFormulaFocus } from "./tableFormulaFocus";

it("restores formula focus after a late native cell focus retry", async () => {
  const host = document.createElement("div");
  const cell = document.createElement("input");
  const formula = document.createElement("input");
  cell.id = `__editor_${DOCS_NORMAL_EDITOR_UNIT_ID_KEY}`;
  formula.id = `__editor_${DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY}`;
  host.append(cell, formula);
  document.body.append(host);
  let formulaActive = true;
  const dispose = bindTableFormulaFocus(host, {
    isActive: () => formulaActive,
    restore: () => formula.focus(),
  });
  try {
    formula.focus();
    cell.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(formula);

    // The native command updates its active editor after moving DOM focus.
    cell.focus();
    formulaActive = false;
    await Promise.resolve();
    expect(document.activeElement).toBe(cell);
  } finally {
    dispose();
    host.remove();
  }
});

it("respects focus outside the workbook and cancels work on disposal", async () => {
  const host = document.createElement("div");
  const cell = document.createElement("input");
  const title = document.createElement("input");
  cell.id = `__editor_${DOCS_NORMAL_EDITOR_UNIT_ID_KEY}`;
  host.append(cell);
  document.body.append(host, title);
  const restore = vi.fn();
  const dispose = bindTableFormulaFocus(host, {
    isActive: () => true,
    restore,
  });
  try {
    cell.focus();
    title.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(title);
    expect(restore).not.toHaveBeenCalled();

    cell.focus();
    dispose();
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();

    title.focus();
    cell.focus();
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();
  } finally {
    dispose();
    host.remove();
    title.remove();
  }
});
