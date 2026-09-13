import { z } from "zod";
import { TableScriptLimits } from "@shared/types/tableScript";
import {
  forwardScriptHttpRequest,
  scriptHttpRequestSchema,
  ScriptNetworkError,
} from "./network";

/** The host owns output accounting and validates every message from Python. */
export class ScriptProtocol {
  /**
   * Creates the private stdio protocol for one sandbox, with no shared state.
   *
   * @param send the bounded response writer to that sandbox's standard input.
   * @param fail the callback that kills the sandbox on protocol/output abuse.
   * @param signal the execution cancellation signal.
   * @param forward the HTTP transport, injectable for deterministic tests.
   */
  constructor(
    private send: (message: string) => void,
    private fail: (message: string) => void,
    private signal: AbortSignal,
    private forward = forwardScriptHttpRequest
  ) {}

  /**
   * Returns the bounded UTF-8 console output for the execution record.
   *
   * @returns output from print, logging and Python tracebacks.
   */
  get output(): string {
    return this.chunks.join("");
  }

  /**
   * Accepts arbitrary byte chunks without trusting newline framing or UTF-8.
   *
   * @param chunk bytes from the sandbox's stdout.
   */
  receive(chunk: Buffer): void {
    if (this.failed || this.signal.aborted) {
      return;
    }
    this.receivedBytes += chunk.length;
    if (this.receivedBytes > 12 * 1024 * 1024) {
      this.stop("Execution protocol exceeded its total size limit");
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.pending.length + part.length > maxFrameBytes) {
        this.stop("Execution protocol exceeded its size limit");
        return;
      }
      this.pending = Buffer.concat([this.pending, part]);
      if (newline < 0) {
        return;
      }
      this.handleLine(this.pending.toString("utf8"));
      this.pending = Buffer.alloc(0);
      if (this.failed || this.signal.aborted) {
        return;
      }
      offset = newline + 1;
    }
  }

  /**
   * Validates that process exit did not leave a truncated protocol message.
   */
  finish(): void {
    if (this.pending.length) {
      this.stop("Execution protocol ended unexpectedly");
    }
  }

  private pending = Buffer.alloc(0);
  private chunks: string[] = [];
  private outputBytes = 0;
  private receivedBytes = 0;
  private requests = new Set<number>();
  private failed = false;

  private stop(message: string): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.fail(message);
  }

  private handleLine(line: string): void {
    let message: z.infer<typeof messageSchema>;
    try {
      message = messageSchema.parse(JSON.parse(line));
    } catch {
      this.stop("Invalid execution protocol message");
      return;
    }
    if (message.type === "output") {
      this.outputBytes += Buffer.byteLength(message.text);
      if (this.outputBytes > TableScriptLimits.outputBytes) {
        this.stop("Console output exceeds 64 KiB");
        return;
      }
      this.chunks.push(message.text);
      return;
    }
    if (
      this.requests.has(message.id) ||
      this.requests.size >= TableScriptLimits.httpRequests
    ) {
      this.stop("Execution exceeds the limit of 20 HTTP requests");
      return;
    }
    this.requests.add(message.id);
    const id = message.id;
    void this.forward(message, this.signal)
      .then(
        (response) => ({ type: "http_result", id, response }),
        (error: Error) => ({
          type: "http_result",
          id,
          error:
            error instanceof ScriptNetworkError
              ? error.message
              : "HTTP request failed",
        })
      )
      .then((response) => {
        if (!this.signal.aborted && !this.failed) {
          this.send(`${JSON.stringify(response)}\n`);
        }
      })
      .catch(() => this.stop("Execution network channel closed"));
  }
}

const maxFrameBytes = 512 * 1024;
const messageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("output"), text: z.string().max(8192) }),
  scriptHttpRequestSchema,
]);
