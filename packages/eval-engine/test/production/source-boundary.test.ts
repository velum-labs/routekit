import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const packageRoot = path.resolve(import.meta.dirname, "../..");

const run = (command: readonly string[], cwd: string, env = process.env) =>
  new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

describe("RouteKit workspace source distribution", () => {
  test(
    "builds and runs from a copied tree without the external source checkout",
    { timeout: 120_000 },
    async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "eval-system-isolated-source-"));
      const isolated = path.join(temporary, "eval-system");
      await mkdir(isolated);
      try {
        const names = [
          "FEATURE_COMPLETENESS.md",
          "README.md",
          "skills",
          "src",
          "test",
        ];
        for (const name of names) {
          await cp(path.join(packageRoot, name), path.join(isolated, name), {
            recursive: true,
          });
        }
        await symlink(path.join(packageRoot, "node_modules"), path.join(isolated, "node_modules"));

        const build = await run(
          [
            process.execPath,
            "--experimental-strip-types",
            "--experimental-sqlite",
            path.join(isolated, "src", "build.ts"),
          ],
          packageRoot,
        );
        assert.equal(build.exitCode, 0, build.stderr);

        const product = path.join(isolated, "dist", "ori-eval-system.mjs");
        const help = await run([process.execPath, product, "eval", "--help"], isolated, {
          HOME: temporary,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        });
        assert.equal(help.exitCode, 0, help.stderr);
        assert.ok(String(help.stdout).includes("Run *.eval.ts agent evals"));
      } finally {
        await rm(temporary, { force: true, recursive: true });
      }
    },
  );
});
