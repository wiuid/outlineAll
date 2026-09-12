import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from "@univerjs/core";

interface FormulaFocus {
  /** Whether Univer still identifies the formula editor as focused. */
  isActive: () => boolean;
  /** Restores the native formula input without changing its selection. */
  restore: () => void;
}

/**
 * Keeps the DOM focus aligned with Univer when its cell editor mounts.
 * Univer 0.25.1 retries cell input focus after the formula input has focused.
 *
 * @param host the element containing this workbook's native inputs.
 * @param formula the native formula editor's focus state and restoration.
 * @returns a function that removes the listener and cancels pending work.
 */
export function bindTableFormulaFocus(
  host: HTMLElement,
  formula: FormulaFocus
): () => void {
  let disposed = false;
  const handleFocusIn = (event: FocusEvent) => {
    const input = event.target;
    if (
      !(input instanceof HTMLElement) ||
      input.id !== `__editor_${DOCS_NORMAL_EDITOR_UNIT_ID_KEY}`
    ) {
      return;
    }

    // Let native focus commands finish updating their state first. An
    // intentional move to the cell editor must keep its requested focus.
    queueMicrotask(() => {
      if (
        !disposed &&
        host.ownerDocument.activeElement === input &&
        formula.isActive()
      ) {
        formula.restore();
      }
    });
  };
  host.addEventListener("focusin", handleFocusIn);
  return () => {
    disposed = true;
    host.removeEventListener("focusin", handleFocusIn);
  };
}
