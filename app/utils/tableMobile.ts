import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from "@univerjs/core";

/** Controls the software keyboard for Univer's native cell editor. */
interface TableMobileInput {
  /** Updates keyboard availability when native cell editing starts or ends. */
  setEditing: (editing: boolean) => void;
  /** Removes observers and restores the editor's original attributes. */
  dispose: () => void;
}

/**
 * Keeps cell selection from opening the keyboard, while retaining native input.
 *
 * @param host the element containing this Univer instance.
 * @returns controls to synchronize with the native editing lifecycle.
 */
export function bindTableMobileInput(host: HTMLElement): TableMobileInput {
  let editing = false;
  let input: HTMLElement | null = null;
  let originalMode: string | null = null;
  let originalHint: string | null = null;
  const selector = `[id="__editor_${DOCS_NORMAL_EDITOR_UNIT_ID_KEY}"]`;

  const restore = () => {
    if (!input) {
      return;
    }
    if (originalMode === null) {
      input.removeAttribute("inputmode");
    } else {
      input.setAttribute("inputmode", originalMode);
    }
    if (originalHint === null) {
      input.removeAttribute("enterkeyhint");
    } else {
      input.setAttribute("enterkeyhint", originalHint);
    }
  };
  const update = () => {
    const current = host.querySelector<HTMLElement>(selector);
    if (current !== input) {
      restore();
      input = current;
      originalMode = input?.getAttribute("inputmode") ?? null;
      originalHint = input?.getAttribute("enterkeyhint") ?? null;
    }
    input?.setAttribute("inputmode", editing ? "text" : "none");
    input?.setAttribute("enterkeyhint", "done");
  };
  // Univer creates this input after mounting its workbench. Scope observation
  // to this instance so document titles and other editors keep their behavior.
  const observer = new MutationObserver(update);
  observer.observe(host, { childList: true, subtree: true });
  update();

  return {
    setEditing(value) {
      const changed = editing !== value;
      editing = value;
      update();
      if (changed && input === host.ownerDocument.activeElement) {
        // Refocusing during Univer's edit-start event opens the keyboard on
        // mobile browsers that ignore inputmode changes on a focused element.
        // On edit end, blurring dismisses it without focusing another field.
        input?.blur();
      }
    },
    dispose() {
      observer.disconnect();
      restore();
    },
  };
}

/**
 * Fits a mobile workbook to the visible area above the software keyboard.
 *
 * @param container the full-page table workspace.
 * @param onResize reveals the editing cell after Univer has resized its canvas.
 * @returns a function that removes listeners and restores CSS sizing.
 */
export function observeTableViewport(
  container: HTMLElement,
  onResize: () => void
): () => void {
  const view = container.ownerDocument.defaultView;
  if (!view) {
    return () => {};
  }
  const viewport = view.visualViewport;
  let measureFrame = 0;
  let notifyFrame = 0;
  let height = 0;
  let offset = 0;
  const heightProperty = "--table-viewport-height";
  const offsetProperty = "--table-viewport-offset";
  const originalHeight = container.style.getPropertyValue(heightProperty);
  const originalOffset = container.style.getPropertyValue(offsetProperty);

  const notifyResize = () => {
    view.cancelAnimationFrame(notifyFrame);
    notifyFrame = view.requestAnimationFrame(onResize);
  };
  // Univer resizes its canvas in an idle callback after layout changes. Wait
  // for its bitmap dimensions too, so revealing a cell uses the new viewport.
  const canvasObserver = new MutationObserver((records) => {
    if (
      records.some(
        ({ target }) =>
          target instanceof HTMLCanvasElement &&
          target.id.startsWith("univer-sheet-main-canvas_")
      )
    ) {
      notifyResize();
    }
  });
  canvasObserver.observe(container, {
    subtree: true,
    attributes: true,
    attributeFilter: ["width", "height"],
  });

  const measure = () => {
    measureFrame = 0;
    // Browser page zoom must remain independent of workbook pinch zoom.
    if (viewport && viewport.scale !== 1) {
      return;
    }
    const nextHeight = Math.round(viewport?.height ?? view.innerHeight);
    const nextOffset = Math.round(viewport?.offsetTop ?? 0);
    if (nextHeight <= 0 || (height === nextHeight && offset === nextOffset)) {
      return;
    }
    height = nextHeight;
    offset = nextOffset;
    container.style.setProperty(heightProperty, `${height}px`);
    container.style.setProperty(offsetProperty, `${offset}px`);
    notifyResize();
  };
  const handleResize = () => {
    view.cancelAnimationFrame(measureFrame);
    measureFrame = view.requestAnimationFrame(measure);
  };
  view.addEventListener("resize", handleResize);
  viewport?.addEventListener("resize", handleResize);
  viewport?.addEventListener("scroll", handleResize);
  measure();

  return () => {
    view.cancelAnimationFrame(measureFrame);
    view.cancelAnimationFrame(notifyFrame);
    canvasObserver.disconnect();
    view.removeEventListener("resize", handleResize);
    viewport?.removeEventListener("resize", handleResize);
    viewport?.removeEventListener("scroll", handleResize);
    container.style.setProperty(heightProperty, originalHeight);
    container.style.setProperty(offsetProperty, originalOffset);
  };
}
