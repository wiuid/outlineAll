import { t } from "i18next";
import {
  actionToMenuItem,
  actionToKBar,
  resolve,
  performAction,
} from "~/actions";
import { tableSaves } from "~/stores/TableSaveCoordinator";
import type Document from "~/models/Document";
import type Model from "~/models/base/Model";
import stores from "~/stores";
import type { ActionContext, ActionVariant } from "~/types";
import history from "~/utils/history";
import { createTableDocumentMenuAction } from "./tableDocuments";
import {
  duplicateDocument,
  createTemplateFromDocument,
  applyTemplateActionFactory,
  openDocumentHistory,
  downloadDocumentAsMarkdown,
  downloadDocumentAsHTML,
  downloadDocumentAsTextBundle,
  downloadDocumentAsPDF,
  exportDocument,
  printDocument,
  copyDocumentAsMarkdown,
  copyDocumentAsPlainText,
  searchInDocument,
  presentDocument,
  toggleDocumentStats,
  changeHeadingPrefix,
  openDocumentInSplit,
  copyDocumentLink,
  moveDocument,
  shareDocument,
  archiveDocument,
  openDocumentInsights,
  renameTableDocument,
} from "./documents";

function contextFor(document: Document): ActionContext {
  const models: Model[] = [document];
  const getActiveModels = <T extends Model>(
    modelClass: new (...args: never[]) => T
  ): T[] => models.filter((model): model is T => model instanceof modelClass);

  return {
    isMenu: true,
    isCommandBar: false,
    isButton: false,
    activeDocumentId: document.id,
    activeCollectionId: document.collectionId ?? undefined,
    currentUserId: undefined,
    currentTeamId: undefined,
    activeModels: new Set(models),
    getActiveModels,
    getActiveModel: (modelClass) => getActiveModels(modelClass)[0],
    getActivePolicies: () => [],
    isModelActive: (model) => models.includes(model),
    location: history.location,
    stores,
    t,
  };
}

