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
import { DocumentConflictError, NetworkError } from "~/utils/errors";
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
  const documentId = uuid();
  let doc = createTableCollaboration(workbook);
  let epoch = uuid();
  let revision = 1;
  let barrierRevision = 0;
  let title = "Session";
  let fail = false;
  let loseUpdateResponse = false;
  let pause: Promise<void> | undefined;
  let pauseRead: Promise<void> | undefined;
  let pauseBackup: Promise<void> | undefined;
  const receipts = new Map<
    string,
    { previousRevision: number; revision: number }
  >();
  const storage = new Map<string, string>();
  const request = vi.fn(
    async (
      _method: string,
      input: {
        epoch?: string;
        clientId?: string;
        vector?: string;
        update?: string;
        title?: string;
        baseRevision?: number;
        exclusiveRevision?: number;
      }
    ) => {
      if (fail) {
        throw new NetworkError("Offline");
      }
      let previousRevision = revision;
      const key = JSON.stringify([
        input.epoch,
        input.clientId,
        input.update,
        input.title,
        input.baseRevision,
        input.exclusiveRevision,
      ]);
      const receipt = receipts.get(key);
      const replay = input.update && !!receipt;
      if (replay && receipt) {
        previousRevision = receipt.previousRevision;
      }
      if (input.update && !replay) {
        if (
          input.epoch !== epoch ||
          input.baseRevision === undefined ||
          input.baseRevision < barrierRevision ||
          (input.exclusiveRevision !== undefined &&
            input.exclusiveRevision !== revision)
        ) {
          throw new DocumentConflictError();
        }
        const before = encodeTableBytes(Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(doc, decodeTableBytes(input.update));
        if (
          before !== encodeTableBytes(Y.encodeStateAsUpdate(doc)) ||
          input.title !== undefined
        ) {
          revision++;
          if (input.exclusiveRevision !== undefined) {
            barrierRevision = revision;
          }
          receipts.set(key, { previousRevision, revision });
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
        barrierRevision,
        previousRevision,
        acknowledgedRevision: receipt?.revision ?? revision,
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
  const make = async (draftKey = "draft") => {
    const session = new TableCollaborationSession({
      documentId,
      title,
      revision,
      workbook,
      request,
      draftKey,
      storage: {
        flush: async () => {
          await pauseBackup;
        },
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
    pauseBackup: (value?: Promise<void>) => {
      pauseBackup = value;
    },
    pauseRead: (value?: Promise<void>) => {
      pauseRead = value;
    },
    metadata: (expectedRevision: number, nextTitle = title) => {
      if (expectedRevision !== revision) {
        throw new DocumentConflictError();
      }
      title = nextTitle;
      revision++;
      return { revision, title, value: true };
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
  it("explicitly discards a failed request without replaying it later", async () => {
    const backend = server();
    const session = await backend.make();
    backend.offline(true);
    edit(session, 0, "discarded draft");
    await expect(session.flush()).rejects.toThrow();
    session.discard();
    const calls = backend.request.mock.calls.length;
    backend.offline(false);
    await session.flush();
    expect(session.hasPending).toBe(false);
    expect(backend.request.mock.calls).toHaveLength(calls);
    expect(backend.storage.has("draft:collaboration")).toBe(false);
    session.dispose();
  });

  it("saves during continuous typing instead of indefinitely postponing the debounce", async () => {
    vi.useFakeTimers();
    const backend = server();
    const session = await backend.make();
    try {
      for (let index = 0; index < 30; index++) {
        edit(session, 0, `value ${index}`);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(
        backend.request.mock.calls.some(([method]) => method === "update")
      ).toBe(true);
      await session.flush();
      expect(backend.snapshot().sheets.sheet.cellData?.[0]?.[0]?.v).toBe(
        "value 29"
      );
      expect(session.hasPending).toBe(false);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("retries transient failures with a bounded backoff and keeps the exact request", async () => {
    vi.useFakeTimers();
    const backend = server();
    const session = await backend.make();
    try {
      backend.offline(true);
      edit(session, 0, "recover after network failure");
      await expect(session.flush()).rejects.toThrow("Offline");
      const initial = backend.request.mock.calls.at(-1)?.[1];
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        backend.request.mock.calls.filter(([method]) => method === "update")
      ).toHaveLength(2);
      backend.offline(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(backend.request.mock.calls.at(-1)?.[1]).toEqual(initial);
      expect(session.hasPending).toBe(false);
      expect(session.error).toBeUndefined();
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("retains an uncertain title save when the user changes the title back", async () => {
    const backend = server();
    const session = await backend.make();
    try {
      session.setTitle("Temporary title");
      backend.loseNextUpdateResponse();
      await expect(session.flush()).rejects.toThrow();
      session.setTitle("Session");
      expect(session.hasPending).toBe(true);
      expect(backend.storage.has("draft:collaboration")).toBe(true);
      await session.flush();
      const reopened = await backend.make();
      expect(reopened.title).toBe("Session");
      reopened.dispose();
    } finally {
      session.dispose();
    }
  });

  it.each([false, true])(
    "replays an acknowledged save after a peer commit (structural peer change: %s)",
    async (structural) => {
      const backend = server();
      const session = await backend.make();
      session.track({
        id: "sheet.mutation.set-worksheet-name",
        type: CommandType.MUTATION,
      });
      const renamed = session.snapshot();
      renamed.sheets.sheet.name = "Own rename";
      session.capture(renamed);
      backend.loseNextUpdateResponse();
      await expect(session.flush()).rejects.toThrow();
      edit(session, 2, "newer local draft");
      const peer = await backend.make("peer-draft");
      if (structural) {
        peer.track({
          id: "sheet.mutation.delete-range",
          type: CommandType.MUTATION,
        });
      }
      edit(peer, 1, "peer data");
      await peer.flush();
      try {
        if (structural) {
          await expect(session.flush()).rejects.toBeInstanceOf(
            DocumentConflictError
          );
          expect(session.snapshot().sheets.sheet.cellData?.[2]?.[0]?.v).toBe(
            "newer local draft"
          );
          expect(session.conflict).toBe(true);
        } else {
          await session.flush();
          expect(backend.snapshot().sheets.sheet.cellData?.[1]?.[0]?.v).toBe(
            "peer data"
          );
          expect(backend.snapshot().sheets.sheet.cellData?.[2]?.[0]?.v).toBe(
            "newer local draft"
          );
          expect(session.conflict).toBe(false);
        }
      } finally {
        session.dispose();
        peer.dispose();
      }
    }
  );

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

  it("advances a queued exclusive edit only over its own acknowledged ordinary save", async () => {
    const backend = server();
    const session = await backend.make();
    let release = () => {};
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
    session.track({
      id: "sheet.mutation.set-worksheet-name",
      type: CommandType.MUTATION,
    });
    const next = session.snapshot();
    next.sheets.sheet.name = "Renamed during save";
    session.capture(next);
    backend.pause();
    release();
    try {
      await saving;
      expect(backend.snapshot().sheets.sheet.name).toBe("Renamed during save");
      expect(
        backend.request.mock.calls
          .filter(([method]) => method === "update")
          .map(([, input]) => input.exclusiveRevision)
      ).toEqual([undefined, 2]);
      expect(session.hasPending).toBe(false);
    } finally {
      session.dispose();
    }
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
    // Reconciliation clears the error only after replaying the saved request.
    expect(session.error).toBeUndefined();

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

  it.each(["refresh", "flush"] as const)(
    "recovers a lost exclusive acknowledgement through %s before saving newer edits",
    async (method) => {
      const backend = server();
      const session = await backend.make();
      session.track({
        id: "sheet.mutation.set-worksheet-name",
        type: CommandType.MUTATION,
      });
      const next = session.snapshot();
      next.sheets.sheet.name = "Committed rename";
      session.capture(next);
      backend.loseNextUpdateResponse();
      await expect(session.flush()).rejects.toThrow(
        "Response lost after commit"
      );
      edit(session, 1, "typed after lost response");
      try {
        await session[method]();
        await session.flush();
        const updates = backend.request.mock.calls.filter(
          ([name]) => name === "update"
        );
        expect(updates).toHaveLength(3);
        expect(updates[1][1]).toEqual(updates[0][1]);
        expect(backend.snapshot().sheets.sheet.name).toBe("Committed rename");
        expect(backend.snapshot().sheets.sheet.cellData?.[1]?.[0]?.v).toBe(
          "typed after lost response"
        );
        expect(session.baseRevision).toBe(3);
        expect(session.conflict).toBe(false);
        expect(session.hasPending).toBe(false);
      } finally {
        session.dispose();
      }
    }
  );

  it("commits the exact replay draft before sending a request", async () => {
    const backend = server();
    const session = await backend.make();
    let release = () => {};
    backend.pauseBackup(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    edit(session, 0, "durable before send");
    const saving = session.flush();
    try {
      await vi.waitFor(() => {
        const stored = backend.storage.get("draft:collaboration") ?? "{}";
        expect(JSON.parse(stored)).toMatchObject({
          pendingSave: { request: { baseRevision: 1 } },
        });
      });
      expect(
        backend.request.mock.calls.filter(([method]) => method === "update")
      ).toHaveLength(0);
    } finally {
      release();
      await saving;
      session.dispose();
    }
  });

  it("replays a lost exclusive acknowledgement after reloading without dropping subsequent edits", async () => {
    const backend = server();
    const first = await backend.make();
    first.track({
      id: "sheet.mutation.set-worksheet-name",
      type: CommandType.MUTATION,
    });
    const next = first.snapshot();
    next.sheets.sheet.name = "Committed before reload";
    first.capture(next);
    backend.loseNextUpdateResponse();
    await expect(first.flush()).rejects.toThrow("Response lost after commit");
    edit(first, 1, "must survive reload");
    first.dispose();
    const restored = await backend.make();
    try {
      await restored.flush();
      const updates = backend.request.mock.calls.filter(
        ([method]) => method === "update"
      );
      expect(updates).toHaveLength(3);
      expect(updates[1][1]).toEqual(updates[0][1]);
      expect(backend.snapshot().sheets.sheet.name).toBe(
        "Committed before reload"
      );
      expect(backend.snapshot().sheets.sheet.cellData?.[1]?.[0]?.v).toBe(
        "must survive reload"
      );
      expect(restored.conflict).toBe(false);
      expect(restored.hasPending).toBe(false);
    } finally {
      restored.dispose();
    }
  });

  it.each([false, true])(
    "persists a deletion despite an unchanged vector (committed before failure: %s)",
    async (committed) => {
      const backend = server();
      const session = await backend.make();
      const vector = encodeTableBytes(Y.encodeStateVector(session.doc));
      session.track({
        id: "sheet.mutation.delete-range",
        type: CommandType.MUTATION,
      });
      const next = session.snapshot();
      next.sheets.sheet.cellData = {};
      session.capture(next);
      expect(encodeTableBytes(Y.encodeStateVector(session.doc))).toBe(vector);
      if (committed) {
        backend.loseNextUpdateResponse();
      } else {
        backend.offline(true);
      }
      await expect(session.flush()).rejects.toThrow();
      expect(session.dirty).toBe(true);
      backend.offline(false);
      try {
        await session.refresh();
        await session.flush();
        expect(
          backend.snapshot().sheets.sheet.cellData?.[0]?.[0]
        ).toBeUndefined();
        expect(session.baseRevision).toBe(2);
        expect(session.hasPending).toBe(false);
      } finally {
        session.dispose();
      }
    }
  );

  it("does not rebase an unseen exclusive edit over a peer's committed revision", async () => {
    const backend = server();
    const session = await backend.make();
    const peer = await backend.make();
    edit(peer, 1, "peer edit");
    await peer.flush();
    edit(session, 0, "own edit");
    await session.flush();
    session.track({
      id: "sheet.mutation.set-worksheet-name",
      type: CommandType.MUTATION,
    });
    const next = session.snapshot();
    next.sheets.sheet.name = "Unseen rename";
    session.capture(next);
    await expect(session.flush()).rejects.toBeInstanceOf(DocumentConflictError);
    expect(backend.snapshot().sheets.sheet.name).toBe("Sheet1");
    expect(session.snapshot().sheets.sheet.name).toBe("Unseen rename");
    session.dispose();
    peer.dispose();
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

  it("serializes simultaneous metadata requests before reading their revisions", async () => {
    const backend = server();
    const session = await backend.make();
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async (revision: number) => {
      await waiting;
      return backend.metadata(revision);
    });
    const first = session.updateMetadata(send);
    const second = session.updateMetadata(send);
    const settled = Promise.allSettled([first, second]);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      expect(send).toHaveBeenCalledTimes(1);
      expect(session.hasPending).toBe(true);
      release();
      expect(await settled).toEqual([
        { status: "fulfilled", value: true },
        { status: "fulfilled", value: true },
      ]);
      expect(send.mock.calls).toEqual([[1], [2]]);
      expect(session.baseRevision).toBe(3);
      expect(session.hasPending).toBe(false);
    } finally {
      release();
      await settled;
      session.dispose();
    }
  });

  it("advances an exclusive edit made during its own metadata request", async () => {
    const backend = server();
    const session = await backend.make();
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async (revision: number) => {
      await waiting;
      return backend.metadata(revision);
    });
    const updating = session.updateMetadata(send);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    session.track({
      id: "sheet.mutation.set-worksheet-name",
      type: CommandType.MUTATION,
    });
    const next = session.snapshot();
    next.sheets.sheet.name = "After metadata";
    session.capture(next);
    release();
    await updating;
    try {
      await session.flush();
      expect(backend.snapshot().sheets.sheet.name).toBe("After metadata");
      expect(session.hasPending).toBe(false);
    } finally {
      session.dispose();
    }
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
