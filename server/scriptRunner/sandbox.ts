import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import {
  TableScriptLimits,
  type TableScriptInput,
  type TableScriptResult,
} from "@shared/types/tableScript";
import { ScriptProtocol } from "./protocol";

/** The execution registry never invokes Python in the application process. */
export interface ScriptSandbox {
  /** Execute once, resolving only after the complete sandbox has been removed. */
  execute(
    input: TableScriptInput,
    signal: AbortSignal
  ): Promise<TableScriptResult>;
}

/**
 * Builds immutable container configuration without host mounts or credentials.
 *
 * @param id the execution UUID, used only in the container name.
 * @param image the operator-selected local image ID.
 * @returns argument tokens for Docker, never shell source.
 * @throws {Error} if either identifier is malformed.
 */
export function scriptContainerArguments(id: string, image: string): string[] {
  if (!z.uuid().safeParse(id).success || !/^sha256:[\da-f]{64}$/.test(image)) {
    throw new Error("A run UUID and pinned local image ID are required");
  }
  return [
    "create",
    "--name",
    containerName(id),
    "--label",
    runnerLabel,
    "--runtime=runsc",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65532:65532",
    "--workdir=/tmp",
    "--ipc=none",
    "--pids-limit=64",
    "--memory=256m",
    "--memory-swap=256m",
    "--cpus=1",
    // gVisor virtualizes guest tasks; Docker's PID limit bounds host threads.
    "--ulimit=nproc=64:64",
    "--ulimit=nofile=128:128",
    "--ulimit=core=0:0",
    "--ulimit=cpu=60:60",
    "--ulimit=fsize=8388608:8388608",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
    "--log-driver=none",
    "--interactive",
    image,
  ];
}

/** Uses only gVisor; missing isolation is an error, never a Docker fallback. */
export class DockerScriptSandbox implements ScriptSandbox {
  /**
   * Selects the operator-built immutable runtime image on the runner host.
   *
   * @param image the local sha256 image ID, never a script-controlled value.
   */
  constructor(private image: string) {}

  /**
   * Checks isolation and removes orphaned containers before accepting any work.
   *
   * @throws {Error} if gVisor, the image or complete orphan removal is unavailable.
   */
  async prepare(): Promise<void> {
    const { stdout } = await docker(["info", "--format", "{{json .}}"]);
    const info = z
      .object({
        Runtimes: z.record(z.string(), z.object({ path: z.string() })),
        SecurityOptions: z.array(z.string()),
        CgroupVersion: z.string(),
        CgroupDriver: z.string(),
        MemoryLimit: z.boolean(),
        SwapLimit: z.boolean(),
        CpuCfsQuota: z.boolean(),
        PidsLimit: z.boolean(),
      })
      .parse(JSON.parse(stdout));
    if (!info.Runtimes.runsc) {
      throw new Error(
        "gVisor runsc must be configured on the dedicated rootless daemon"
      );
    }
    if (
      !info.SecurityOptions.includes("name=rootless") ||
      info.CgroupVersion !== "2" ||
      info.CgroupDriver !== "systemd" ||
      !info.MemoryLimit ||
      !info.SwapLimit ||
      !info.CpuCfsQuota ||
      !info.PidsLimit
    ) {
      throw new Error(
        "Rootless Docker with enforced memory, CPU and PID limits is required"
      );
    }
    scriptContainerArguments(
      "00000000-0000-4000-8000-000000000000",
      this.image
    );
    await docker(["image", "inspect", this.image, "--format", "{{.Id}}"]);
    const { stdout: containers } = await docker([
      "ps",
      "--all",
      "--filter",
      `label=${runnerLabel}`,
      "--format",
      "{{.ID}}",
    ]);
    for (const id of containers.trim().split("\n").filter(Boolean)) {
      if (!/^[\da-f]{12,64}$/.test(id)) {
        throw new Error("Invalid orphan container identifier");
      }
      await this.remove(id);
    }
    this.ready = true;
  }

