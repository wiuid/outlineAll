import i18n from "i18next";
import { runInAction } from "mobx";
import { actionToMenuItem } from "~/actions";
import type Model from "~/models/base/Model";
import stores from "~/stores";
import type { ActionContext, MenuItem } from "~/types";
import { createTableDocumentMenuAction } from "./tableDocuments";

const documentId = "table-menu-document";
const collectionId = "table-menu-collection";
const teamId = "table-menu-team";
const onSave = vi.fn<() => Promise<void>>();
const onRename = vi.fn();

function buildContext(): ActionContext {
  const document = stores.documents.get(documentId);
  if (!document) {
    throw new Error("Missing menu document");
  }
  const models: Model[] = [document];
  const getActiveModels = <T extends Model>(
    modelClass: new (...args: never[]) => T
  ) => models.filter((model): model is T => model instanceof modelClass);

  return {
    isMenu: true,
    isCommandBar: false,
    isButton: false,
    // The menu must use the document's collection, not stale navigation state.
    activeCollectionId: "another-collection",
    activeDocumentId: documentId,
    currentUserId: "table-menu-user",
    currentTeamId: teamId,
    getActiveModels,
    getActiveModel: (modelClass) => getActiveModels(modelClass)[0],
    getActivePolicies: () => [],
    isModelActive: (model) => models.includes(model),
    activeModels: new Set(models),
    location: {
      pathname: "/doc/table-menu/edit",
      search: "",
      hash: "",
      state: null,
    },
    stores,
    t: i18n.t,
  };
}

function itemsOf(item: MenuItem): MenuItem[] {
  if (item.type !== "submenu" && item.type !== "group") {
    throw new Error("Expected a menu group");
  }
  return item.items.filter(
    (child) => child.visible !== false && child.type !== "separator"
  );
}

function getMenu(
  options: Partial<Parameters<typeof createTableDocumentMenuAction>[0]> = {}
) {
  return itemsOf(
    actionToMenuItem(
      createTableDocumentMenuAction({
        documentId,
        editable: true,
        saveDisabled: false,
        onSave,
        onRename,
        ...options,
      }),
      buildContext()
    )
  );
}

function findItem(items: MenuItem[], title: string): MenuItem {
  const item = items.find((item) => "title" in item && item.title === title);
  if (!item) {
    throw new Error(`Missing menu item: ${title}`);
  }
  return item;
}

function titles(items: MenuItem[]) {
  return items.flatMap((item) => ("title" in item ? [item.title] : []));
}

function replacePolicy(id: string, abilities: Record<string, boolean>) {
  stores.policies.remove(id);
  stores.policies.add({ id, abilities });
}

beforeEach(() => {
  stores.documents.clear();
  stores.collections.clear();
  stores.policies.clear();
  onSave.mockReset().mockResolvedValue();
  onRename.mockReset();
  stores.collections.add({
    id: collectionId,
    name: "Tables",
    sort: { field: "index", direction: "asc" },
    documents: [
      { id: "before", title: "Before", url: "/doc/before", children: [] },
      { id: documentId, title: "Table", url: "/doc/table-menu", children: [] },
    ],
  });
  stores.documents.add({
    id: documentId,
    title: "Table",
    collectionId,
    publishedAt: "2026-09-12T00:00:00.000Z",
  });
  stores.policies.add({ id: teamId, abilities: { createDocument: true } });
  stores.policies.add({
    id: collectionId,
    abilities: { createDocument: true },
  });
  stores.policies.add({
    id: documentId,
    abilities: {
      read: true,
      update: true,
      createChildDocument: true,
      manageUsers: true,
      duplicate: true,
      move: true,
      star: true,
      pin: true,
      pinToHome: true,
      subscribe: true,
      listViews: true,
      listRevisions: true,
      download: true,
      archive: true,
      delete: true,
      unpublish: true,
    },
  });
});

