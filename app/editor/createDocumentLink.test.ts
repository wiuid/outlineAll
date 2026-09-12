import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import uploadPlaceholder from "@shared/editor/lib/uploadPlaceholder";
import { p, schema } from "@shared/test/editor";
import { MentionType } from "@shared/types";
import { createDocumentLink } from "./createDocumentLink";

describe("createDocumentLink", () => {
  const search = "@Budget";
  const node = schema.nodes.mention.create({
    type: MentionType.Document,
    id: "mention-id",
    modelId: "new-document-id",
    label: "Budget",
  });
  let view: EditorView;

  beforeEach(() => {
    const doc = schema.nodes.doc.create(null, p(search));
    view = new EditorView(document.createElement("div"), {
      state: EditorState.create({
        doc,
        schema,
        selection: TextSelection.create(doc, search.length + 1),
        plugins: [uploadPlaceholder],
      }),
    });
  });

  afterEach(() => {
    if (!view.isDestroyed) {
      view.destroy();
    }
  });

  function startCreation() {
    let resolve = () => {};
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const create = vi.fn(async () => {
      await pending;
      return "/doc/new-document-id";
    });
    const result = createDocumentLink(view, {
      from: 1,
      to: search.length + 1,
      node,
      appendSpace: true,
      create,
    });
    return { resolve, result, create };
  }

  it("inserts a live mention only after creation succeeds", async () => {
    const { resolve, result, create } = startCreation();
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.state.doc.textContent).toBe(search);
    expect(view.dom.querySelector("a[data-id]")).toBeNull();
    expect(view.dom.querySelector('[aria-busy="true"]')).not.toBeNull();

    resolve();
    await result;

    expect(view.state.doc.firstChild?.firstChild).toEqual(node);
    expect(view.state.doc.firstChild?.lastChild?.text).toBe(" ");
    expect(
      view.dom.querySelector('[data-id="new-document-id"]')
    ).not.toBeNull();
    expect(uploadPlaceholder.getState(view.state)?.find()).toEqual([]);
  });

  it("maps the original range while keeping later typing and the current cursor", async () => {
    const { resolve, result } = startCreation();
    view.dispatch(view.state.tr.insertText("Prefix ", 1));
    view.dispatch(view.state.tr.insertText("suffix"));
    const cursor = view.state.selection.from;
    const focus = vi.spyOn(view, "focus");

    resolve();
    await result;

    expect(view.state.doc.firstChild?.child(0).text).toBe("Prefix ");
    expect(view.state.doc.firstChild?.child(1)).toEqual(node);
    expect(view.state.doc.firstChild?.lastChild?.text).toBe(" suffix");
    expect(view.state.selection.from).toBe(cursor - search.length + 2);
    expect(focus).not.toHaveBeenCalled();
  });

  it("keeps the original query when creation fails", async () => {
    const error = new Error("Creation denied");
    await expect(
      createDocumentLink(view, {
        from: 1,
        to: search.length + 1,
        node,
        create: () => Promise.reject(error),
      })
    ).rejects.toBe(error);

    expect(view.state.doc.textContent).toBe(search);
    expect(view.dom.querySelector("a[data-id]")).toBeNull();
    expect(uploadPlaceholder.getState(view.state)?.find()).toEqual([]);
  });

  it("does not overwrite a query edited while creation is pending", async () => {
    const { resolve, result } = startCreation();
    view.dispatch(view.state.tr.insertText("Annual ", 2));

    resolve();
    await result;

    expect(view.state.doc.textContent).toBe("@Annual Budget");
    expect(view.dom.querySelector("a[data-id]")).toBeNull();
    expect(uploadPlaceholder.getState(view.state)?.find()).toEqual([]);
  });

  it("does not restore a query deleted while creation is pending", async () => {
    const { resolve, result } = startCreation();
    view.dispatch(view.state.tr.delete(1, search.length + 1));

    resolve();
    await result;

    expect(view.state.doc.textContent).toBe("");
    expect(view.dom.querySelector("a[data-id]")).toBeNull();
    expect(uploadPlaceholder.getState(view.state)?.find()).toEqual([]);
  });

  it("does not dispatch into an editor closed before creation finishes", async () => {
    const { resolve, result } = startCreation();
    view.destroy();
    const dispatch = vi.spyOn(view, "dispatch");

    resolve();
    await result;

    expect(dispatch).not.toHaveBeenCalled();
  });
});
