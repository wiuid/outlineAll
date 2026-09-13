import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  TableScriptLimits,
  type TableScriptInput,
  type TableScriptResult,
} from "@shared/types/tableScript";
import type { ScriptSandbox } from "./sandbox";

/** An operational error safe to expose to the authenticated Outline dispatcher. */
export class ScriptRunnerError extends Error {
  /**
   * Associates a sanitized message with an HTTP response code.
   *
   * @param status the private runner API response status.
   * @param message a message without source, credentials or infrastructure detail.
   */
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** Durable run IDs prevent execution replay, including cancellation before POST. */
export class ScriptExecutionRegistry {
  /**
   * Opens a dedicated directory containing only execution-ID tombstones.
   *
   * @param sandbox the isolated runtime driver.
   * @param directory the runner's private persistent state directory.
   */
  constructor(
    private sandbox: ScriptSandbox,
    private directory: string
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /**
   * Claims a run ID before starting any work, with no retry or replay path.
   *
   * @param input one authorized source snapshot.
   * @returns the single terminal result.
   * @throws {ScriptRunnerError} for duplicate IDs or exhausted capacity.
   */
  execute(input: TableScriptInput): Promise<TableScriptResult> {
    const filename = this.filename(input.id);
    if (existsSync(filename)) {
      if (readFileSync(filename, "utf8") === "cancelled") {
        return Promise.resolve({ status: "cancelled", output: "" });
      }
      throw new ScriptRunnerError(
        409,
        "Execution ID has already been accepted"
      );
    }
    if (this.stopping || this.active.size >= TableScriptLimits.concurrency) {
      throw new ScriptRunnerError(
        503,
        "Execution service has no available capacity"
      );
    }
    this.record(filename, "accepted");
    const controller = new AbortController();
    // Defer driver entry until the active map exists; immediate Stop must see it.
    const result = Promise.resolve()
      .then(() => this.sandbox.execute(input, controller.signal))
      .then(
        (result) => {
          this.active.delete(input.id);
          return result;
        },
        (error: Error) => {
          // Preserve the failed removal in the active map. Later Stop requests
          // must not acknowledge a container whose termination is still unknown.
          this.stopping = true;
          throw error;
        }
      );
    this.active.set(input.id, { controller, result });
    return result;
  }

  /**
   * Acknowledges Stop only after runtime termination, or records an early stop.
   *
   * @param id the execution UUID.
   * @returns after the sandbox has been completely removed.
   */
  async cancel(id: string): Promise<void> {
    const filename = this.filename(id);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.result;
      return;
    }
    if (!existsSync(filename)) {
      this.record(filename, "cancelled");
    }
  }

  /**
   * Refuses new work and terminates all executions before service shutdown.
   */
  async close(): Promise<void> {
    this.stopping = true;
    const runs = [...this.active.values()];
    runs.forEach(({ controller }) => controller.abort());
    const results = await Promise.allSettled(runs.map(({ result }) => result));
    if (results.some((result) => result.status === "rejected")) {
      throw new ScriptRunnerError(
        503,
        "Sandbox removal could not be confirmed"
      );
    }
  }

  private active = new Map<
    string,
    { controller: AbortController; result: Promise<TableScriptResult> }
  >();
  private stopping = false;

  private filename(id: string): string {
    if (!z.uuid().safeParse(id).success) {
      throw new ScriptRunnerError(400, "Invalid execution ID");
    }
    return path.join(this.directory, id);
  }

  private record(filename: string, state: "accepted" | "cancelled"): void {
    const descriptor = openSync(filename, "wx", 0o600);
    try {
      writeFileSync(descriptor, state);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const directory = openSync(this.directory, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
