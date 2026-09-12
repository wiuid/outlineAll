import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { SplitViewContextValue } from "~/components/SplitView/context";
import { SplitViewContext } from "~/components/SplitView/context";
import { setFocusedSplitPane } from "~/utils/splitView";
import { useTableSaveShortcut } from "./useTableSaveShortcut";

const cleanups = new Set<() => void>();

function SaveShortcut({ onSave }: { onSave: () => Promise<void> }) {
  useTableSaveShortcut(onSave);
  return null;
}

async function mountShortcut(
  onSave: () => Promise<void>,
  context: SplitViewContextValue = {
    pane: "primary",
    isSplitView: false,
    isFocused: true,
  }
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const cleanup = () => {
    root.unmount();
    container.remove();
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          SplitViewContext.Provider,
          { value: context },
          createElement(SaveShortcut, { onSave })
        )
      )
    );
  });
  return cleanup;
}

function pressSave(target: EventTarget, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "s",
    code: "KeyS",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
  setFocusedSplitPane("primary");
  vi.unstubAllGlobals();
});

const modifiers: ("ctrlKey" | "metaKey")[] = ["ctrlKey", "metaKey"];
it.each(modifiers)(
  "cancels the browser's %s+S from a portaled input, even when it stops propagation",
  async (modifier) => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue();
    await mountShortcut(onSave);
    const input = document.createElement("input");
    document.body.append(input);
    input.addEventListener("keydown", (event) => event.stopPropagation());
    try {
      const event = pressSave(input, { ctrlKey: false, [modifier]: true });
      expect(event.defaultPrevented).toBe(true);
      expect(onSave).toHaveBeenCalledTimes(1);
    } finally {
      input.remove();
    }
  }
);

it("saves from page focus and removes the capture listener after leaving", async () => {
  const onSave = vi.fn<() => Promise<void>>().mockResolvedValue();
  const unmount = await mountShortcut(onSave);
  expect(pressSave(document.body).defaultPrevented).toBe(true);
  expect(onSave).toHaveBeenCalledTimes(1);

  await act(async () => unmount());
  expect(pressSave(document.body).defaultPrevented).toBe(false);
  expect(onSave).toHaveBeenCalledTimes(1);
});

it("does not interrupt composition or repeatedly save a held key", async () => {
  const onSave = vi.fn<() => Promise<void>>().mockResolvedValue();
  await mountShortcut(onSave);
  expect(pressSave(document.body, { isComposing: true }).defaultPrevented).toBe(
    true
  );
  expect(pressSave(document.body, { repeat: true }).defaultPrevented).toBe(
    true
  );
  expect(onSave).not.toHaveBeenCalled();
  expect(pressSave(document.body).defaultPrevented).toBe(true);
  expect(onSave).toHaveBeenCalledTimes(1);
});

it("leaves ordinary typing and other modifier shortcuts unchanged", async () => {
  const onSave = vi.fn<() => Promise<void>>().mockResolvedValue();
  await mountShortcut(onSave);
  for (const options of [
    { ctrlKey: false },
    { shiftKey: true },
    { altKey: true },
    { key: "p", code: "KeyP" },
  ]) {
    expect(pressSave(document.body, options).defaultPrevented).toBe(false);
  }
  expect(onSave).not.toHaveBeenCalled();
});

it("saves only the currently focused split pane", async () => {
  const primarySave = vi.fn<() => Promise<void>>().mockResolvedValue();
  const secondarySave = vi.fn<() => Promise<void>>().mockResolvedValue();
  await mountShortcut(primarySave, {
    pane: "primary",
    isSplitView: true,
    isFocused: true,
  });
  await mountShortcut(secondarySave, {
    pane: "secondary",
    isSplitView: true,
    isFocused: false,
  });

  pressSave(document.body);
  expect(primarySave).toHaveBeenCalledTimes(1);
  expect(secondarySave).not.toHaveBeenCalled();

  setFocusedSplitPane("secondary");
  pressSave(document.body);
  expect(primarySave).toHaveBeenCalledTimes(1);
  expect(secondarySave).toHaveBeenCalledTimes(1);
});

it("does not intercept another editor's save shortcut in split view", async () => {
  const onSave = vi.fn<() => Promise<void>>().mockResolvedValue();
  await mountShortcut(onSave, {
    pane: "primary",
    isSplitView: true,
    isFocused: true,
  });
  setFocusedSplitPane("secondary");
  expect(pressSave(document.body).defaultPrevented).toBe(false);
  expect(onSave).not.toHaveBeenCalled();
});
