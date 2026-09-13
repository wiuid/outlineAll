import { autorun } from "mobx";
import type { TableScriptDetails } from "@shared/types/tableScript";
import { client } from "~/utils/ApiClient";
import {
  DocumentConflictError,
  NetworkError,
  TableScriptConflictError,
} from "~/utils/errors";
import { tableSaves } from "./TableSaveCoordinator";
import { TableScriptSession, TableScriptsStore } from "./TableScriptsStore";

const script: TableScriptDetails = {
  id: "script",
  documentId: "document",
  name: "robot.py",
  source: "print(1)",
  revision: 4,
  cron: null,
  timezone: "UTC",
  scheduleEnabled: false,
  nextRunAt: null,
  createdById: "user",
  createdAt: "2026-09-12T00:00:00Z",
  updatedAt: "2026-09-12T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(client.post).mockReset();
});

async function fixture() {
  const post = vi.spyOn(client, "post");
  post
    .mockResolvedValueOnce({ data: script })
    .mockResolvedValueOnce({ data: [] });
  const session = new TableScriptSession("document");
  await session.select(script.id);
  post.mockClear();
  return { session, post };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("publishes asynchronous capability and panel changes to observers", async () => {
  const session = new TableScriptSession("document");
  vi.mocked(client.post).mockResolvedValueOnce({
    data: { canDevelop: true, executionEnabled: false, executionSeconds: 60 },
  });
  const states: string[] = [];
  const dispose = autorun(() => {
    states.push(
      `${session.capabilities?.canDevelop ?? false}:${session.mode ?? "closed"}`
    );
  });
  await session.loadCapabilities();
  session.setMode("development");
  expect(states).toEqual(["false:closed", "true:closed", "true:development"]);
  dispose();
});

it("keeps edits made during a save against the newly acknowledged revision", async () => {
  const { session, post } = await fixture();
  let accept: (value: { data: TableScriptDetails }) => void = () => {};
  post.mockReturnValueOnce(
    new Promise((resolve) => {
      accept = resolve;
    })
  );
  session.setSource("print(2)");
  const saving = session.save();
  session.setSource("print(3)");
  accept({ data: { ...script, source: "print(2)", revision: 5 } });
  await saving;
  expect(session.source).toBe("print(3)");
  expect(session.selected?.revision).toBe(5);
  expect(session.codeDirty).toBe(true);
});

it("closes the panel and clears cached scripts when ownership is revoked", async () => {
  const { session, post } = await fixture();
  session.setMode("development");
  session.setSource("previous owner's code");
  post.mockResolvedValueOnce({
    data: { canDevelop: false, executionEnabled: true, executionSeconds: 60 },
  });
  await session.loadCapabilities();
  expect(session.mode).toBeUndefined();
  expect(session.selected).toBeUndefined();
  expect(session.source).toBe("");
  expect(session.scripts).toEqual([]);
  expect(session.runs).toEqual([]);
  expect(session.dirty).toBe(false);
});

it("preserves a conflicting draft and never submits a run for stale code", async () => {
  const { session, post } = await fixture();
  post.mockRejectedValueOnce(new TableScriptConflictError());
  session.setSource("my local code");
  await expect(session.run()).rejects.toBeInstanceOf(TableScriptConflictError);
  expect(session.source).toBe("my local code");
  expect(session.conflict).toBe(true);
  await expect(session.save()).rejects.toBeInstanceOf(TableScriptConflictError);
  expect(post).toHaveBeenCalledTimes(1);
});

it("saves code then commits the workbook before exactly one run submission", async () => {
  const { session, post } = await fixture();
  const calls: string[] = [];
  vi.spyOn(tableSaves, "flush").mockImplementation(async () => {
    calls.push("table");
  });
  post.mockImplementation(async (path, _data, options) => {
    expect(options).toMatchObject({ retry: false });
    calls.push(path);
    return path === "/tableScripts.update"
      ? { data: { ...script, source: "print(2)", revision: 5 } }
      : { data: { id: "run", scriptId: script.id, status: "queued" } };
  });
  session.setSource("print(2)");
  await session.run();
  expect(calls).toEqual(["/tableScripts.update", "table", "/tableScripts.run"]);
  expect(post).toHaveBeenLastCalledWith(
    "/tableScripts.run",
    { id: script.id, lastRevision: 5 },
    { retry: false }
  );
});

it("does not enqueue when the workbook cannot be saved", async () => {
  const { session, post } = await fixture();
  vi.spyOn(tableSaves, "flush").mockRejectedValueOnce(
    new DocumentConflictError()
  );
  await expect(session.run()).rejects.toBeInstanceOf(DocumentConflictError);
  expect(session.conflict).toBe(false);
  expect(post).not.toHaveBeenCalled();
});

it("does not retry an ambiguous network failure during run submission", async () => {
  const { session, post } = await fixture();
  vi.spyOn(tableSaves, "flush").mockResolvedValue();
  post.mockRejectedValueOnce(new NetworkError());
  await expect(session.run()).rejects.toBeInstanceOf(NetworkError);
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(
    "/tableScripts.run",
    { id: script.id, lastRevision: 4 },
    { retry: false }
  );
});

it("keeps unsaved code when saving a schedule", async () => {
  const { session, post } = await fixture();
  session.setSource("not saved yet");
  session.edit({
    cron: "0 10 * * *",
    timezone: "Asia/Shanghai",
    scheduleEnabled: true,
  });
  post.mockResolvedValueOnce({
    data: {
      ...script,
      revision: 5,
      cron: "0 10 * * *",
      timezone: "Asia/Shanghai",
      scheduleEnabled: true,
    },
  });
  await session.saveSchedule();
  expect(session.source).toBe("not saved yet");
  expect(session.codeDirty).toBe(true);
  expect(session.scheduleDirty).toBe(false);
  expect(session.selected?.revision).toBe(5);
});

it("retains schedule choices changed while their previous values are saving", async () => {
  const { session, post } = await fixture();
  let accept: (value: { data: TableScriptDetails }) => void = () => {};
  post.mockReturnValueOnce(
    new Promise((resolve) => {
      accept = resolve;
    })
  );
  session.edit({ cron: "30 9 * * 1-5", timezone: "Asia/Shanghai" });
  const saving = session.saveSchedule();
  session.edit({ cron: "45 18 L * *" });
  accept({
    data: {
      ...script,
      revision: 5,
      cron: "30 9 * * 1-5",
      timezone: "Asia/Shanghai",
    },
  });
  await saving;
  expect(session.cron).toBe("45 18 L * *");
  expect(session.scheduleDirty).toBe(true);
  expect(session.selected?.revision).toBe(5);
  expect(post).toHaveBeenCalledWith(
    "/tableScripts.schedule",
    {
      id: script.id,
      lastRevision: 4,
      cron: "30 9 * * 1-5",
      timezone: "Asia/Shanghai",
      enabled: false,
    },
    { retry: false }
  );
});

it("preserves visual schedule choices on a revision conflict without retrying", async () => {
  const { session, post } = await fixture();
  session.edit({
    cron: "45 18 L * *",
    timezone: "Asia/Shanghai",
    scheduleEnabled: true,
  });
  post.mockRejectedValueOnce(new TableScriptConflictError());
  await expect(session.saveSchedule()).rejects.toBeInstanceOf(
    TableScriptConflictError
  );
  expect(session.cron).toBe("45 18 L * *");
  expect(session.timezone).toBe("Asia/Shanghai");
  expect(session.scheduleEnabled).toBe(true);
  expect(session.conflict).toBe(true);
  await expect(session.saveSchedule()).rejects.toBeInstanceOf(
    TableScriptConflictError
  );
  expect(post).toHaveBeenCalledTimes(1);
});

it("retains drafts across panel navigation and removes them on logout", async () => {
  const post = vi
    .spyOn(client, "post")
    .mockResolvedValueOnce({ data: script })
    .mockResolvedValueOnce({ data: [] });
  const store = new TableScriptsStore();
  const session = store.getSession("document");
  await session.select(script.id);
  session.setSource("secret-bearing code");
  session.setMode(undefined);
  expect(store.getSession("document").source).toBe("secret-bearing code");
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  store.clear();
  expect(session.source).toBe("");
  expect(session.selected).toBeUndefined();
  expect(
    post.mock.calls
      .map(([path]) => path)
      .filter((path) => path.startsWith("/tableScripts."))
  ).toEqual(["/tableScripts.info", "/tableScripts.runs"]);
});
