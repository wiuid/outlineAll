import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from "@univerjs/core";
import { vi } from "vitest";
import {
  bindTableMobileHeaderSelection,
  bindTableMobileInput,
  createTableMobileTextEditor,
  observeTableViewport,
} from "./tableMobile";

const editorId = `__editor_${DOCS_NORMAL_EDITOR_UNIT_ID_KEY}`;

function dispatchTouch(
  target: EventTarget,
  type: string,
  touches: Array<{ clientX: number; clientY: number }>
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  target.dispatchEvent(event);
  return event;
}

describe("mobile table keyboard", () => {
  it("controls only the cell editor and waits for its asynchronous mount", async () => {
    const host = document.createElement("div");
    const title = document.createElement("input");
    host.append(title);
    document.body.append(host);
    const binding = bindTableMobileInput(host);
    const editor = document.createElement("div");
    editor.id = editorId;
    editor.tabIndex = 0;
    host.append(editor);
    await Promise.resolve();

    expect(editor.getAttribute("inputmode")).toBe("none");
    expect(editor.getAttribute("enterkeyhint")).toBe("done");
    expect(title.hasAttribute("inputmode")).toBe(false);

    editor.focus();
    binding.setEditing(true);
    expect(editor.getAttribute("inputmode")).toBe("text");
    expect(document.activeElement).not.toBe(editor);
    // Univer focuses the native input after announcing that editing starts.
    editor.focus();
    binding.setEditing(false);
    expect(editor.getAttribute("inputmode")).toBe("none");
    expect(document.activeElement).not.toBe(editor);

    title.focus();
    binding.setEditing(true);
    binding.setEditing(false);
    expect(document.activeElement).toBe(title);
    binding.dispose();
    expect(editor.hasAttribute("inputmode")).toBe(false);
    expect(editor.hasAttribute("enterkeyhint")).toBe(false);
    host.remove();
  });

  it("handles editor replacement and releases observers on disposal", async () => {
    const host = document.createElement("div");
    const first = document.createElement("div");
    first.id = editorId;
    first.setAttribute("inputmode", "decimal");
    first.setAttribute("enterkeyhint", "enter");
    host.append(first);
    const binding = bindTableMobileInput(host);
    binding.setEditing(true);
    const replacement = document.createElement("div");
    replacement.id = editorId;
    first.replaceWith(replacement);
    await Promise.resolve();
    expect(first.getAttribute("inputmode")).toBe("decimal");
    expect(first.getAttribute("enterkeyhint")).toBe("enter");
    expect(replacement.getAttribute("inputmode")).toBe("text");

    binding.dispose();
    const next = document.createElement("div");
    next.id = editorId;
    replacement.replaceWith(next);
    await Promise.resolve();
    expect(next.hasAttribute("inputmode")).toBe(false);
  });
});

describe("mobile table text editor", () => {
  it("uses a selectable textarea and commits its final value", () => {
    const host = document.createElement("div");
    const onCommit = vi.fn();
    const onClose = vi.fn();
    document.body.append(host);
    const editor = createTableMobileTextEditor(host);

    editor.open({
      ariaLabel: "Edit cell",
      getBounds: () => new DOMRect(20, 30, 80, 24),
      onCommit,
      onClose,
      value: "first\nsecond",
    });
    const textarea = document.querySelector<HTMLTextAreaElement>(
      ".outline-table-mobile-text-editor"
    );
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("first\nsecond");
    expect(textarea?.getAttribute("aria-label")).toBe("Edit cell");
    expect(textarea?.selectionStart).toBe(12);
    expect(textarea?.style.width).toBe("120px");

    if (textarea) {
      textarea.value = "updated\nvalue";
    }
    editor.commit();
    expect(onCommit).toHaveBeenCalledWith("updated\nvalue");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".outline-table-mobile-text-editor")).toBe(
      null
    );
    editor.dispose();
    host.remove();
  });

  it("cancels without writing and replaces an existing editor", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createTableMobileTextEditor(host);
    const firstCommit = vi.fn();
    const firstClose = vi.fn();
    const secondCommit = vi.fn();

    editor.open({
      ariaLabel: "Edit cell",
      getBounds: () => new DOMRect(0, 0, 160, 44),
      onCommit: firstCommit,
      onClose: firstClose,
      value: "first",
    });
    editor.open({
      ariaLabel: "Edit cell",
      getBounds: () => new DOMRect(0, 0, 160, 44),
      onCommit: secondCommit,
      onClose: vi.fn(),
      value: "second",
    });
    expect(firstCommit).not.toHaveBeenCalled();
    expect(firstClose).toHaveBeenCalledTimes(1);

    editor.cancel();
    expect(secondCommit).not.toHaveBeenCalled();
    editor.dispose();
    host.remove();
  });
});

