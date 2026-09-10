import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { Provider } from "mobx-react";
import { ThemeProvider } from "styled-components";
import { light } from "@shared/styles/theme";
import stores from "~/stores";
import DocumentMenu from "./DocumentMenu";

vi.mock("~/hooks/useCurrentUser", () => ({
  default: () => ({
    getPreference: vi.fn(),
    setPreference: vi.fn(),
    save: vi.fn(),
  }),
}));
vi.mock("~/hooks/usePolicy", () => ({
  default: () => ({ update: true, updateInsights: true }),
}));
vi.mock("~/hooks/useMobile", () => ({ default: () => false }));
vi.mock("~/hooks/useTemplateMenuActions", () => ({
  useTemplateMenuActions: () => [],
}));
vi.mock("~/components/Menu/DropdownMenu", () => ({
  DropdownMenu: ({ append }: { append: React.ReactNode }) => (
    <div>{append}</div>
  ),
}));
vi.mock("~/components/Switch", () => ({
  default: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("~/components/primitives/components/Menu", () => ({
  MenuSeparator: () => <hr />,
}));
vi.mock("~/components/Menu/transformer", () => ({
  toMenuItems: () => <span>Heading numbering</span>,
  toMobileMenuItems: () => null,
}));

describe("document menu display controls", () => {
  it.each(["table", "document"] satisfies ("table" | "document")[])(
    "keeps the correct display options for %s",
    async (documentType) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const model = stores.documents.add({
        id: `display-${documentType}`,
        title: "Menu",
        documentType,
      });
      stores.policies.add({ id: model.id, abilities: { update: true } });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <Provider rootStore={stores}>
              <MemoryRouter>
                <ThemeProvider theme={light}>
                  <DocumentMenu
                    document={model}
                    showDisplayOptions
                    showToggleEmbeds
                  />
                </ThemeProvider>
              </MemoryRouter>
            </Provider>
          )
        );
        expect(container.textContent).toContain("Enable viewer insights");
        if (documentType === "table") {
          expect(container.textContent).not.toContain("Full width");
          expect(container.textContent).not.toContain("Enable embeds");
          expect(container.textContent).not.toContain("Heading numbering");
        } else {
          expect(container.textContent).toContain("Full width");
          expect(container.textContent).toContain("Enable embeds");
          expect(container.textContent).toContain("Heading numbering");
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    }
  );
});
