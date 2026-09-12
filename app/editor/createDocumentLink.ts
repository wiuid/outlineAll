import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { v4 as uuidv4 } from "uuid";
import uploadPlaceholder, {
  findPlaceholder,
} from "@shared/editor/lib/uploadPlaceholder";

interface Options {
  from: number;
  to: number;
  node: Node;
  appendSpace?: boolean;
  create: () => Promise<string>;
}

/**
 * Creates a document before linking it, tracking the original text as it moves.
 *
 * @param view the editor in which the creation was requested.
 * @param options the search range, mention and document creation callback.
 * @returns once creation finishes, without replacing text edited while waiting.
 * @throws {Error} if the document could not be created.
 */
export async function createDocumentLink(
  view: EditorView,
  { from, to, node, appendSpace, create }: Options
): Promise<void> {
  const id = uuidv4();
  const original = view.state.doc.slice(from, to);
  view.dispatch(
    view.state.tr.setMeta(uploadPlaceholder, {
      add: { id, from, to, inline: true },
    })
  );

  try {
    await create();
    if (view.isDestroyed) {
      return;
    }
    const range = findPlaceholder(view.state, id);
    if (!range) {
      return;
    }
    const [start, end] = range;
    if (!view.state.doc.slice(start, end).eq(original)) {
      return;
    }

    view.dispatch(
      view.state.tr
        .replaceWith(
          start,
          end,
          appendSpace ? [node, view.state.schema.text(" ")] : node
        )
        .setMeta(uploadPlaceholder, { remove: { id } })
    );
  } finally {
    if (!view.isDestroyed && findPlaceholder(view.state, id)) {
      view.dispatch(
        view.state.tr.setMeta(uploadPlaceholder, { remove: { id } })
      );
    }
  }
}