describe("table document actions", () => {
  it("provides the same table-only management list with Rename without an inline callback", () => {
    const document = stores.documents.add({
      id: "table-context",
      documentType: "table",
      title: "Table",
    });
    stores.policies.add({
      id: document.id,
      abilities: {
        update: true,
        duplicate: true,
        listRevisions: true,
        download: true,
      },
    });
    const menu = actionToMenuItem(
      createTableDocumentMenuAction(document.id),
      contextFor(document)
    );
    expect(menu.type).toBe("submenu");
    if (menu.type !== "submenu") {
      throw new Error("Expected submenu");
    }
    const titles = menu.items
      .filter((item) => "visible" in item && item.visible && "title" in item)
      .map((item) => ("title" in item ? item.title : undefined));
    expect(titles).toContain("Rename…");
    expect(titles).not.toContain("Duplicate…");
    expect(titles).not.toContain("History");
    expect(titles).not.toContain("Export");
  });
  it("does not open a lifecycle dialog when the pending table save fails", async () => {
    const document = stores.documents.add({
      id: "table-action",
      documentType: "table",
    });
    stores.policies.add({ id: document.id, abilities: { move: true } });
    const openModal = vi.spyOn(stores.dialogs, "openModal");
    const unregister = tableSaves.register({
      hasPending: () => true,
      flush: async () => {
        throw new Error("Table save failed");
      },
    });
    try {
      await performAction(moveDocument, contextFor(document));
      expect(openModal).not.toHaveBeenCalled();
    } finally {
      unregister();
      openModal.mockRestore();
    }
  });
  beforeEach(() => {
    stores.documents.clear();
    stores.policies.clear();
  });

  it("hides rich-text Duplicate for tables at both menu and command entry points", () => {
    const document = stores.documents.add({
      id: "11111111-1111-1111-1111-111111111111",
      documentType: "table",
      title: "Table discussion",
    });
    stores.policies.add({ id: document.id, abilities: { duplicate: true } });
    const context = contextFor(document);

    expect(actionToMenuItem(duplicateDocument, context).visible).toBe(false);
    expect(actionToKBar(duplicateDocument, context)).toEqual([]);
  });

  it("keeps the existing Duplicate permission behavior for normal documents", () => {
    const document = stores.documents.add({
      id: "22222222-2222-2222-2222-222222222222",
      title: "Normal document",
    });
    stores.policies.add({ id: document.id, abilities: { duplicate: true } });

    expect(resolve(duplicateDocument.visible, contextFor(document))).toBe(true);
  });

  it("offers Rename for tables in the command bar but not normal documents", () => {
    const table = stores.documents.add({
      id: "77777777-7777-7777-7777-777777777777",
      documentType: "table",
      title: "Table",
    });
    stores.policies.add({ id: table.id, abilities: { update: true } });
    expect(actionToKBar(renameTableDocument, contextFor(table))).toHaveLength(
      1
    );

    const document = stores.documents.add({
      id: "88888888-8888-8888-8888-888888888888",
      title: "Document",
    });
    stores.policies.add({ id: document.id, abilities: { update: true } });
    expect(actionToKBar(renameTableDocument, contextFor(document))).toEqual([]);
  });

  it.each([
    ["History", openDocumentHistory],
    ["Templatize", createTemplateFromDocument],
    [
      "Apply template",
      applyTemplateActionFactory({ actions: [copyDocumentLink] }),
    ],
    ["Markdown download", downloadDocumentAsMarkdown],
    ["HTML download", downloadDocumentAsHTML],
    ["TextBundle download", downloadDocumentAsTextBundle],
    ["PDF download", downloadDocumentAsPDF],
    ["Export", exportDocument],
    ["Print", printDocument],
    ["Copy Markdown", copyDocumentAsMarkdown],
    ["Copy text", copyDocumentAsPlainText],
    ["Search", searchInDocument],
    ["Present", presentDocument],
    ["Editing stats", toggleDocumentStats],
    ["Heading numbering", changeHeadingPrefix],
    ["Split view", openDocumentInSplit],
  ] satisfies [string, ActionVariant][])(
    "does not expose %s for a table through menus or the command bar",
    (_name, action) => {
      const document = stores.documents.add({
        id: "33333333-3333-3333-3333-333333333333",
        documentType: "table",
        title: "Table",
        collectionId: "44444444-4444-4444-4444-444444444444",
        publishedAt: "2026-09-08T00:00:00Z",
      });
      stores.policies.add({
        id: document.id,
        abilities: { update: true, download: true, listRevisions: true },
      });
      stores.policies.add({
        id: "44444444-4444-4444-4444-444444444444",
        abilities: { createTemplate: true },
      });
      const context = contextFor(document);

      expect(actionToMenuItem(action, context).visible).toBe(false);
      expect(actionToKBar(action, context)).toEqual([]);
    }
  );

  it.each([
    ["Copy link", copyDocumentLink],
    ["Move", moveDocument],
    ["Permissions", shareDocument],
    ["Archive", archiveDocument],
    ["Insights", openDocumentInsights],
  ] satisfies [string, ActionVariant][])(
    "retains the permitted document-level %s action for tables",
    (_name, action) => {
      const document = stores.documents.add({
        id: "55555555-5555-5555-5555-555555555555",
        documentType: "table",
        title: "Table",
      });
      stores.policies.add({
        id: document.id,
        abilities: {
          move: true,
          manageUsers: true,
          archive: true,
          listViews: true,
        },
      });
      expect(actionToMenuItem(action, contextFor(document)).visible).toBe(true);
    }
  );

  it("also recognizes legacy tables without a renderer discriminator", () => {
    const document = stores.documents.add({
      id: "66666666-6666-6666-6666-666666666666",
      tableData: {},
    });
    stores.policies.add({ id: document.id, abilities: { duplicate: true } });
    expect(
      actionToMenuItem(duplicateDocument, contextFor(document)).visible
    ).toBe(false);
  });
});
