import { QueryTypes } from "sequelize";
import type { TableScriptDetails } from "@shared/types/tableScript";
import { tableToMarkdown } from "@shared/utils/lightweightTable";
import {
  createTableScript,
  runTableScript,
} from "@server/commands/tableScriptManager";
import {
  claimTableScriptRun,
  performTableScriptRun,
  scheduleDueTableScripts,
} from "@server/commands/tableScriptExecutor";
import { TableScript, TableScriptRun } from "@server/models";
import { sequelize } from "@server/storage/database";
import {
  buildAdmin,
  buildCollection,
  buildDocument,
  buildUser,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import environment from "@server/utils/environment";
import * as runner from "@server/utils/tableScriptRunner";

const server = getTestServer();
const source = "print('private webhook code')";
const text = tableToMarkdown({
  format: "outline-table",
  version: 1,
  columns: [{}],
  rows: [{ cells: [{ value: 42 }] }],
});

async function fixture() {
  const user = await buildUser();
  const document = await buildDocument({
    userId: user.id,
    teamId: user.teamId,
    text,
  });
  return { user, document };
}

beforeEach(() => {
  environment.TABLE_SCRIPT_RUNNER_URL = "https://runner.example.com";
  environment.TABLE_SCRIPT_RUNNER_TOKEN =
    "test-runner-credential-32-characters";
  environment.TABLE_SCRIPT_ALLOWED_USER_IDS = "";
});

afterEach(async () => {
  // The dispatcher is global; keep executions from different cases independent.
  await TableScriptRun.destroy({ where: {} });
  await TableScript.destroy({ where: {}, force: true });
  delete environment.TABLE_SCRIPT_RUNNER_URL;
  delete environment.TABLE_SCRIPT_RUNNER_TOKEN;
  delete environment.TABLE_SCRIPT_ALLOWED_USER_IDS;
  vi.restoreAllMocks();
});

it("creates, reads and updates encrypted source without changing the table", async () => {
  const { user, document } = await fixture();
  expect(user.isAdmin).toBe(false);
  const capabilities = await server.post(
    "/api/tableScripts.capabilities",
    user,
    {
      body: { documentId: document.id },
    }
  );
  expect(await capabilities.json()).toMatchObject({
    data: { canDevelop: true },
  });
  const revision = document.revisionCount;
  const response = await server.post("/api/tableScripts.create", user, {
    body: { documentId: document.id, name: "robot.py", source },
  });
  expect(response.status).toBe(200);
  const { data }: { data: TableScriptDetails } = await response.json();
  expect(data).toMatchObject({
    revision: 1,
    source,
    name: "robot.py",
    scheduleEnabled: false,
  });
  const rows = await sequelize.query<{ source: Buffer }>(
    "SELECT source FROM table_scripts WHERE id = :id",
    { replacements: { id: data.id }, type: QueryTypes.SELECT }
  );
  expect(rows[0].source.toString()).not.toContain("private webhook");
  const read = await server.post("/api/tableScripts.info", user, {
    body: { id: data.id },
  });
  expect(await read.json()).toMatchObject({ data: { source } });
  const list = await server.post("/api/tableScripts.list", user, {
    body: { documentId: document.id },
  });
  expect(JSON.stringify(await list.json())).not.toContain("private webhook");
  const update = await server.post("/api/tableScripts.update", user, {
    body: {
      id: data.id,
      lastRevision: 1,
      name: "robot.py",
      source: "print(2)",
    },
  });
  expect(update.status).toBe(200);
  expect(await update.json()).toMatchObject({
    data: { revision: 2, source: "print(2)" },
  });
  await document.reload();
  expect(document.revisionCount).toBe(revision);
});

it("allows exactly one concurrent save and rejects stale execution revisions", async () => {
  const { user, document } = await fixture();
  const script = await createTableScript(user, document.id, {
    name: "script.py",
    source,
  });
  const responses = await Promise.all(
    ["first", "second"].map((name) =>
      server.post("/api/tableScripts.update", user, {
        body: { id: script.id, lastRevision: 1, name, source: name },
      })
    )
  );
  expect(
    responses.map((response) => response.status).sort((a, b) => a - b)
  ).toEqual([200, 409]);
  const run = await server.post("/api/tableScripts.run", user, {
    body: { id: script.id, lastRevision: 1 },
  });
  expect(run.status).toBe(409);
  expect(await TableScriptRun.count({ where: { scriptId: script.id } })).toBe(
    0
  );
});

it.each([
  ["collaborator", buildUser],
  ["administrator", buildAdmin],
])(
  "denies every script endpoint to a non-owner %s",
  async (_role, buildMember) => {
    const { user, document } = await fixture();
    const script = await createTableScript(user, document.id, {
      name: "script.py",
      source,
    });
    const run = await runTableScript(user, script.id, 1);
    const member = await buildMember({ teamId: user.teamId });
    // The previous allowlist must never bypass spreadsheet ownership.
    environment.TABLE_SCRIPT_ALLOWED_USER_IDS = member.id;
    const capabilities = await server.post(
      "/api/tableScripts.capabilities",
      member,
      {
        body: { documentId: document.id },
      }
    );
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({
      data: { canDevelop: false },
    });
    const requests = [
      { endpoint: "list", body: { documentId: document.id } },
      {
        endpoint: "create",
        body: { documentId: document.id, name: "blocked.py", source },
      },
      { endpoint: "info", body: { id: script.id } },
      {
        endpoint: "update",
        body: { id: script.id, lastRevision: 1, name: "blocked.py", source },
      },
      { endpoint: "delete", body: { id: script.id, lastRevision: 1 } },
      {
        endpoint: "schedule",
        body: {
          id: script.id,
          lastRevision: 1,
          enabled: true,
          cron: "* * * * *",
          timezone: "UTC",
        },
      },
      { endpoint: "run", body: { id: script.id, lastRevision: 1 } },
      { endpoint: "runs", body: { id: script.id } },
      { endpoint: "runInfo", body: { id: run.id } },
      { endpoint: "stop", body: { id: run.id } },
    ];
    for (const { endpoint, body } of requests) {
      const response = await server.post(
        `/api/tableScripts.${endpoint}`,
        member,
        { body }
      );
      expect(response.status, endpoint).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain(source);
    }
    expect((await script.reload()).revision).toBe(1);
    expect((await run.reload()).status).toBe("queued");
    expect(
      await TableScript.count({ where: { documentId: document.id } })
    ).toBe(1);
  }
);

it("requires document access and the correct team in addition to ownership", async () => {
  const { user, document } = await fixture();
  const script = await createTableScript(user, document.id, {
    name: "script.py",
    source,
  });
  const run = await runTableScript(user, script.id, 1);
  const otherAdmin = await buildAdmin();
  expect(
    (
      await server.post("/api/tableScripts.info", otherAdmin, {
        body: { id: script.id },
      })
    ).status
  ).toBe(404);
  expect(
    (
      await server.post("/api/tableScripts.runInfo", otherAdmin, {
        body: { id: run.id },
      })
    ).status
  ).toBe(404);
  const privateCollection = await buildCollection({
    userId: user.id,
    teamId: user.teamId,
    permission: null,
  });
  const privateDocument = await buildDocument({
    userId: user.id,
    teamId: user.teamId,
    collectionId: privateCollection.id,
    text,
  });
  const privateScript = await createTableScript(user, privateDocument.id, {
    name: "private.py",
    source,
  });
  const member = await buildUser({ teamId: user.teamId });
  await privateDocument.update({ createdById: member.id });
  expect(
    (
      await server.post("/api/tableScripts.info", member, {
        body: { id: privateScript.id },
      })
    ).status
  ).toBe(403);
});

it("gives the current owner access to scripts and runs, regardless of their creator", async () => {
  const { user, document } = await fixture();
  const script = await createTableScript(user, document.id, {
    name: "script.py",
    source,
  });
  const run = await runTableScript(user, script.id, 1);
  const owner = await buildUser({ teamId: user.teamId });
  await document.update({ createdById: owner.id });
  const previous = await server.post("/api/tableScripts.info", user, {
    body: { id: script.id },
  });
  expect(previous.status).toBe(403);
  const current = await server.post("/api/tableScripts.info", owner, {
    body: { id: script.id },
  });
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({
    data: { source, createdById: user.id },
  });
  const records = await server.post("/api/tableScripts.runs", owner, {
    body: { id: script.id },
  });
  expect(await records.json()).toMatchObject({ data: [{ id: run.id }] });
  const stop = await server.post("/api/tableScripts.stop", owner, {
    body: { id: run.id },
  });
  expect(stop.status).toBe(200);
  expect((await run.reload()).status).toBe("cancelled");
});

it("fails closed without a runner and rejects non-table documents", async () => {
  const { user, document } = await fixture();
  const script = await createTableScript(user, document.id, {
    name: "script.py",
    source,
  });
  delete environment.TABLE_SCRIPT_RUNNER_TOKEN;
  expect(
    (
      await server.post("/api/tableScripts.run", user, {
        body: { id: script.id, lastRevision: 1 },
      })
    ).status
  ).toBe(503);
  const ordinary = await buildDocument({
    userId: user.id,
    teamId: user.teamId,
  });
  expect(
    (
      await server.post("/api/tableScripts.create", user, {
        body: { documentId: ordinary.id, name: "script.py", source },
      })
    ).status
  ).toBe(400);
});

it("cancels a queued run without contacting the executor", async () => {
  const { user, document } = await fixture();
  const script = await createTableScript(user, document.id, {
    name: "script.py",
    source,
  });
  const run = await runTableScript(user, script.id, 1);
  const cancel = vi
    .spyOn(runner, "cancelTableScriptExecution")
    .mockResolvedValue();
  const response = await server.post("/api/tableScripts.stop", user, {
    body: { id: run.id },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { status: "cancelled" },
  });
  expect(cancel).not.toHaveBeenCalled();
  expect(await claimTableScriptRun()).toBeUndefined();
});

it("snapshots submitted source, encrypts output and never retries failed execution", async () => {
  const { user, document } = await fixture();
  const script = await createTableScript(user, document.id, {
    name: "script.py",
    source,
  });
  const queued = await runTableScript(user, script.id, 1);
  await script.update({ source: "different source", revision: 2 });
  const execute = vi
    .spyOn(runner, "executeTableScript")
    .mockResolvedValue({ status: "failed", output: "private console output" });
  const run = await claimTableScriptRun();
  expect(run?.id).toBe(queued.id);
  if (!run) {
    throw new Error("No queued execution");
  }
  await performTableScriptRun(run);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      source,
      document: expect.objectContaining({ id: document.id }),
    })
  );
  await queued.reload();
  expect(queued.status).toBe("failed");
  expect(queued.output).toBe("private console output");
  const rows = await sequelize.query<{ output: Buffer }>(
    "SELECT output FROM table_script_runs WHERE id = :id",
    { replacements: { id: queued.id }, type: QueryTypes.SELECT }
  );
  expect(rows[0].output.toString()).not.toContain("private console");
  expect(await claimTableScriptRun()).toBeUndefined();
});

