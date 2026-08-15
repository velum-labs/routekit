import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

const exists = (target: string) => access(target).then(() => true, () => false);

describe("independent source distribution", () => {
  test(
    "installs, typechecks, verifies, builds, and runs after copying only this directory",
    { timeout: 120_000 },
    async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "eval-system-isolated-source-"));
      const isolated = path.join(temporary, "eval-system");
      await mkdir(isolated);
      try {
        const names = [
          ".gitignore",
          "EXTRACTION.md",
          "FEATURE_COMPLETENESS.md",
          "PROVENANCE.json",
          "README.md",
          "package.json",
          "scripts",
          "skills",
          "src",
          "test",
          "tsconfig.json",
        ];
        if (await exists(path.join(packageRoot, "package-lock.json"))) {
          names.push("package-lock.json");
        }
        for (const name of names) {
          await cp(path.join(packageRoot, name), path.join(isolated, name), {
            recursive: true,
          });
        }

        const installEnv = {
          ...process.env,
          NODE_ENV: "development",
          npm_config_omit: "",
          npm_config_production: "",
        };
        const install = await run(["npm", "install", "--ignore-scripts", "--include=dev"], isolated, installEnv);
        assert.equal(install.exitCode, 0, install.stderr);

        const tsc = path.join(isolated, "node_modules", ".bin", "tsc");
        assert.equal(
          await exists(tsc),
          true,
          `typescript missing after install\n${install.stdout}\n${install.stderr}`,
        );
        const typecheck = await run([tsc, "-p", "tsconfig.json"], isolated, installEnv);
        assert.equal(typecheck.exitCode, 0, typecheck.stderr);

        const boundary = await run(["npm", "run", "verify-boundary"], isolated);
        assert.equal(boundary.exitCode, 0, boundary.stderr);

        const build = await run(["npm", "run", "build"], isolated);
        assert.equal(build.exitCode, 0, build.stderr);

        const product = path.join(isolated, "dist", "routekit-eval-engine.mjs");
        const help = await run([process.execPath, product, "eval", "--help"], isolated, {
          HOME: temporary,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        });
        assert.equal(help.exitCode, 0, help.stderr);
        assert.ok(String(help.stdout).includes("Run *.eval.ts agent evals"));
        assert.ok(
          String(await readFile(path.join(isolated, "PROVENANCE.json"), "utf8")).includes(
            '"sourceCommit"',
          ),
        );
      } finally {
        await rm(temporary, { force: true, recursive: true });
      }
    },
  );
});
