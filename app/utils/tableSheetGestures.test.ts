import { bindTableSheetGestures } from "./tableSheetGestures";

describe("mobile worksheet management gestures", () => {
  let host: HTMLDivElement;
  let tab: HTMLDivElement;
  let label: HTMLSpanElement;
  let manage = vi.fn<(sheetId: string, tab: HTMLElement) => void>();
  let dispose: () => void;

  const pointer = (
    type: string,
    target: Element,
    options: PointerEventInit = {}
  ) =>
    target.dispatchEvent(
      Object.assign(
        new MouseEvent(type, { bubbles: true, cancelable: true, ...options }),
        {
          pointerId: options.pointerId ?? 1,
          pointerType: options.pointerType ?? "touch",
          isPrimary: options.isPrimary ?? true,
        }
      )
    );

  const click = (target: Element) =>
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })
    );

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    const footer = document.createElement("footer");
    const tabs = document.createElement("div");
    tabs.setAttribute("role", "tablist");
    tab = document.createElement("div");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "sheet-test-sheet");
    label = document.createElement("span");
    tab.append(label);
    tabs.append(tab);
    footer.append(tabs);
    host.append(footer);
    document.body.append(host);
    manage = vi.fn<(sheetId: string, tab: HTMLElement) => void>();
    dispose = bindTableSheetGestures(host, manage);
  });

  afterEach(() => {
    dispose();
    host.remove();
    vi.useRealTimers();
  });

  it("leaves ordinary taps to the native sheet switcher", () => {
    const select = vi.fn();
    tab.addEventListener("click", select);
    pointer("pointerdown", label);
    vi.advanceTimersByTime(499);
    pointer("pointerup", label);
    expect(click(label)).toBe(true);
    vi.advanceTimersByTime(600);
    expect(select).toHaveBeenCalledOnce();
    expect(manage).not.toHaveBeenCalled();
    expect(tab.hasAttribute("data-table-sheet-pressed")).toBe(false);
  });

  it("opens once after a hold and requires a fresh tap to choose an action", () => {
    pointer("pointerdown", label);
    vi.advanceTimersByTime(500);
    expect(manage).toHaveBeenCalledExactlyOnceWith("test-sheet", tab);
    const context = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    label.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
    expect(manage).toHaveBeenCalledOnce();

    pointer("pointerup", label);
    const release = new Event("touchend", { bubbles: true, cancelable: true });
    label.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(true);
    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    label.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    // Opening the menu can put a different element under the held finger.
    const action = document.createElement("button");
    host.append(action);
    const execute = vi.fn();
    action.addEventListener("click", execute);
    expect(click(action)).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    pointer("pointerdown", action);
    pointer("pointerup", action);
    expect(click(action)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("cancels a hold when the finger starts scrolling", () => {
    pointer("pointerdown", label, { clientX: 80, clientY: 20 });
    vi.advanceTimersByTime(200);
    expect(pointer("pointermove", label, { clientX: 60, clientY: 20 })).toBe(
      true
    );
    vi.advanceTimersByTime(600);
    expect(manage).not.toHaveBeenCalled();
    expect(tab.hasAttribute("data-table-sheet-pressed")).toBe(false);
  });

  it.each(["pointercancel", "scroll", "blur"])(
    "cancels a pending hold after %s",
    (eventType) => {
      pointer("pointerdown", label);
      if (eventType === "pointercancel") {
        pointer(eventType, label);
      } else if (eventType === "scroll") {
        tab.parentElement?.dispatchEvent(new Event(eventType));
      } else {
        window.dispatchEvent(new Event(eventType));
      }
      vi.advanceTimersByTime(600);
      expect(manage).not.toHaveBeenCalled();
    }
  );

  it("cancels management when a second finger starts a gesture", () => {
    pointer("pointerdown", label);
    vi.advanceTimersByTime(200);
    pointer("pointerdown", label, { pointerId: 2, isPrimary: false });
    vi.advanceTimersByTime(600);
    expect(manage).not.toHaveBeenCalled();
  });

  it("supports right click and the keyboard menu without changing other controls", () => {
    label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(manage).toHaveBeenCalledExactlyOnceWith("test-sheet", tab);
    manage.mockClear();
    const keyboardMenu = new KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    tab.dispatchEvent(keyboardMenu);
    expect(keyboardMenu.defaultPrevented).toBe(true);
    expect(manage).toHaveBeenCalledExactlyOnceWith("test-sheet", tab);

    const select = vi.fn();
    tab.addEventListener("click", select);
    tab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    expect(select).toHaveBeenCalledOnce();
    manage.mockClear();
    pointer("pointerdown", host);
    vi.advanceTimersByTime(600);
    expect(manage).not.toHaveBeenCalled();
  });

  it("cleans up pending timers and can be mounted again without duplicate handlers", () => {
    pointer("pointerdown", label);
    dispose();
    vi.advanceTimersByTime(600);
    expect(manage).not.toHaveBeenCalled();
    expect(tab.hasAttribute("data-table-sheet-pressed")).toBe(false);

    dispose = bindTableSheetGestures(host, manage);
    pointer("pointerdown", label);
    vi.advanceTimersByTime(500);
    expect(manage).toHaveBeenCalledExactlyOnceWith("test-sheet", tab);
    dispose();
    expect(click(label)).toBe(true);
  });
});