it.each(["ownership", "suspension"])(
  "rechecks %s before sending any spreadsheet data",
  async (change) => {
    const { user, document } = await fixture();
    const script = await createTableScript(user, document.id, {
      name: "script.py",
      source,
    });
    const queued = await runTableScript(user, script.id, 1);
    const run = await claimTableScriptRun();
    if (!run) {
      throw new Error("No queued execution");
    }
    if (change === "ownership") {
      const owner = await buildUser({ teamId: user.teamId });
      await document.update({ createdById: owner.id });
    } else {
      await user.update({ suspendedAt: new Date() });
    }
    const execute = vi.spyOn(runner, "executeTableScript");
    await performTableScriptRun(run);
    expect(execute).not.toHaveBeenCalled();
    expect((await queued.reload()).status).toBe("failed");
  }
);

it("disables a previous owner's schedule instead of executing it as the new owner", async () => {
  const { user, document } = await fixture();
  const script = await createTableScript(user, document.id, {
    name: "script.py",
    source,
  });
  await script.update({
    cron: "* * * * *",
    timezone: "UTC",
    scheduleEnabled: true,
    scheduledById: user.id,
    nextRunAt: new Date("2026-09-01T00:00:00Z"),
  });
  const owner = await buildUser({ teamId: user.teamId });
  await document.update({ createdById: owner.id });
  await scheduleDueTableScripts(new Date("2026-09-12T12:00:00Z"));
  expect(await TableScriptRun.count({ where: { scriptId: script.id } })).toBe(
    0
  );
  await script.reload();
  expect(script.scheduleEnabled).toBe(false);
  expect(script.nextRunAt).toBeNull();
  expect(script.revision).toBe(2);
  const stale = await server.post("/api/tableScripts.schedule", owner, {
    body: {
      id: script.id,
      lastRevision: 1,
      enabled: true,
      cron: "* * * * *",
      timezone: "UTC",
    },
  });
  expect(stale.status).toBe(409);
});