  /**
   * Sends a single snapshot over stdin and waits for termination and removal.
   *
   * @param input the authorized source and workbook snapshot.
   * @param signal manual cancellation or caller disconnection.
   * @returns a terminal result after all sandbox processes have been removed.
   * @throws {Error} if isolation or confirmed cleanup fails.
   */
  async execute(
    input: TableScriptInput,
    signal: AbortSignal
  ): Promise<TableScriptResult> {
    if (!this.ready) {
      throw new Error("Isolated runtime is not ready");
    }
    const args = scriptContainerArguments(input.id, this.image);
    const name = containerName(input.id);
    const network = new AbortController();
    let status: TableScriptResult["status"] | undefined;
    let message = "";
    let terminate: (() => void) | undefined;
    let removal: Promise<void> | undefined;
    const cleanup = () => {
      removal ??= this.remove(name);
      return removal;
    };
    const stop = (nextStatus: TableScriptResult["status"], reason = "") => {
      status ??= nextStatus;
      message ||= reason;
      network.abort();
      terminate?.();
    };
    const cancel = () => stop("cancelled");
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => stop("timed_out", "Execution exceeded 60 seconds"),
      TableScriptLimits.executionMs
    );
    let protocol: ScriptProtocol | undefined;
    try {
      if (signal.aborted) {
        cancel();
        return { status: "cancelled", output: "" };
      }
      // Do not kill the create client mid-request: cancellation waits for create
      // to settle, then removes the known name without ever attaching source.
      await docker(args);
      if (status) {
        return { status, output: message };
      }
      const child = spawn(
        "docker",
        [...dockerHost, "start", "--attach", "--interactive", name],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: dockerEnvironment,
        }
      );
      terminate = () => {
        // Removing the container kills its whole process tree. Killing just the
        // attached Docker CLI would leave malicious child processes running.
        void cleanup().catch(() => child.kill("SIGKILL"));
      };
      protocol = new ScriptProtocol(
        (frame) => {
          if (child.stdin.writableLength > 2 * 1024 * 1024) {
            stop(
              "failed",
              "Execution network channel is not consuming responses"
            );
            return;
          }
          child.stdin.write(frame);
        },
        (reason) => stop("failed", reason),
        network.signal
      );
      const stream = protocol;
      child.stdout.on("data", (chunk: Buffer) => stream.receive(chunk));
      let diagnosticBytes = 0;
      child.stderr.on("data", (chunk: Buffer) => {
        diagnosticBytes += chunk.length;
        if (diagnosticBytes > TableScriptLimits.outputBytes) {
          stop("failed", "Execution diagnostic output exceeded its limit");
        }
      });
      child.stdin.on("error", () => {
        if (!status) {
          stop("failed", "Execution input channel closed");
        }
      });
      const finished = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stdin.write(`${JSON.stringify(input)}\n`);
      const code = await finished;
      protocol.finish();
      status ??= code === 0 ? "succeeded" : "failed";
      if (status === "failed" && !protocol.output && !message) {
        message =
          "Python stopped before returning output; check the script and resource limits";
      }
      return { status, output: boundedOutput(protocol.output, message) };
    } catch {
      return {
        status: status ?? "failed",
        output: boundedOutput(
          protocol?.output ?? "",
          message || "Isolated Python execution could not start"
        ),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      network.abort();
      // Failure to confirm removal propagates, so Stop cannot falsely report
      // success. This runner then refuses new work until it is restarted.
      await cleanup();
    }
  }

  private ready = false;

  private async remove(name: string): Promise<void> {
    try {
      await docker(["rm", "--force", name]);
    } catch (error) {
      if (
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        /No such (container|object):/i.test(error.stderr)
      ) {
        return;
      }
      this.ready = false;
      throw new Error("Sandbox removal could not be confirmed");
    }
  }
}

const runnerLabel = "outline.table-script-runner=1";
const dockerHost = ["--host=unix:///var/run/docker.sock"];
const dockerEnvironment = { PATH: "/usr/local/bin:/usr/bin:/bin" };
const execFileAsync = promisify(execFile);

function docker(args: string[]) {
  return execFileAsync("docker", [...dockerHost, ...args], {
    env: dockerEnvironment,
    timeout: 10000,
    maxBuffer: 64 * 1024,
  });
}

function containerName(id: string): string {
  return `outline-python-${id}`;
}

function boundedOutput(output: string, message: string): string {
  const value = Buffer.from(message ? `${output}\n${message}\n` : output);
  return new StringDecoder("utf8").write(
    value.subarray(0, TableScriptLimits.outputBytes)
  );
}
