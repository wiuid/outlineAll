import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  TableScriptInput,
  TableScriptResult,
} from "@shared/types/tableScript";
import { ScriptExecutionRegistry } from "./registry";
import type { ScriptSandbox } from "./sandbox";

const input: TableScriptInput = {
  id: "339b4542-902f-44d8-b0c0-636ef8d13a5d",
  source: "print('private source')",
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
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "outline-runner-test-"));
});
afterEach(() => rmSync(directory, { force: true, recursive: true }));

it("never executes a cancelled ID, including after registry restart", async () => {
  const execute = vi
    .fn()
    .mockResolvedValue({ status: "succeeded", output: "" });
  const registry = new ScriptExecutionRegistry({ execute }, directory);
  await registry.cancel(input.id);
  expect(await registry.execute(input)).toEqual({
    status: "cancelled",
    output: "",
  });
  const restarted = new ScriptExecutionRegistry({ execute }, directory);
  expect(await restarted.execute(input)).toEqual({
    status: "cancelled",
    output: "",
  });
  expect(execute).not.toHaveBeenCalled();
});

it("persists only a tombstone and refuses duplicate/replayed runs", async () => {
  const execute = vi
    .fn()
    .mockResolvedValue({ status: "succeeded", output: "42\n" });
  const registry = new ScriptExecutionRegistry({ execute }, directory);
  expect(await registry.execute(input)).toMatchObject({ status: "succeeded" });
  expect(readFileSync(path.join(directory, input.id), "utf8")).toBe("accepted");
  expect(() => registry.execute(input)).toThrow("already been accepted");
  expect(() =>
    new ScriptExecutionRegistry({ execute }, directory).execute(input)
  ).toThrow("already been accepted");
  expect(execute).toHaveBeenCalledOnce();
});

it("waits for confirmed teardown when cancellation races with startup", async () => {
  let finish: (result: TableScriptResult) => void = () => {};
  let signal: AbortSignal | undefined;
  const sandbox: ScriptSandbox = {
    execute: (_input, abortSignal) => {
      signal = abortSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const registry = new ScriptExecutionRegistry(sandbox, directory);
  const pending = registry.execute(input);
  const stopped = vi.fn();
  const cancellation = registry.cancel(input.id).then(stopped);
  await Promise.resolve();
  expect(signal?.aborted).toBe(true);
  expect(stopped).not.toHaveBeenCalled();
  finish({ status: "cancelled", output: "" });
  await cancellation;
  await pending;
  expect(stopped).toHaveBeenCalledOnce();
});

it("limits concurrent runs without creating a retry or replay", async () => {
  const sandbox: ScriptSandbox = {
    execute: (_input, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve({ status: "cancelled", output: "" }),
          { once: true }
        );
      }),
  };
  const registry = new ScriptExecutionRegistry(sandbox, directory);
  const runs = [
    registry.execute(input),
    registry.execute({ ...input, id: randomUUID() }),
  ];
  expect(() => registry.execute({ ...input, id: randomUUID() })).toThrow(
    "no available capacity"
  );
  await Promise.resolve();
  await registry.close();
  await Promise.all(runs);
});

it("never acknowledges later Stop calls after failed sandbox removal", async () => {
  const execute = vi
    .fn()
    .mockRejectedValue(new Error("Sandbox removal could not be confirmed"));
  const registry = new ScriptExecutionRegistry({ execute }, directory);
  await expect(registry.execute(input)).rejects.toThrow("removal");
  await expect(registry.cancel(input.id)).rejects.toThrow("removal");
  expect(() => registry.execute({ ...input, id: randomUUID() })).toThrow(
    "no available capacity"
  );
  await expect(registry.close()).rejects.toThrow("removal");
});

it("rejects path traversal before accessing the tombstone directory", async () => {
  const execute = vi.fn();
  const registry = new ScriptExecutionRegistry({ execute }, directory);
  expect(() => registry.execute({ ...input, id: "../escaped" })).toThrow(
    "Invalid execution ID"
  );
  await expect(registry.cancel("../escaped")).rejects.toThrow(
    "Invalid execution ID"
  );
});
