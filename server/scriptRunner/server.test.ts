import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { http, passthrough } from "msw";
import type {
  TableScriptInput,
  TableScriptResult,
} from "@shared/types/tableScript";
import { server as mocks } from "@server/test/msw";
import { ScriptExecutionRegistry } from "./registry";
import { createScriptRunnerServer } from "./server";

const token = "test-only-private-service-credential-123456";
const input: TableScriptInput = {
  id: "339b4542-902f-44d8-b0c0-636ef8d13a5d",
  source: "print(42)",
  document: {
    id: "c939b6fa-06e2-458f-8218-80bd3b4203cb",
    title: "Sheet",
    revision: 4,
    table: {
      format: "outline-table",
      version: 1,
      columns: [{}],
      rows: [{ cells: [{ value: 42 }] }],
    },
  },
};
const execute =
  vi.fn<
    (input: TableScriptInput, signal: AbortSignal) => Promise<TableScriptResult>
  >();
let directory: string;
let server: Server;
let registry: ScriptExecutionRegistry;
let url: string;

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "outline-runner-api-test-"));
  execute
    .mockReset()
    .mockResolvedValue({ status: "succeeded", output: "42\n" });
  registry = new ScriptExecutionRegistry({ execute }, directory);
  server = createScriptRunnerServer(registry, token);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test listener address");
  }
  url = `http://127.0.0.1:${address.port}/runs/${input.id}`;
  mocks.use(http.all(/http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));
});

afterEach(async () => {
  await registry.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

function submit(body = input, authorization = `Bearer ${token}`) {
  return fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("authenticates before accepting any source and returns one terminal result", async () => {
  expect((await submit(input, "Bearer incorrect")).status).toBe(401);
  expect(execute).not.toHaveBeenCalled();
  const result = await submit();
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ status: "succeeded", output: "42\n" });
  expect(execute).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  expect((await submit()).status).toBe(409);
  expect(execute).toHaveBeenCalledOnce();
});

it("rejects mismatched IDs and invalid snapshots without running source", async () => {
  expect(
    (await submit({ ...input, id: "c939b6fa-06e2-458f-8218-80bd3b4203cb" }))
      .status
  ).toBe(400);
  expect(
    (await submit({ ...input, source: "x".repeat(64 * 1024 + 1) })).status
  ).toBe(400);
  expect(execute).not.toHaveBeenCalled();
});

it("persists DELETE before POST and never starts the cancelled source", async () => {
  const stopped = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(stopped.status).toBe(204);
  const result = await submit();
  expect(await result.json()).toEqual({ status: "cancelled", output: "" });
  expect(execute).not.toHaveBeenCalled();
});

it("waits for termination before acknowledging a running DELETE", async () => {
  let finish: (result: TableScriptResult) => void = () => {};
  let signal: AbortSignal | undefined;
  execute.mockImplementation((_input, abortSignal) => {
    signal = abortSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const started = submit();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  const acknowledged = vi.fn();
  const stopped = fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => {
    acknowledged();
    return response;
  });
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  expect(acknowledged).not.toHaveBeenCalled();
  finish({ status: "cancelled", output: "" });
  expect((await stopped).status).toBe(204);
  expect(await (await started).json()).toMatchObject({ status: "cancelled" });
});
