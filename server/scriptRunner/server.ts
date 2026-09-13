import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { TableScriptLimits } from "@shared/types/tableScript";
import { TableDocumentSchema } from "@shared/utils/tableDocument";
import { type ScriptExecutionRegistry, ScriptRunnerError } from "./registry";

/**
 * Creates the standalone authenticated execution API without Outline's env or DB.
 *
 * @param registry the single runner's durable execution registry.
 * @param token a private service credential, never forwarded into a sandbox.
 * @returns an unbound server; remote deployment must terminate TLS in front of it.
 * @throws {Error} if the operator has not configured a sufficiently strong token.
 */
export function createScriptRunnerServer(
  registry: ScriptExecutionRegistry,
  token: string
) {
  if (token.length < 32) {
    throw new Error(
      "A runner service credential of at least 32 characters is required"
    );
  }
  const expected = digest(`Bearer ${token}`);
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void handle(request, response).catch((error: Error) => {
      response.statusCode =
        error instanceof ScriptRunnerError ? error.status : 503;
      response.end(
        error instanceof ScriptRunnerError
          ? error.message
          : "Execution service unavailable"
      );
    });
  });
  server.maxConnections = 16;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(TableScriptLimits.executionMs + 15000, (socket) =>
    socket.destroy()
  );
  return server;

  async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    if (
      !timingSafeEqual(expected, digest(request.headers.authorization ?? ""))
    ) {
      response.statusCode = 401;
      response.setHeader("Connection", "close");
      response.end("Unauthorized");
      return;
    }
    const match = /^\/runs\/([\da-f-]{36})$/i.exec(request.url ?? "");
    if (!match || !z.uuid().safeParse(match[1]).success) {
      throw new ScriptRunnerError(404, "Unknown execution route");
    }
    const id = match[1].toLowerCase();
    if (request.method === "DELETE") {
      await registry.cancel(id);
      response.statusCode = 204;
      response.end();
      return;
    }
    if (
      request.method !== "POST" ||
      request.headers["content-type"]?.split(";")[0].trim() !==
        "application/json"
    ) {
      throw new ScriptRunnerError(400, "Expected a JSON execution request");
    }
    const payload = await readInput(request);
    const parsed = inputSchema.safeParse(payload);
    if (!parsed.success || parsed.data.id !== id) {
      throw new ScriptRunnerError(400, "Invalid execution snapshot");
    }
    if (response.destroyed) {
      return;
    }
    const disconnect = () => {
      if (!response.writableEnded) {
        void registry.cancel(id).catch(() => {
          // The runtime refuses further work when it cannot confirm removal.
        });
      }
    };
    response.once("close", disconnect);
    try {
      const result = await registry.execute(parsed.data);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    } finally {
      response.removeListener("close", disconnect);
    }
  }
}

const inputSchema = z.strictObject({
  id: z.uuid(),
  source: z.string().max(TableScriptLimits.sourceLength),
  document: z.strictObject({
    id: z.uuid(),
    title: z.string().max(10000),
    revision: z.number().int().nonnegative(),
    table: TableDocumentSchema,
  }),
});

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function readInput(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!(chunk instanceof Buffer)) {
      throw new ScriptRunnerError(400, "Invalid execution body");
    }
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {
      throw new ScriptRunnerError(
        413,
        "Execution snapshot exceeds its size limit"
      );
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ScriptRunnerError(400, "Invalid execution JSON");
  }
}
