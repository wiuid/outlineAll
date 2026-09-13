import { cp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformFile } from "@swc/core";

// Build a small, explicit Docker context. Never copy Outline's environment,
// application build, credentials, database clients or the full node_modules.
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const target = process.argv[2];
if (!target || !path.isAbsolute(target) || target.startsWith(`${root}/`)) {
  throw new Error(
    "Pass an absolute output directory outside the application repository"
  );
}
await mkdir(target, { recursive: false });
const sources = [
  "server/scriptRunner/index.ts",
  "server/scriptRunner/network.ts",
  "server/scriptRunner/protocol.ts",
  "server/scriptRunner/registry.ts",
  "server/scriptRunner/sandbox.ts",
  "server/scriptRunner/server.ts",
  "shared/types/tableScript.ts",
  "shared/utils/tableDocument.ts",
  "shared/utils/lightweightTable.ts",
  "shared/validations.ts",
];
for (const source of sources) {
  const result = await transformFile(path.join(root, source), {
    configFile: path.join(root, ".swcrc"),
    jsc: { baseUrl: root },
  });
  const output = path.join(target, source.replace(/\.ts$/, ".js"));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, result.code);
}
const require = createRequire(import.meta.url);
for (const dependency of ["zod", "ipaddr.js"]) {
  const packageRoot = path.dirname(
    require.resolve(`${dependency}/package.json`)
  );
  await cp(packageRoot, path.join(target, "node_modules", dependency), {
    recursive: true,
    filter: (filename) => !filename.endsWith(".md"),
  });
}
await cp(path.join(directory, "Dockerfile"), path.join(target, "Dockerfile"));
await writeFile(
  path.join(target, ".dockerignore"),
  "**/*.map\n**/*.test.*\n**/*.md\n"
);
process.stdout.write(`Prepared isolated runner Docker context: ${target}\n`);
