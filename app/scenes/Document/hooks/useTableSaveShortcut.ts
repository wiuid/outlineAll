import { useEffect } from "react";
import { useSplitView } from "~/components/SplitView/context";
import { getFocusedSplitPane } from "~/utils/splitView";

/**
 * Replaces the browser save shortcut while this table's pane is active.
 * Capture also handles Univer inputs and menus rendered outside the workspace.
 *
 * @param onSave commits the current cell and handles the guarded save result.
 * @returns nothing; the listener is removed when the hook unmounts.
 */
export function useTableSaveShortcut(onSave: () => Promise<void>): void {
  const { pane, isSplitView } = useSplitView();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.target instanceof Element &&
          event.target.closest("[data-table-script-panel]")) ||
        (isSplitView && pane !== getFocusedSplitPane()) ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        (event.code !== "KeyS" && event.key.toLowerCase() !== "s")
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat && !event.isComposing) {
        void onSave();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isSplitView, onSave, pane]);
}
