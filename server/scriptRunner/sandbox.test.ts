import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  TableScriptLimits,
  type TableScriptInput,
} from "@shared/types/tableScript";
import { DockerScriptSandbox, scriptContainerArguments } from "./sandbox";

const mocks = vi.hoisted(() => ({
  docker:
    vi.fn<
      (
        command: string,
        args: string[]
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
  spawn: vi.fn<() => TestChild>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.docker }),
    spawn: mocks.spawn,
  };
});

class TestChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    this.emit("close", null);
    return true;
  });
}

const image = `sha256:${"a".repeat(64)}`;
const input: TableScriptInput = {
  id: "339b4542-902f-44d8-b0c0-636ef8d13a5d",
  source: "print('private source')",
  document: {
    id: "c939b6fa-06e2-458f-8218-80bd3b4203cb",
    title: "Fixture",
    revision: 1,
    table: {
      format: "outline-table",
      version: 1,
      columns: [{}],
      rows: [{ cells: [{ value: 42 }] }],
    },
  },
};
let child: TestChild;
const rootlessInfo = {
  Runtimes: { runsc: { path: "runsc" } },
  SecurityOptions: ["name=rootless"],
  CgroupVersion: "2",
  CgroupDriver: "systemd",
  MemoryLimit: true,
  SwapLimit: true,
  CpuCfsQuota: true,
  PidsLimit: true,
};

beforeEach(() => {
  child = new TestChild();
  mocks.spawn.mockReset().mockReturnValue(child);
  mocks.docker.mockReset().mockImplementation(async (_command, args) => {
    if (args.includes("info")) {
      return { stdout: JSON.stringify(rootlessInfo), stderr: "" };
    }
    if (args.includes("rm") && mocks.spawn.mock.calls.length) {
      child.emit("close", 137);
    }
    return { stdout: "", stderr: "" };
  });
});

afterEach(() => vi.useRealTimers());

it("requires runsc and gives Python no host mounts, capabilities or direct network", () => {
  const args = scriptContainerArguments(
    "339b4542-902f-44d8-b0c0-636ef8d13a5d",
    `sha256:${"a".repeat(64)}`
  );
  expect(args).toEqual(
    expect.arrayContaining([
      "--runtime=runsc",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=64",
      "--memory=256m",
      "--memory-swap=256m",
      "--cpus=1",
      "--ulimit=nproc=64:64",
      "--user=65532:65532",
      "--log-driver=none",
    ])
  );
  expect(
    args.some(
      (arg) =>
        arg.startsWith("--volume") ||
        arg.startsWith("--mount") ||
        arg.startsWith("--env")
    )
  ).toBe(false);
});

it("rejects shell/path injection and mutable image tags", () => {
  expect(() =>
    scriptContainerArguments(
      "$(touch /tmp/unwanted)",
      `sha256:${"a".repeat(64)}`
    )
  ).toThrow();
  expect(() =>
    scriptContainerArguments(
      "339b4542-902f-44d8-b0c0-636ef8d13a5d",
      "python:latest"
    )
  ).toThrow();
});

it("cannot execute before the gVisor preflight succeeds", async () => {
  const sandbox = new DockerScriptSandbox(`sha256:${"a".repeat(64)}`);
  await expect(
    sandbox.execute(
      {
        id: "339b4542-902f-44d8-b0c0-636ef8d13a5d",
        source: "print(42)",
        document: {
          id: "c939b6fa-06e2-458f-8218-80bd3b4203cb",
          title: "test",
          revision: 1,
          table: {
            format: "outline-table",
            version: 1,
            columns: [{}],
            rows: [{ cells: [{ value: 0 }] }],
          },
        },
      },
      new AbortController().signal
    )
  ).rejects.toThrow("not ready");
});

