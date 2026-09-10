import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "styled-components";
import { light } from "@shared/styles/theme";
import { CommandType } from "@univerjs/core";
import { tableSaves } from "~/stores/TableSaveCoordinator";
import stores from "~/stores";
import { client } from "~/utils/ApiClient";
import TableDocument from "./TableDocument";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  command: () => {},
  setEditable: vi.fn(),
  setPermissionEditable: vi.fn(async () => {}),
  setReadOnly: vi.fn(async () => {}),
  endEditingAsync: vi.fn(async () => true),
  isCellEditing: vi.fn(() => false),
  save: vi.fn(() => ({ opaqueSnapshot: true })),
  dispose: vi.fn(),
  beforeCommand: vi.fn(),
  user: true,
  update: true,
}));
vi.mock("@univerjs/presets", () => ({
  createUniver: () => {
    mocks.create();
    return {
      univer: { dispose: mocks.dispose },
      univerAPI: {
        createWorkbook: () => ({
          setEditable: mocks.setEditable,
          onBeforeCommandExecute: mocks.beforeCommand.mockReturnValue({
            dispose: vi.fn(),
          }),
          getWorkbookPermission: () => ({
            setEditable: mocks.setPermissionEditable,
            setReadOnly: mocks.setReadOnly,
          }),
          isCellEditing: mocks.isCellEditing,
          endEditingAsync: mocks.endEditingAsync,
          save: mocks.save,
          onCommandExecuted: (callback: () => void) => {
            mocks.command = callback;
            return { dispose: vi.fn() };
          },
          getActiveSheet: () => ({ getZoom: () => 1, zoom: vi.fn() }),
        }),
        addEvent: () => ({ dispose: vi.fn() }),
        Event: {},
      },
    };
  },
}));
vi.mock("@univerjs/preset-sheets-core", () => ({
  UniverSheetsCorePreset: vi.fn(),
}));
vi.mock("@univerjs/sheets-ui", () => ({
  SetScrollRelativeCommand: { id: "scroll" },
}));
vi.mock("~/hooks/useMediaQuery", () => ({ default: () => false }));
vi.mock("~/hooks/usePolicy", () => ({
  default: () => ({ update: mocks.update }),
}));
vi.mock("~/hooks/useStores", () => ({
  default: () => ({
    ui: { toggleMobileSidebar: vi.fn() },
    auth: { user: mocks.user ? {} : undefined },
  }),
}));
vi.mock("~/components/Button", () => ({
  default: ({
    icon: _icon,
    neutral: _neutral,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: React.ReactNode;
    neutral?: boolean;
  }) => <button {...props} />,
}));
vi.mock("~/menus/DocumentMenu", () => ({
  default: ({ onRename }: { onRename?: () => void }) => (
    <button onClick={onRename}>Table document options</button>
  ),
}));

describe("table document management integration", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    mocks.user = true;
    mocks.update = true;
    mocks.create.mockClear();
    mocks.setEditable.mockClear();
    mocks.setPermissionEditable.mockClear();
    mocks.setReadOnly.mockClear();
    mocks.dispose.mockClear();
    mocks.isCellEditing.mockReturnValue(false);
    mocks.endEditingAsync.mockResolvedValue(true);
    vi.mocked(client.post).mockClear();
    vi.mocked(client.post).mockResolvedValue({ data: {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function render(readOnly = false) {
    const model = stores.documents.add({
      id: "table-ui",
      title: "Budget",
      documentType: "table",
    });
    await act(async () =>
      root.render(
        <ThemeProvider theme={light}>
          <TableDocument document={model} readOnly={readOnly} />
        </ThemeProvider>
      )
    );
  }

  it("enforces workbook read-only permissions, not only hidden controls", async () => {
    mocks.update = false;
    await render(true);
    expect(mocks.setEditable).toHaveBeenCalledWith(false);
    expect(mocks.setReadOnly).toHaveBeenCalledOnce();
    const guard = mocks.beforeCommand.mock.calls[0][0];
    expect(() => guard({ type: CommandType.MUTATION })).toThrow(
      "Table is read-only"
    );
    expect(() => guard({ type: CommandType.OPERATION })).not.toThrow();
  });

  it("provides the table menu and its rename callback", async () => {
    await render();
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Table document options"
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(
      container.querySelector('input[aria-label="文档标题"]')
    ).not.toBeNull();
  });

  it("does not dispose the live workbook during Strict Mode effect replay", async () => {
    const model = stores.documents.add({
      id: "strict-table-ui",
      title: "Budget",
      documentType: "table",
    });
    await act(async () => {
      root.render(
        <ThemeProvider theme={light}>
          <StrictMode>
            <TableDocument document={model} readOnly={false} />
          </StrictMode>
        </ThemeProvider>
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it("replaces the workbook when the rendered document changes", async () => {
    const first = stores.documents.add({
      id: "first-table-ui",
      title: "First",
      documentType: "table",
    });
    const second = stores.documents.add({
      id: "second-table-ui",
      title: "Second",
      documentType: "table",
    });
    await act(async () =>
      root.render(
        <ThemeProvider theme={light}>
          <TableDocument document={first} readOnly={false} />
        </ThemeProvider>
      )
    );
    await act(async () =>
      root.render(
        <ThemeProvider theme={light}>
          <TableDocument document={second} readOnly={false} />
        </ThemeProvider>
      )
    );
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("updates Univer permissions when the same document becomes read-only", async () => {
    const model = stores.documents.add({
      id: "permission-table-ui",
      title: "Permissions",
      documentType: "table",
    });
    await act(async () =>
      root.render(
        <ThemeProvider theme={light}>
          <TableDocument document={model} readOnly={false} />
        </ThemeProvider>
      )
    );
    await act(async () =>
      root.render(
        <ThemeProvider theme={light}>
          <TableDocument document={model} readOnly />
        </ThemeProvider>
      )
    );
    expect(mocks.setEditable).toHaveBeenLastCalledWith(false);
    expect(mocks.setReadOnly).toHaveBeenCalled();
  });

  it("flushes an opaque pending snapshot before an action can proceed", async () => {
    await render();
    mocks.command();
    expect(tableSaves.hasPending).toBe(true);
    await act(async () => tableSaves.flush());
    expect(client.post).toHaveBeenCalledWith(
      "/documents.update",
      {
        id: "table-ui",
        tableData: { opaqueSnapshot: true },
        done: true,
      },
      { tableSave: true }
    );
    expect(tableSaves.hasPending).toBe(false);
  });

  it("commits an active cell edit before saving its snapshot", async () => {
    await render();
    mocks.isCellEditing.mockReturnValue(true);
    await act(async () => tableSaves.flush());
    expect(mocks.endEditingAsync).toHaveBeenCalledWith(true);
    expect(client.post).toHaveBeenCalled();
  });

  it("does not mount the authenticated document menu on an anonymous share", async () => {
    mocks.user = false;
    await render(true);
    expect(container.textContent).not.toContain("Table document options");
  });
});
