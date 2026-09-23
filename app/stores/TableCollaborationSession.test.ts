import { CommandType, LocaleType } from "@univerjs/core";
import type { IWorkbookData } from "@univerjs/core";
import { v4 as uuid } from "uuid";
import * as Y from "yjs";
import {
  createTableCollaboration,
  decodeTableBytes,
  encodeTableBytes,
  materializeTable,
} from "@shared/utils/tableCollaboration";
import { DocumentConflictError } from "~/utils/errors";
import { TableCollaborationSession } from "./TableCollaborationSession";

const workbook: IWorkbookData = {
  id: "session-book",
  name: "Session",
  locale: LocaleType.EN_US,
  appVersion: "0.25.1",
  styles: {},
  sheetOrder: ["sheet"],
  sheets: {
    sheet: {
      id: "sheet",
      name: "Sheet1",
      rowCount: 10,
      columnCount: 5,
      cellData: { 0: { 0: { v: "initial" } } },
    },
  },
};

function server() {
  let doc = createTableCollaboration(workbook);
  let epoch = uuid();
  let revision = 1;
  let title = "Session";
  let fail = false;
  let loseUpdateResponse = false;
  let pause: Promise<void> | undefined;
  let pauseRead: Promise<void> | undefined;
  const storage = new Map<string, string>();
  const request = vi.fn(
    async (
      _method: string,
      input: {
        epoch?: string;
        vector?: string;
        update?: string;
        title?: string;
      }
    ) => {
      if (fail) {
        throw new Error("Offline");
      }
      if (input.update) {
        if (input.epoch !== epoch) {
          throw new DocumentConflictError();
        }
        const before = encodeTableBytes(Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(doc, decodeTableBytes(input.update));
        if (
          before !== encodeTableBytes(Y.encodeStateAsUpdate(doc)) ||
          input.title !== undefined
        ) {
          revision++;
        }
        title = input.title ?? title;
        if (pause) {
          await pause;
        }
        if (loseUpdateResponse) {
          loseUpdateResponse = false;
          throw new Error("Response lost after commit");
        }
      } else if (pauseRead) {
        await pauseRead;
      }
      return {
        epoch,
        revision,
        title,
        barrierRevision: 0,
        update: encodeTableBytes(
          Y.encodeStateAsUpdate(
            doc,
            input.epoch === epoch && input.vector
              ? decodeTableBytes(input.vector)
              : undefined
          )
        ),
        vector: encodeTableBytes(Y.encodeStateVector(doc)),
      };
    }
  );
  const make = async () => {
    const session = new TableCollaborationSession({
      documentId: uuid(),
      title,
      revision,
      workbook,
      request,
      draftKey: "draft",
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
        removeItem: (key) => {
          storage.delete(key);
        },
      },
    });
    await session.load();
    session.initialize(session.snapshot());
    return session;
  };
  return {
    make,
    request,
    storage,
    snapshot: () => materializeTable(doc),
    offline: (value: boolean) => {
      fail = value;
    },
    loseNextUpdateResponse: () => {
      loseUpdateResponse = true;
    },
    pause: (value?: Promise<void>) => {
      pause = value;
    },
    pauseRead: (value?: Promise<void>) => {
      pauseRead = value;
    },
    replace: () => {
      epoch = uuid();
      doc.destroy();
      doc = createTableCollaboration({ ...workbook, name: "replacement" });
      revision++;
    },
  };
}

function edit(session: TableCollaborationSession, row: number, value: string) {
  const next = structuredClone(session.snapshot());
  next.sheets.sheet.cellData = {
    ...next.sheets.sheet.cellData,
    [row]: { 0: { v: value } },
  };
  session.capture(next);
}

