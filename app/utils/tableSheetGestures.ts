interface SheetPress {
  pointerId: number;
  tab: HTMLElement;
  sheetId: string;
  x: number;
  y: number;
  opened: boolean;
  canceled: boolean;
}

/**
 * Adds long press and keyboard management to Univer's native mobile sheet tabs.
 *
 * @param host the element containing this workbook.
 * @param onManage opens management for the pressed worksheet and its tab.
 * @returns a function that removes listeners and cancels pending gestures.
 */
export function bindTableSheetGestures(
  host: HTMLElement,
  onManage: (sheetId: string, tab: HTMLElement) => void
): () => void {
  const document = host.ownerDocument;
  const view = document.defaultView;
  let press: SheetPress | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;

  const getTab = (target: EventTarget | null) => {
    if (!(target instanceof Element)) {
      return;
    }
    const tab = target.closest<HTMLElement>(
      'footer [role="tablist"] [role="tab"][aria-controls]'
    );
    const controls = tab?.getAttribute("aria-controls");
    if (!tab || !host.contains(tab) || !controls?.startsWith("sheet-")) {
      return;
    }
    return { tab, sheetId: controls.slice("sheet-".length) };
  };

  const cancel = () => {
    clearTimeout(timer);
    if (press) {
      press.canceled = true;
      press.tab.removeAttribute("data-table-sheet-pressed");
    }
  };

  const open = () => {
    if (!press || press.canceled || press.opened || !press.tab.isConnected) {
      return;
    }
    press.opened = true;
    suppressClick = true;
    press.tab.removeAttribute("data-table-sheet-pressed");
    onManage(press.sheetId, press.tab);
  };

  const handlePointerDown = (event: PointerEvent) => {
    // A new physical press must be able to select an opened menu item.
    suppressClick = false;
    cancel();
    press = undefined;
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      (event.pointerType !== "touch" && event.pointerType !== "pen")
    ) {
      return;
    }
    const target = getTab(event.target);
    if (!target) {
      return;
    }
    press = {
      ...target,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      opened: false,
      canceled: false,
    };
    target.tab.setAttribute("data-table-sheet-pressed", "true");
    timer = setTimeout(open, 500);
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (
      press?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8
    ) {
      cancel();
    }
  };

  const handlePointerEnd = (event: PointerEvent) => {
    if (press?.pointerId === event.pointerId) {
      cancel();
      press = undefined;
    }
  };

  const handleClick = (event: MouseEvent) => {
    // Swallow only the compatibility click from the completed long press.
    // Keyboard activation and a subsequent physical tap remain available.
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  const handleCompatibilityMouseDown = (event: MouseEvent) => {
    if (suppressClick) {
      // Touch release synthesizes mousedown before click. Prevent its focus
      // change too, otherwise an open menu closes before click is suppressed.
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (suppressClick) {
      event.preventDefault();
    }
  };

  const handleContextMenu = (event: MouseEvent) => {
    const target = getTab(event.target);
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (press) {
      open();
      return;
    }
    onManage(target.sheetId, target.tab);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    const target = getTab(event.target);
    if (!target) {
      return;
    }
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      event.stopPropagation();
      onManage(target.sheetId, target.tab);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      target.tab.click();
    }
  };

  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("pointermove", handlePointerMove, true);
  document.addEventListener("pointerup", handlePointerEnd, true);
  document.addEventListener("pointercancel", handlePointerEnd, true);
  document.addEventListener("touchend", handleTouchEnd, {
    capture: true,
    passive: false,
  });
  document.addEventListener("mousedown", handleCompatibilityMouseDown, true);
  document.addEventListener("click", handleClick, true);
  host.addEventListener("contextmenu", handleContextMenu, true);
  host.addEventListener("keydown", handleKeyDown);
  host.addEventListener("scroll", cancel, true);
  document.addEventListener("visibilitychange", cancel);
  view?.addEventListener("blur", cancel);

  return () => {
    cancel();
    press = undefined;
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("pointermove", handlePointerMove, true);
    document.removeEventListener("pointerup", handlePointerEnd, true);
    document.removeEventListener("pointercancel", handlePointerEnd, true);
    document.removeEventListener("touchend", handleTouchEnd, true);
    document.removeEventListener(
      "mousedown",
      handleCompatibilityMouseDown,
      true
    );
    document.removeEventListener("click", handleClick, true);
    host.removeEventListener("contextmenu", handleContextMenu, true);
    host.removeEventListener("keydown", handleKeyDown);
    host.removeEventListener("scroll", cancel, true);
    document.removeEventListener("visibilitychange", cancel);
    view?.removeEventListener("blur", cancel);
  };
}
