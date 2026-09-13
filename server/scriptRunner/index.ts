import { readFileSync } from "node:fs";
import { z } from "zod";
import { ScriptExecutionRegistry } from "./registry";
import { DockerScriptSandbox } from "./sandbox";
import { createScriptRunnerServer } from "./server";

// This is a separate entry point, never an Outline service or web worker.
// Run one manager container per dedicated rootless daemon, with persistent state.
// Mount only that daemon's socket at /var/run/docker.sock inside the manager.
// Configure only RUNNER_IMAGE_ID, RUNNER_TOKEN_FILE, RUNNER_STATE_DIR and optional
// RUNNER_HOST/RUNNER_PORT. No .env, Outline database, Redis or integration secrets.
async function main(): Promise<void> {
  const settings = z
    .object({
      RUNNER_IMAGE_ID: z.string().regex(/^sha256:[\da-f]{64}$/),
      RUNNER_TOKEN_FILE: z.string().min(1),
      RUNNER_STATE_DIR: z.string().startsWith("/"),
      RUNNER_HOST: z.string().default("127.0.0.1"),
      RUNNER_PORT: z.coerce.number().int().min(1024).max(65535).default(3035),
    })
    .parse(process.env);
  const token = readFileSync(settings.RUNNER_TOKEN_FILE, "utf8").trim();
  const sandbox = new DockerScriptSandbox(settings.RUNNER_IMAGE_ID);
  await sandbox.prepare();
  const registry = new ScriptExecutionRegistry(
    sandbox,
    settings.RUNNER_STATE_DIR
  );
  const server = createScriptRunnerServer(registry, token);
  const shutdown = () => {
    server.close();
    void registry.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.listen(settings.RUNNER_PORT, settings.RUNNER_HOST, () => {
    process.stdout.write("Isolated Python execution service ready\n");
  });
  server.on("error", () => {
    process.stderr.write("Execution service listener failed\n");
    shutdown();
  });
}

void main().catch(() => {
  process.stderr.write(
    "Execution service unavailable: check runsc, the pinned image, credential file and persistent state directory\n"
  );
  process.exitCode = 1;
});
