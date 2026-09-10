import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import { light } from "@shared/styles/theme";
import stores from "~/stores";
import { CommentSortType } from "~/types";
import type * as ReactRouterDOM from "react-router-dom";
import Comments from "./Comments";

const state = vi.hoisted(() => ({
  initialized: false,
  canComment: true,
  documentId: "table-comments",
  getComments: vi.fn(() => []),
}));
vi.mock("~/hooks/useStores", async () => ({ default: () => stores }));
vi.mock("~/hooks/useCurrentUser", () => ({
  default: () => ({ id: "author", getPreference: () => true }),
}));
vi.mock("~/hooks/usePolicy", () => ({
  default: () => ({ comment: state.canComment }),
}));
vi.mock("~/hooks/useMobile", () => ({ default: () => false }));
vi.mock("~/hooks/useQuery", () => ({ default: () => new URLSearchParams() }));
vi.mock("~/hooks/useFocusedComment", () => ({
  useFocusedComment: () => undefined,
}));
vi.mock("~/hooks/useKeyDown", () => ({ default: vi.fn() }));
vi.mock("~/components/SplitView/context", () => ({
  useSplitView: () => ({ pane: "primary" }),
}));
vi.mock(
  "react-router-dom",
  async (original: () => Promise<typeof ReactRouterDOM>) => ({
    ...(await original()),
    useRouteMatch: () => ({ params: { documentSlug: state.documentId } }),
  })
);
vi.mock("~/components/DocumentContext", () => ({
  useDocumentContext: () => ({
    editor: { getComments: state.getComments },
    isEditorInitialized: state.initialized,
    setFocusedCommentId: vi.fn(),
  }),
}));
vi.mock("../SidebarLayout", () => ({
  default: ({
    children,
    title,
  }: React.PropsWithChildren<{ title: React.ReactNode }>) => (
    <section>
      {title}
      {children}
    </section>
  ),
}));
vi.mock("./CommentForm", () => ({
  default: ({
    documentId,
    standalone,
  }: {
    documentId: string;
    standalone: boolean;
  }) => <form data-document-id={documentId} data-standalone={standalone} />,
}));
vi.mock("./CommentThread", () => ({ default: () => <div>Thread</div> }));
vi.mock("~/components/InputSelect", () => ({
  InputSelect: ({
    options,
    value,
  }: {
    options: { label?: string; value?: string }[];
    value: string;
  }) => (
    <select value={value} onChange={() => {}}>
      {options
        .filter((item) => item.value)
        .map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
    </select>
  ),
}));

describe("table document discussion", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      }
    );
    HTMLElement.prototype.scrollTo = vi.fn();
    state.initialized = false;
    state.canComment = true;
    state.getComments.mockClear();
    stores.documents.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(type: "table" | "document" = "table") {
    stores.documents.add({
      id: state.documentId,
      title: "Discussion",
      documentType: type,
    });
    await act(async () =>
      root.render(
        <ThemeProvider theme={light}>
          <Comments />
        </ThemeProvider>
      )
    );
  }
  it("shows a whole-document comment form before any rich-text editor initializes", async () => {
    await render();
    expect(
      container.querySelector(
        'form[data-document-id="table-comments"][data-standalone="true"]'
      )
    ).not.toBeNull();
    expect(state.getComments).not.toHaveBeenCalled();
  });
  it("does not offer rich-text anchor ordering for tables", async () => {
    await render();
    expect(
      container.querySelector(
        `option[value="${CommentSortType.OrderInDocument}"]`
      )
    ).toBeNull();
  });
  it("keeps normal document comments gated by editor initialization", async () => {
    await render("document");
    expect(container.querySelector("form")).toBeNull();
  });
  it("respects existing comment permission", async () => {
    state.canComment = false;
    await render();
    expect(container.querySelector("form")).toBeNull();
  });
});
