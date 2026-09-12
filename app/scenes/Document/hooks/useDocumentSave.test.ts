import { MobXProviderContext } from "mobx-react";
import { runInAction } from "mobx";
import { act, createElement, createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ProsemirrorDataHelper } from "@shared/utils/ProsemirrorDataHelper";
import type { Editor } from "~/editor";
import stores from "~/stores";
import {
  shouldAutoDeleteDraftOnUnmount,
  useDocumentSave,
} from "./useDocumentSave";

describe("new draft lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a blank draft during StrictMode replay and deletes it only after leaving", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const user = stores.users.add({ id: "draft-author", name: "Author" });
    runInAction(() => {
      stores.auth.currentUserId = user.id;
    });
    const draft = stores.documents.add({
      id: "new-blank-draft",
      title: "",
      createdBy: user,
      data: ProsemirrorDataHelper.getEmpty(),
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
    const deleteDraft = vi.spyOn(draft, "delete").mockResolvedValue(undefined);
    const editorRef = createRef<Editor>();
    function DraftEditor() {
      useDocumentSave({ document: draft, editorRef, readOnly: false });
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(
              MobXProviderContext.Provider,
              { value: { rootStore: stores } },
              createElement(MemoryRouter, null, createElement(DraftEditor))
            )
          )
        );
      });
      expect(deleteDraft).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
    expect(deleteDraft).toHaveBeenCalledTimes(1);
  });
});

describe("shouldAutoDeleteDraftOnUnmount", () => {
  const baseOptions = {
    title: "",
    createdById: "user-1",
    currentUserId: "user-1",
    isDraft: true,
    isActive: true,
    hasEmptyTitle: true,
    isPersistedOnce: true,
  };

  it("does not auto delete drafts with non-empty editor content", () => {
    expect(
      shouldAutoDeleteDraftOnUnmount({
        ...baseOptions,
        isEditorEmpty: false,
      })
    ).toBe(false);
  });

  it("auto deletes drafts that are still empty and untitled", () => {
    expect(
      shouldAutoDeleteDraftOnUnmount({
        ...baseOptions,
        isEditorEmpty: true,
      })
    ).toBe(true);
  });
});
