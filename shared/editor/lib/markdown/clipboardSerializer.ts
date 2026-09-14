import type { Node as ProsemirrorNode, Slice } from "prosemirror-model";
import { MarkdownSerializer, type MarkdownSerializerState } from "./serializer";

/**
 * Creates a selection serializer that preserves source text while applying the
 * document's clipboard formatting rules to nodes and marks, never to raw text.
 *
 * @param serializer the document serializer whose remaining formatting is reused.
 * @returns a plain clipboard text serializer that does not change Markdown export.
 */
export function createClipboardTextSerializer(
  serializer: MarkdownSerializer
): (slice: Slice) => string {
  const clipboard = new MarkdownSerializer(
    {
      ...serializer.nodes,
      text: (state: MarkdownSerializerState, node: ProsemirrorNode) =>
        state.text(node.text ?? "", false),
      code_block: renderCode,
      code_fence: renderCode,
      heading: (state: MarkdownSerializerState, node: ProsemirrorNode) => {
        state.renderInline(node);
        state.closeBlock(node);
      },
      bullet_list: (state: MarkdownSerializerState, node: ProsemirrorNode) =>
        state.renderList(node, "  ", () => "- "),
    },
    {
      ...serializer.marks,
      link: () => ({ open: "", close: "" }),
      highlight: () => ({ open: "", close: "", mixable: true }),
      textColor: () => ({ open: "", close: "", mixable: true }),
    }
  );

  return (slice) => {
    let text = clipboard.serialize(slice.content, { commonMark: true });
    const firstType = slice.content.firstChild?.type.name;
    // These block serializers add a separator outside their content. Remove
    // only that separator, preserving selected code indentation and newlines.
    if (
      (firstType === "ordered_list" || firstType === "table") &&
      text.startsWith("\n")
    ) {
      text = text.slice(1);
    }
    if (slice.content.lastChild?.type.name === "table" && text.endsWith("\n")) {
      text = text.slice(0, -1);
    }
    return text;
  };
}

/**
 * Removes presentation and navigation semantics from the HTML clipboard
 * flavor while keeping bold text available to rich-text targets.
 *
 * @param html the editor's serialized clipboard HTML.
 * @returns clipboard HTML with the existing presentation rules applied.
 */
export function sanitizeClipboardHTML(html: string): string {
  return html
    .replace(/<h[1-6](?:\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/gi, "<p>$1</p>")
    .replace(/<a(?:\s[^>]*)?>([\s\S]*?)<\/a>/gi, "$1")
    .replace(
      /\s+(?:style|href|data-text-color|class)=(?:"[^"]*"|'[^']*')/gi,
      ""
    )
    .replace(/<ul(?:\s[^>]*)?>/gi, "<div>")
    .replace(/<\/ul>/gi, "</div>")
    .replace(/<li(?:\s[^>]*)?>/gi, "<div>- ")
    .replace(/<\/li>/gi, "</div>")
    .replace(/<ol(?:\s[^>]*)?>/gi, "<div>")
    .replace(/<\/ol>/gi, "</div>")
    .replace(/<span(?:\s[^>]*)?>/gi, "<span>");
}

function renderCode(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.text(node.textContent, false);
  state.closeBlock(node);
}