describe("table collaboration editing session", () => {
  it("groups live connections with current sheet addresses without changing the workbook", async () => {
    const backend = server();
    const session = await backend.make();
    const before = session.snapshot();
    const selection = session.selection(
      "sheet",
      { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 },
      true
    );
    if (!selection) {
      throw new Error("Expected an anchored selection");
    }
    const peer = {
      documentId: uuid(),
      clientId: "first",
      userId: uuid(),
      name: "Editor",
      avatarUrl: null,
      color: "#2563eb",
      selection,
      updatedAt: Date.now(),
    };
    session.updatePeers([
      peer,
      {
        ...peer,
        clientId: "second",
        selection: { ...selection, editing: false },
      },
    ]);
    expect(session.collaborators).toEqual([
      {
        userId: peer.userId,
        isEditing: true,
        connections: 2,
        locations: ["Sheet1!B2"],
      },
    ]);
    session.updatePeers([
      { ...peer, selection: { ...selection, epoch: uuid() } },
    ]);
    expect(session.collaborators[0]).toMatchObject({
      isEditing: false,
      locations: [],
    });
    expect(session.snapshot()).toEqual(before);
    expect(session.dirty).toBe(false);
    session.dispose();
  });

  it("saves edits made while the previous delta is awaiting acknowledgement", async () => {
    const backend = server();
    const session = await backend.make();
    let release: () => void = () => undefined;
    backend.pause(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    edit(session, 0, "first");
    const saving = session.flush();
    await vi.waitFor(() =>
      expect(backend.request).toHaveBeenCalledWith("update", expect.anything())
    );
    edit(session, 1, "second");
    backend.pause();
    release();
    await saving;
    expect(backend.snapshot().sheets.sheet.cellData?.[0]?.[0]?.v).toBe("first");
    expect(backend.snapshot().sheets.sheet.cellData?.[1]?.[0]?.v).toBe(
      "second"
    );
    expect(session.hasPending).toBe(false);
    session.dispose();
  });

  it("restores a failed save into the same epoch and commits it after reconnect", async () => {
    const backend = server();
    const first = await backend.make();
    edit(first, 1, "offline draft");
    backend.offline(true);
    await expect(first.flush()).rejects.toThrow("Offline");
    first.dispose();
    backend.offline(false);
    const restored = await backend.make();
    expect(restored.restored).toBe(true);
    await restored.flush();
    expect(backend.snapshot().sheets.sheet.cellData?.[1]?.[0]?.v).toBe(
      "offline draft"
    );
    expect(backend.storage.size).toBe(0);
    restored.dispose();
  });

  it("loads the server workbook when the local recovery draft is malformed", async () => {
    const backend = server();
    backend.storage.set(
      "draft:collaboration",
      JSON.stringify({
        epoch: uuid(),
        state: "not-a-yjs-update",
        baseRevision: 1,
        title: "Damaged draft",
        savedTitle: "Session",
      })
    );

    const session = await backend.make();

    expect(session.loaded).toBe(true);
    expect(session.storageFailed).toBe(true);
    expect(session.error).toBeUndefined();
    expect(session.snapshot().sheets.sheet.cellData?.[0]?.[0]?.v).toBe(
      "initial"
    );
    session.dispose();
  });

  it("keeps background synchronization separate from save failures", async () => {
    const backend = server();
    const session = await backend.make();

    backend.offline(true);
    await expect(session.refresh()).rejects.toThrow("Offline");
    expect(session.error).toBeUndefined();

    edit(session, 1, "unsaved");
    await expect(session.flush()).rejects.toThrow("Offline");
    const saveError = session.error;
    expect(saveError?.message).toBe("Offline");

    backend.offline(false);
    await session.refresh();
    expect(session.error).toBe(saveError);

    await session.flush();
    expect(session.error).toBeUndefined();
    expect(session.hasPending).toBe(false);
    session.dispose();
  });

  it("stops background saves after disposal while allowing a final flush", async () => {
    const backend = server();
    const session = await backend.make();
    let release = () => {};
    backend.pauseRead(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    backend.request.mockClear();
    vi.useFakeTimers();
    try {
      edit(session, 1, "local draft");
      const refreshing = session.refresh();
      session.dispose();
      release();
      await refreshing;
      await vi.advanceTimersByTimeAsync(300);
      expect(
        backend.request.mock.calls.filter(([method]) => method === "update")
      ).toHaveLength(0);
      expect(session.hasPending).toBe(true);
      await session.flush();
      expect(
        backend.request.mock.calls.filter(([method]) => method === "update")
      ).toHaveLength(1);
      expect(session.hasPending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledges a committed update after its response is lost without saving it twice", async () => {
    const backend = server();
    const session = await backend.make();
    edit(session, 1, "committed once");
    backend.loseNextUpdateResponse();

    await expect(session.flush()).rejects.toThrow("Response lost after commit");
    expect(backend.snapshot().sheets.sheet.cellData?.[1]?.[0]?.v).toBe(
      "committed once"
    );
    expect(session.hasPending).toBe(true);

    await session.refresh();
    await session.flush();

    const updates = backend.request.mock.calls.filter(
      ([method]) => method === "update"
    );
    expect(updates).toHaveLength(2);
    expect(session.baseRevision).toBe(2);
    expect(session.error).toBeUndefined();
    expect(session.hasPending).toBe(false);
    session.dispose();
  });

  it("loads API replacements automatically when there are no local edits", async () => {
    const backend = server();
    const session = await backend.make();
    backend.replace();
    await session.refresh();
    expect(session.snapshot().name).toBe("replacement");
    expect(session.conflict).toBe(false);
    session.dispose();
  });

  it("keeps the original recovery draft across a replaced workbook and repeated reloads", async () => {
    const backend = server();
    const first = await backend.make();
    edit(first, 1, "must survive");
    backend.offline(true);
    await expect(first.flush()).rejects.toThrow();
    first.dispose();
    const saved = backend.storage.get("draft:collaboration");
    backend.offline(false);
    backend.replace();
    await expect(backend.make()).rejects.toBeInstanceOf(DocumentConflictError);
    expect(backend.storage.get("draft:collaboration")).toBe(saved);
    await expect(backend.make()).rejects.toBeInstanceOf(DocumentConflictError);
    expect(backend.storage.get("draft:collaboration")).toBe(saved);
  });

  it("does not mistake row deletion for a guarded range move", async () => {
    const backend = server();
    const session = await backend.make();
    session.track({
      id: "sheet.mutation.remove-rows",
      type: CommandType.MUTATION,
      params: {
        subUnitId: "sheet",
        range: { startRow: 9, endRow: 9, startColumn: 0, endColumn: 4 },
      },
    });
    const next = session.snapshot();
    next.sheets.sheet.rowCount = 9;
    session.capture(next);
    await session.flush();
    expect(backend.request).toHaveBeenCalledWith(
      "update",
      expect.objectContaining({ exclusiveRevision: undefined })
    );
    session.dispose();
  });

  it("guards native worksheet ordering and complex range moves", async () => {
    const backend = server();
    const session = await backend.make();
    session.track({
      id: "sheet.mutation.set-worksheet-order",
      type: CommandType.MUTATION,
    });
    edit(session, 1, "guarded");
    await session.flush();
    expect(backend.request).toHaveBeenCalledWith(
      "update",
      expect.objectContaining({ exclusiveRevision: 1 })
    );
    session.dispose();
  });

  it("preserves edits made during a metadata save", async () => {
    const backend = server();
    const session = await backend.make();
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async (revision: number) => {
      await waiting;
      return { revision: revision + 1, title: "Metadata title", value: true };
    });
    const updating = session.updateMetadata(send);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    session.setTitle("Title typed while saving");
    edit(session, 2, "cell typed while saving");
    release();
    await updating;
    expect(session.title).toBe("Title typed while saving");
    await session.flush();
    expect(backend.snapshot().sheets.sheet.cellData?.[2]?.[0]?.v).toBe(
      "cell typed while saving"
    );
    expect(session.hasPending).toBe(false);
    session.dispose();
  });

  it("keeps selection coordinates stable until the native view has applied a remote insertion", async () => {
    const backend = server();
    const session = await backend.make();
    const range = { startRow: 1, endRow: 2, startColumn: 0, endColumn: 0 };
    const selection = session.selection("sheet", range, true);
    expect(selection?.editing).toBe(true);
    if (!selection) {
      throw new Error("Missing selection");
    }
    expect(session.selectionRange(selection)).toEqual(range);
    expect(
      session.selectionRange({ ...selection, epoch: uuid() })
    ).toBeUndefined();
    expect(session.hasPending).toBe(false);
    session.dispose();
  });
});
