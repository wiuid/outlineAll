import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from "@univerjs/core";

/** Controls the software keyboard for Univer's native cell editor. */
interface TableMobileInput {
  /** Updates keyboard availability when native cell editing starts or ends. */
  setEditing: (editing: boolean) => void;
  /** Removes observers and restores the editor's original attributes. */
  dispose: () => void;
}

interface TableMobileTextEditorOptions {
  /** Accessible name for the native editor. */
  ariaLabel: string;
  /** Returns the visible bounds of the cell being edited. */
  getBounds: () => DOMRect;
  /** Receives the final plain-text value. */
  onCommit: (value: string) => void;
  /** Runs after the native editor closes. */
  onClose: () => void;
  /** Initial cell text. */
  value: string;
}

/** Controls a real DOM editor so mobile browsers can provide text selection. */
interface TableMobileTextEditor {
  /** Opens the native editor over the current cell. */
  open: (options: TableMobileTextEditorOptions) => void;
  /** Commits and closes the active editor. */
  commit: () => void;
  /** Closes the active editor without changing the cell. */
  cancel: () => void;
  /** Removes the active editor and its listeners. */
  dispose: () => void;
}

type TableHeaderAxis = "row" | "column";

interface TableMobileHeaderSelectionOptions {
  /** Resolves a touch point in a header to its row or column. */
  getTarget: (
    clientX: number,
    clientY: number,
    axis?: TableHeaderAxis
  ) => { axis: TableHeaderAxis; index: number } | undefined;
  /** Selects the inclusive row or column range. */
  select: (axis: TableHeaderAxis, start: number, end: number) => void;
}

/**
 * Enables direct drag selection across mobile row and column headers.
 *
 * @param canvas the native Univer canvas receiving touch gestures.
 * @param options coordinate resolution and native selection callbacks.
 * @returns a function that removes all gesture listeners.
 */
export function bindTableMobileHeaderSelection(
  canvas: HTMLCanvasElement,
  options: TableMobileHeaderSelectionOptions
): () => void {
  const threshold = 8;
  let start:
    | {
        axis: TableHeaderAxis;
        index: number;
        clientX: number;
        clientY: number;
      }
    | undefined;
  let dragging = false;

  const reset = () => {
    start = undefined;
    dragging = false;
  };
  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    const target = options.getTarget(touch.clientX, touch.clientY);
    start = target
      ? {
          ...target,
          clientX: touch.clientX,
          clientY: touch.clientY,
        }
      : undefined;
    dragging = false;
  };
  const handleTouchMove = (event: TouchEvent) => {
    if (!start || event.touches.length !== 1) {
      return;
    }
    const touch = event.touches[0];
    if (
      !dragging &&
      Math.hypot(touch.clientX - start.clientX, touch.clientY - start.clientY) <
        threshold
    ) {
      return;
    }
    const target = options.getTarget(touch.clientX, touch.clientY, start.axis);
    if (!target) {
      return;
    }
    dragging = true;
    event.preventDefault();
    event.stopImmediatePropagation();
    options.select(start.axis, start.index, target.index);
  };
  const handleTouchEnd = (event: TouchEvent) => {
    if (dragging) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    reset();
  };

  canvas.addEventListener("touchstart", handleTouchStart, {
    capture: true,
    passive: true,
  });
  canvas.addEventListener("touchmove", handleTouchMove, {
    capture: true,
    passive: false,
  });
  canvas.addEventListener("touchend", handleTouchEnd, {
    capture: true,
    passive: false,
  });
  canvas.addEventListener("touchcancel", handleTouchEnd, {
    capture: true,
    passive: false,
  });

  return () => {
    canvas.removeEventListener("touchstart", handleTouchStart, true);
    canvas.removeEventListener("touchmove", handleTouchMove, true);
    canvas.removeEventListener("touchend", handleTouchEnd, true);
    canvas.removeEventListener("touchcancel", handleTouchEnd, true);
  };
}

/**
 * Creates a mobile text editor backed by a native textarea.
 *
 * Univer draws cell text on canvas, which gives the browser no DOM range for
 * its Copy, Paste, and Select all menu. This editor is used for plain-text
 * cells while formulas and rich text continue through Univer's canvas editor.
 *
 * @param host the element containing this Univer instance.
 * @returns controls for the active native editor.
 */
export function createTableMobileTextEditor(
  host: HTMLElement
): TableMobileTextEditor {
  let textarea: HTMLTextAreaElement | undefined;
  let options: TableMobileTextEditorOptions | undefined;

  const close = (commit: boolean) => {
    if (!textarea || !options) {
      return;
    }
    const current = textarea;
    const currentOptions = options;
    textarea = undefined;
    options = undefined;
    current.remove();
    if (commit) {
      currentOptions.onCommit(current.value);
    }
    currentOptions.onClose();
  };
  const position = () => {
    if (!textarea || !options) {
      return;
    }
    const bounds = options.getBounds();
    const view = host.ownerDocument.defaultView;
    if (!view) {
      return;
    }
    const viewport = view.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportRight = viewportLeft + (viewport?.width ?? view.innerWidth);
    const viewportBottom = viewportTop + (viewport?.height ?? view.innerHeight);
    const width = Math.min(
      Math.max(120, Math.round(bounds.width)),
      viewportRight - viewportLeft - 8
    );
    const height = Math.max(44, Math.round(bounds.height));
    const left = Math.min(
      Math.max(viewportLeft + 4, bounds.left),
      viewportRight - width - 4
    );
    const top = Math.min(
      Math.max(viewportTop + 4, bounds.top),
      viewportBottom - Math.min(height, 240) - 4
    );
    textarea.style.left = `${Math.round(left)}px`;
    textarea.style.top = `${Math.round(top)}px`;
    textarea.style.width = `${Math.round(width)}px`;
    textarea.style.minHeight = `${Math.max(44, Math.round(bounds.height))}px`;
  };
  const handleViewportChange = () => position();

  return {
    open(nextOptions) {
      close(false);
      options = nextOptions;
      textarea = host.ownerDocument.createElement("textarea");
      textarea.className = "outline-table-mobile-text-editor";
      textarea.value = nextOptions.value;
      textarea.setAttribute("aria-label", nextOptions.ariaLabel);
      textarea.setAttribute("enterkeyhint", "done");
      textarea.setAttribute("autocapitalize", "sentences");
      textarea.addEventListener("blur", () => close(true), { once: true });
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close(false);
        }
      });
      textarea.addEventListener("input", () => {
        if (!textarea) {
          return;
        }
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(240, textarea.scrollHeight)}px`;
      });
      host.ownerDocument.body.appendChild(textarea);
      position();
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      host.ownerDocument.defaultView?.visualViewport?.addEventListener(
        "resize",
        handleViewportChange
      );
      host.ownerDocument.defaultView?.visualViewport?.addEventListener(
        "scroll",
        handleViewportChange
      );
    },
    commit() {
      close(true);
    },
    cancel() {
      close(false);
    },
    dispose() {
      close(false);
      host.ownerDocument.defaultView?.visualViewport?.removeEventListener(
        "resize",
        handleViewportChange
      );
      host.ownerDocument.defaultView?.visualViewport?.removeEventListener(
        "scroll",
        handleViewportChange
      );
    },
  };
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