describe("mobile table header selection", () => {
  it("turns a row-header drag into one inclusive range", () => {
    const canvas = document.createElement("canvas");
    const select = vi.fn();
    const dispose = bindTableMobileHeaderSelection(canvas, {
      getTarget: (_x, y, axis) => ({
        axis: axis ?? "row",
        index: Math.floor(y / 20),
      }),
      select,
    });

    dispatchTouch(canvas, "touchstart", [{ clientX: 10, clientY: 45 }]);
    const smallMove = dispatchTouch(canvas, "touchmove", [
      { clientX: 10, clientY: 49 },
    ]);
    expect(smallMove.defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();

    const drag = dispatchTouch(canvas, "touchmove", [
      { clientX: 10, clientY: 125 },
    ]);
    expect(drag.defaultPrevented).toBe(true);
    expect(select).toHaveBeenLastCalledWith("row", 2, 6);

    const end = dispatchTouch(canvas, "touchend", []);
    expect(end.defaultPrevented).toBe(true);
    dispose();
  });

  it("keeps taps and body gestures native and supports reverse column drags", () => {
    const canvas = document.createElement("canvas");
    const select = vi.fn();
    const dispose = bindTableMobileHeaderSelection(canvas, {
      getTarget: (x, _y, axis) =>
        axis || x < 40
          ? { axis: axis ?? "column", index: Math.floor(x / 20) }
          : undefined,
      select,
    });

    dispatchTouch(canvas, "touchstart", [{ clientX: 80, clientY: 80 }]);
    const bodyMove = dispatchTouch(canvas, "touchmove", [
      { clientX: 20, clientY: 80 },
    ]);
    expect(bodyMove.defaultPrevented).toBe(false);

    dispatchTouch(canvas, "touchstart", [{ clientX: 30, clientY: 5 }]);
    const tapEnd = dispatchTouch(canvas, "touchend", []);
    expect(tapEnd.defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();

    dispatchTouch(canvas, "touchstart", [{ clientX: 30, clientY: 5 }]);
    dispatchTouch(canvas, "touchmove", [{ clientX: 10, clientY: 5 }]);
    expect(select).toHaveBeenLastCalledWith("column", 1, 0);
    dispose();
  });
});

describe("mobile table viewport", () => {
  let workspace: HTMLDivElement;
  let viewport: EventTarget & {
    height: number;
    offsetTop: number;
    scale: number;
  };
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    workspace = document.createElement("div");
    viewport = Object.assign(new EventTarget(), {
      height: 844,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    dispose = () => {};
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fits above the keyboard, follows browser panning and restores the full height", () => {
    const reveal = vi.fn();
    dispose = observeTableViewport(workspace, reveal);
    expect(workspace.style.getPropertyValue("--table-viewport-height")).toBe(
      "844px"
    );
    vi.advanceTimersByTime(40);
    reveal.mockClear();

    viewport.height = 480;
    viewport.offsetTop = 64;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(40);
    expect(workspace.style.getPropertyValue("--table-viewport-height")).toBe(
      "480px"
    );
    expect(workspace.style.getPropertyValue("--table-viewport-offset")).toBe(
      "64px"
    );
    expect(reveal).toHaveBeenCalledTimes(1);

    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(40);
    expect(workspace.style.getPropertyValue("--table-viewport-height")).toBe(
      "844px"
    );
    expect(workspace.style.getPropertyValue("--table-viewport-offset")).toBe(
      "0px"
    );
  });

  it("preserves layout during browser page zoom and handles rotation afterwards", () => {
    dispose = observeTableViewport(workspace, vi.fn());
    viewport.scale = 2;
    viewport.height = 422;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(40);
    expect(workspace.style.getPropertyValue("--table-viewport-height")).toBe(
      "844px"
    );

    viewport.scale = 1;
    viewport.height = 390;
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(40);
    expect(workspace.style.getPropertyValue("--table-viewport-height")).toBe(
      "390px"
    );
  });

  it("falls back to the layout viewport when VisualViewport is unavailable", () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerHeight", 700);
    dispose = observeTableViewport(workspace, vi.fn());
    expect(workspace.style.getPropertyValue("--table-viewport-height")).toBe(
      "700px"
    );
  });

  it("reveals the editing cell again when Univer finishes its deferred canvas resize", async () => {
    const canvas = document.createElement("canvas");
    canvas.id = "univer-sheet-main-canvas_test";
    workspace.append(canvas);
    const reveal = vi.fn();
    dispose = observeTableViewport(workspace, reveal);
    vi.advanceTimersByTime(40);
    reveal.mockClear();

    viewport.height = 400;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(40);
    expect(reveal).toHaveBeenCalledTimes(1);
    canvas.height = 160;
    await Promise.resolve();
    vi.advanceTimersByTime(40);
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it("cancels pending notifications and restores styles when a document unmounts", () => {
    workspace.style.setProperty("--table-viewport-height", "90dvh");
    const reveal = vi.fn();
    dispose = observeTableViewport(workspace, reveal);
    viewport.height = 400;
    viewport.dispatchEvent(new Event("resize"));
    dispose();
    vi.advanceTimersByTime(100);
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(100);
    expect(reveal).not.toHaveBeenCalled();
    expect(workspace.style.getPropertyValue("--table-viewport-height")).toBe(
      "90dvh"
    );
    expect(workspace.style.getPropertyValue("--table-viewport-offset")).toBe(
      ""
    );
  });
});
