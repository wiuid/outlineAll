import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import { light } from "@shared/styles/theme";
import type { ProsemirrorData } from "@shared/types";
import stores from "~/stores";
import Comment from "~/models/Comment";
import CommentForm from "./CommentForm";

vi.mock("~/hooks/useCurrentUser", () => ({
  default: () => ({ id: "author", name: "Author" }),
}));
vi.mock("~/hooks/useStores", () => ({ default: () => stores }));
vi.mock("~/components/DocumentContext", () => ({
  useDocumentContext: () => ({ editor: undefined }),
}));
vi.mock("~/components/Avatar", () => ({ Avatar: () => null }));
vi.mock("~/components/Tooltip", () => ({
  default: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("~/components/ButtonSmall", () => ({
  default: ({
    children,
    onClick,
    type,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("~/components/NudeButton", () => ({
  default: ({
    children,
    onClick,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("./CommentThreadItem", async () => ({
  Bubble: (await import("styled-components")).default.div``,
}));
vi.mock("./CommentEditor", async () => ({
  default: (await import("react")).forwardRef(() => <div>Comment editor</div>),
}));

describe("table comment payload", () => {
  it("submits a whole-document discussion without invoking an anchor callback", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    stores.documents.add({
      id: "comment-table",
      documentType: "table",
      title: "Table",
    });
    const save = vi
      .spyOn(stores.comments, "save")
      .mockImplementation(
        async (fields) => new Comment(fields, stores.comments)
      );
    const beforeCreate = vi.fn();
    const draft: ProsemirrorData = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Discuss this entire document" }],
        },
      ],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ThemeProvider theme={light}>
            <CommentForm
              documentId="comment-table"
              draft={draft}
              onSaveDraft={vi.fn()}
              onBeforeCreate={beforeCreate}
              standalone
            />
          </ThemeProvider>
        )
      );
      await act(async () =>
        container
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          )
      );
      expect(beforeCreate).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledWith(
        {
          id: expect.any(String),
          documentId: "comment-table",
          parentCommentId: undefined,
          data: draft,
        },
        { isNew: true }
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      save.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
