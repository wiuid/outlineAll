import { readFileSync } from "node:fs";
import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import ts from "typescript";
import { TableDraftStorage } from "~/stores/TableDraftStorage";

// Execute the real recovery boundary with a lightweight editor in place of
// Univer's canvas runtime. This tests React identity/effect cleanup, not strings.
const source = readFileSync(
  "app/scenes/Document/components/TableDocument.tsx",
  "utf8"
);
const boundary = source.slice(
  source.indexOf("export const TableDocument ="),
  source.indexOf("interface EditorProps")
);

it.each([1, 2])(
  "blocks delayed session writes after permission loss (session version %s)",
  async (version) => {
    let allowed = true;
    const send = vi.fn().mockResolvedValue({ data: {} });
    const storage = {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    interface CapturedOptions {
      save?: () => Promise<unknown>;
      request?: (method: string, body: object) => Promise<unknown>;
      storage: typeof storage;
    }
    let options: CapturedOptions | undefined;
    class SessionProbe {
      constructor(input: CapturedOptions) {
        options = input;
      }
    }
    const factorySource = source.slice(
      source.indexOf("  const createSession = useCallback("),
      source.indexOf("  const [session, setSession]")
    );
    const compiled = ts.transpileModule(
      factorySource + "\nreturn createSession;",
      { compilerOptions: { target: ts.ScriptTarget.ES2020 } }
    ).outputText;
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes fixed repository source in the lightweight React test harness.
    const factory = new Function(
      "useCallback",
      "draftStorage",
      "draftKey",
      "auth",
      "shareId",
      "document",
      "getTableWorkbook",
      "TableDocumentSession",
      "TableCollaborationSession",
      "canWrite",
      "client",
      "TableCollaborationResponseSchema",
      compiled
    )(
      (fn: object) => fn,
      storage,
      "draft",
      { user: { id: "alice" } },
      undefined,
      { id: "one", title: "Table", revision: 1, store: { updateTable: send } },
      (content: object) => content,
      SessionProbe,
      SessionProbe,
      () => allowed,
      { post: send },
      { parse: (data: object) => data }
    );
    factory({ version });
    if (!options) {
      throw new Error("Session was not created");
    }
    allowed = false;
    const captured = options;
    expect(captured.storage.flush).toBeTypeOf("function");
    await captured.storage.flush();
    expect(storage.flush).toHaveBeenCalledOnce();
    const lateSave = () =>
      version === 1
        ? captured.save?.()
        : captured.request
          ? captured.request("update", {})
          : send();
    await expect(Promise.resolve().then(lateSave)).rejects.toThrow();
    captured.storage.setItem("draft", "late snapshot");
    captured.storage.removeItem("draft");
    expect(send).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  }
);

it.each(["readOnly", "ability"])(
  "retains memory-only edits on %s downgrade and isolates account/document switches",
  async (mode) => {
    const auth = { user: { id: "alice" }, team: { id: "team" } };
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const cleanup: boolean[] = [];
    let edit = (_text: string) => {};
    function Probe(props: {
      readOnly: boolean;
      abilities: { update: boolean };
      document: { id: string };
    }) {
      const [snapshot, setSnapshot] = useState(
        `server:${props.document.id}:${auth.user.id}`
      );
      edit = setSnapshot;
      const editable = useRef(true);
      editable.current = !props.readOnly && props.abilities.update;
      useEffect(
        () => () => {
          cleanup.push(editable.current);
        },
        []
      );
      return <output>{snapshot}</output>;
    }
    const compiled = ts.transpileModule(boundary, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText;
    const exports: {
      TableDocument?: React.ComponentType<{
        readOnly: boolean;
        abilities: { update: boolean };
        document: { id: string };
      }>;
    } = {};
    // oxlint-disable-next-line typescript/no-implied-eval -- Executes fixed repository source in the lightweight React test harness.
    new Function(
      "exports",
      "React",
      "observer",
      "useStores",
      "useTranslation",
      "useState",
      "useEffect",
      "useRef",
      "getTableDraftKey",
      "TableDraftStorage",
      "TableDocumentEditor",
      compiled
    )(
      exports,
      React,
      (component: object) => component,
      () => ({ auth }),
      () => ({ t: (s: string) => s }),
      useState,
      useEffect,
      useRef,
      (...ids: string[]) => ids.join(":"),
      TableDraftStorage,
      Probe
    );
    const Component = exports.TableDocument;
    if (!Component) {
      throw new Error("Missing recovery boundary");
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    let readOnly = false;
    let update = true;
    let id = "one";
    const render = async () => {
      await act(async () => {
        root.render(
          <Component
            readOnly={readOnly}
            abilities={{ update }}
            document={{ id }}
          />
        );
      });
    };
    try {
      await render();
      act(() => edit("unsaved in-memory edits"));
      if (mode === "readOnly") {
        readOnly = true;
      } else {
        update = false;
      }
      await render();
      expect(host.textContent).toBe("unsaved in-memory edits");
      expect(cleanup).toEqual([]);
      auth.user = { id: "bob" };
      await render();
      expect(host.textContent).toBe("server:one:bob");
      expect(cleanup).toEqual([false]);
      id = "two";
      await render();
      expect(host.textContent).toBe("server:two:bob");
    } finally {
      act(() => root.unmount());
    }
  }
);