it("claims a run once and enforces global concurrency", async () => {
  const { user, document } = await fixture();
  for (let i = 0; i < 3; i++) {
    const script = await createTableScript(user, document.id, {
      name: `${i}.py`,
      source,
    });
    await runTableScript(user, script.id, 1);
  }
  const concurrent = await Promise.all([
    claimTableScriptRun(),
    claimTableScriptRun(),
  ]);
  const ids = concurrent.flatMap((run) => (run ? [run.id] : []));
  expect(new Set(ids).size).toBe(ids.length);
  await claimTableScriptRun();
  expect(await TableScriptRun.count({ where: { status: "running" } })).toBe(2);
  expect(await claimTableScriptRun()).toBeUndefined();
});

it("advances a due schedule once without replaying missed occurrences", async () => {
  const { user, document } = await fixture();
  const script = await createTableScript(user, document.id, {
    name: "script.py",
    source,
  });
  await script.update({
    cron: "* * * * *",
    timezone: "UTC",
    scheduleEnabled: true,
    scheduledById: user.id,
    nextRunAt: new Date("2026-09-01T00:00:00Z"),
  });
  const now = new Date("2026-09-12T12:00:00Z");
  await Promise.all([
    scheduleDueTableScripts(now),
    scheduleDueTableScripts(now),
  ]);
  expect(await TableScriptRun.count({ where: { scriptId: script.id } })).toBe(
    1
  );
  expect((await script.reload()).nextRunAt?.toISOString()).toBe(
    "2026-09-12T12:01:00.000Z"
  );
});