it("keeps manual saving guarded and hides edit actions without permission", () => {
  expect(findItem(getMenu(), "Save")).toMatchObject({
    type: "button",
    disabled: false,
  });
  expect(findItem(getMenu({ saveDisabled: true }), "Save")).toMatchObject({
    disabled: true,
  });

  replacePolicy(documentId, {
    read: true,
    update: false,
    duplicate: false,
    share: true,
  });
  const menu = titles(getMenu({ editable: false }));
  expect(menu).not.toContain("Save");
  expect(menu).not.toContain("Rename…");
  expect(menu).not.toContain("Duplicate…");
  expect(menu).not.toContain("Delete…");
  expect(menu).toContain("Share…");
  expect(menu).toContain("Copy link");
});

it.each(["document", "table"])(
  "preserves collection, sibling and nested destinations for a new %s",
  (type) => {
    const creation = itemsOf(findItem(getMenu(), `New ${type}`));
    expect(titles(creation)).toEqual([
      "In Tables",
      "Before",
      "After",
      `Nested ${type}`,
    ]);
    expect(findItem(creation, "In Tables")).toMatchObject({
      type: "route",
      to: {
        pathname: `/collection/${collectionId}/new`,
        search: type === "table" ? "type=table" : undefined,
      },
    });
    expect(findItem(creation, "Before")).toMatchObject({
      type: "route",
      to: { search: expect.stringContaining("index=1") },
    });
    expect(findItem(creation, "After")).toMatchObject({
      type: "route",
      to: { search: expect.stringContaining("index=2") },
    });
    expect(findItem(creation, `Nested ${type}`)).toMatchObject({
      type: "route",
      to: { search: expect.stringContaining(`parentDocumentId=${documentId}`) },
    });
  }
);

it("offers root and nested creation when collection order is alphabetical", () => {
  const collection = stores.collections.get(collectionId);
  if (!collection) {
    throw new Error("Missing collection");
  }
  runInAction(() => {
    collection.sort = { field: "title", direction: "asc" };
  });
  for (const type of ["document", "table"]) {
    expect(titles(itemsOf(findItem(getMenu(), `New ${type}`)))).toEqual([
      "In Tables",
      `Nested ${type}`,
    ]);
  }
});

it("allows only nested creation when the collection is not writable", () => {
  replacePolicy(collectionId, { read: true, createDocument: false });
  for (const type of ["document", "table"]) {
    expect(titles(itemsOf(findItem(getMenu(), `New ${type}`)))).toEqual([
      `Nested ${type}`,
    ]);
  }
});

it("hides both creation menus without team creation permission", () => {
  stores.policies.add({ id: teamId, abilities: { read: true } });
  const menu = titles(getMenu());
  expect(menu).not.toContain("New document");
  expect(menu).not.toContain("New table");
});

it("groups low-frequency actions without document body tools or nested mobile menus", () => {
  const menu = getMenu();
  const more = itemsOf(findItem(menu, "More"));
  expect(titles(more)).toContain("Pin to Tables");
  expect(titles(more)).toContain("Subscribe");
  expect(titles(more)).toContain("Insights");
  expect(more.some((item) => item.type === "submenu")).toBe(false);
  const allTitles = [...titles(menu), ...titles(more)];
  for (const title of [
    "History",
    "Export",
    "Present",
    "Import…",
    "Copy as Markdown",
    "Copy as text",
    "Create template…",
    "Apply template…",
  ]) {
    expect(allTitles).not.toContain(title);
  }
});

it("uses draft and restore policies for lifecycle actions", () => {
  const document = stores.documents.get(documentId);
  if (!document) {
    throw new Error("Missing document");
  }
  runInAction(() => {
    document.publishedAt = undefined;
  });
  stores.policies.add({
    id: documentId,
    abilities: { read: true, update: true, publish: true },
  });
  expect(titles(getMenu())).toContain("Publish");
  expect(titles(getMenu())).not.toContain("Unpublish");

  stores.policies.add({
    id: documentId,
    abilities: { read: true, unarchive: true },
  });
  expect(titles(getMenu({ editable: false }))).toContain("Restore");
  expect(titles(getMenu({ editable: false }))).not.toContain("Archive…");
});
