import { DOCS_NORMAL_EDITOR_UNIT_ID_KEY } from "@univerjs/core";
import { vi } from "vitest";
import { bindTableMobileInput, observeTableViewport } from "./tableMobile";

const editorId = `__editor_${DOCS_NORMAL_EDITOR_UNIT_ID_KEY}`;

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