it("refuses a host with only runc without launching a process", async () => {
  mocks.docker.mockResolvedValueOnce({
    stdout: JSON.stringify({
      ...rootlessInfo,
      Runtimes: { runc: { path: "runc" } },
    }),
    stderr: "",
  });
  const sandbox = new DockerScriptSandbox(image);
  await expect(sandbox.prepare()).rejects.toThrow("gVisor runsc");
  await expect(
    sandbox.execute(input, new AbortController().signal)
  ).rejects.toThrow("not ready");
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it.each([
  { SecurityOptions: ["name=seccomp"] },
  { CgroupVersion: "1" },
  { CgroupDriver: "none" },
  { MemoryLimit: false },
  { SwapLimit: false },
  { CpuCfsQuota: false },
  { PidsLimit: false },
])(
  "refuses a rootful daemon or unenforced resource limits: %j",
  async (settings) => {
    mocks.docker.mockResolvedValueOnce({
      stdout: JSON.stringify({ ...rootlessInfo, ...settings }),
      stderr: "",
    });
    const sandbox = new DockerScriptSandbox(image);
    await expect(sandbox.prepare()).rejects.toThrow("Rootless Docker");
    await expect(
      sandbox.execute(input, new AbortController().signal)
    ).rejects.toThrow("not ready");
    expect(mocks.spawn).not.toHaveBeenCalled();
  }
);

it("transports source only over stdin and removes the sandbox before completion", async () => {
  const sandbox = new DockerScriptSandbox(image);
  await sandbox.prepare();
  const result = sandbox.execute(input, new AbortController().signal);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  expect(JSON.parse(child.stdin.read().toString())).toEqual(input);
  child.stdout.write(`${JSON.stringify({ type: "output", text: "42\n" })}\n`);
  child.emit("close", 0);
  expect(await result).toEqual({ status: "succeeded", output: "42\n" });
  expect(mocks.docker.mock.calls.some(([, args]) => args.includes("rm"))).toBe(
    true
  );
  expect(JSON.stringify(mocks.docker.mock.calls)).not.toContain(
    "private source"
  );
  expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain(
    "private source"
  );
});

it("cancels during container creation without ever attaching the script", async () => {
  const sandbox = new DockerScriptSandbox(image);
  await sandbox.prepare();
  let created: (value: { stdout: string; stderr: string }) => void = () => {};
  mocks.docker.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        created = resolve;
      })
  );
  const controller = new AbortController();
  const pending = sandbox.execute(input, controller.signal);
  controller.abort();
  expect(mocks.spawn).not.toHaveBeenCalled();
  created({ stdout: "container-id", stderr: "" });
  expect(await pending).toEqual({ status: "cancelled", output: "" });
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.docker.mock.calls.some(([, args]) => args.includes("rm"))).toBe(
    true
  );
});

it("waits for complete removal when Stop arrives during execution", async () => {
  const sandbox = new DockerScriptSandbox(image);
  await sandbox.prepare();
  const controller = new AbortController();
  const result = sandbox.execute(input, controller.signal);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  let removed: (value: { stdout: string; stderr: string }) => void = () => {};
  mocks.docker.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        removed = resolve;
      })
  );
  const finished = vi.fn();
  const completion = result.then(finished);
  controller.abort();
  child.emit("close", 137);
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  removed({ stdout: "container-id", stderr: "" });
  await completion;
  expect(finished).toHaveBeenCalledWith({ status: "cancelled", output: "" });
});

it("terminates the sandbox on wall-clock timeout and rejects oversized output", async () => {
  const sandbox = new DockerScriptSandbox(image);
  await sandbox.prepare();
  vi.useFakeTimers();
  const result = sandbox.execute(input, new AbortController().signal);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(TableScriptLimits.executionMs);
  expect(await result).toMatchObject({ status: "timed_out" });
  vi.useRealTimers();

  child = new TestChild();
  mocks.spawn.mockReturnValue(child);
  const excessive = sandbox.execute(input, new AbortController().signal);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
  child.stdout.write(Buffer.alloc(512 * 1024 + 1));
  expect(await excessive).toMatchObject({
    status: "failed",
    output: expect.stringContaining("protocol exceeded"),
  });
});

it("refuses new execution after cleanup fails instead of claiming a successful stop", async () => {
  const sandbox = new DockerScriptSandbox(image);
  await sandbox.prepare();
  const result = sandbox.execute(input, new AbortController().signal);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
  mocks.docker.mockRejectedValueOnce(new Error("Docker unavailable"));
  child.emit("close", 0);
  await expect(result).rejects.toThrow("removal could not be confirmed");
  await expect(
    sandbox.execute(input, new AbortController().signal)
  ).rejects.toThrow("not ready");
});
