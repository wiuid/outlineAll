import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import Extension from "@shared/editor/lib/Extension";
import {
  createClipboardTextSerializer,
  sanitizeClipboardHTML,
} from "@shared/editor/lib/markdown/clipboardSerializer";

/**
 * Copies selected source text with the document's clipboard formatting rules.
 */
export default class ClipboardTextSerializer extends Extension {
  get name() {
    return "clipboardTextSerializer";
  }

  get allowInReadOnly() {
    return true;
  }

  get plugins() {
    const mdSerializer = this.editor.extensions.serializer();

    return [
      new Plugin({
        key: new PluginKey("clipboardTextSerializer"),
        props: {
          handleDOMEvents: {
            copy: this.handleCopy,
          },
          clipboardTextSerializer: createClipboardTextSerializer(mdSerializer),
        },
      }),
    ];
  }

  private handleCopy = (view: EditorView, event: ClipboardEvent): boolean => {
    if (!event.clipboardData || view.state.selection.empty) {
      return false;
    }

    const { dom, slice } = view.serializeForClipboard(
      view.state.selection.content()
    );
    const text =
      view.someProp("clipboardTextSerializer", (serializer) =>
        serializer(slice, view)
      ) || "";

    event.preventDefault();
    event.clipboardData.clearData();
    event.clipboardData.setData(
      "text/html",
      sanitizeClipboardHTML(dom.innerHTML)
    );
    event.clipboardData.setData("text/plain", text);
    return true;
  };
}
