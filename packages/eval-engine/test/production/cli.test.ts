import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import * as esbuild from "esbuild";

import {
  AUTHOR_HARNESSES,
  ERROR_REQUIRED_KEYS,
  HOST_REQUIRED_KEYS,
  MANIFEST_REQUIRED_KEYS,
  PREPARED_REQUIRED_KEYS,
  SPAWN_EXIT,
  SPAWN_PROTOCOL_VERSION
} from "../../src/host-contract.ts";
import { DEFAULT_EVAL_API_BASE_URL, EVAL_API_BASE_URL_ENV } from "../../src/host-env.ts";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const binary = path.join(packageRoot, "dist", "ori-eval-system.mjs");
const strippedPath = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
let isolatedHome = "";
let isolatedRuntimeCache = "";
let repository = "";

interface Invocation {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

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

const fileExists = (target: string) =>
  access(target).then(
    () => true,
    () => false
  );

const assertMatchObject = (actual: unknown, expected: unknown): void => {
  if (expected instanceof RegExp) {
    assert.match(String(actual), expected);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `expected array, got ${typeof actual}`);
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < expected.length; index++) {
      assertMatchObject(actual[index], expected[index]);
    }
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(
      actual !== null && typeof actual === "object",
      `expected object, got ${typeof actual}`
    );
    const record = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      assertMatchObject(record[key], value);
    }
    return;
  }
  assert.deepEqual(actual, expected);
};

const invoke = async (
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {}
): Promise<Invocation> =>
  run([process.execPath, binary, ...args], options.cwd ?? repoRoot, {
    ...process.env,
    HOME: isolatedHome,
    ORI_EVAL_RUNTIME_CACHE: isolatedRuntimeCache,
    ORI_TELEMETRY: "0",
    ...options.env
  });

const decodeEnvelope = (output: string): Record<string, unknown> =>
  JSON.parse(output) as Record<string, unknown>;

const makeRepository = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ori-eval-product-case-"));
  const init = await run(["git", "init", "-q", root], root);
  assert.equal(init.exitCode, 0);
  return root;
};

before(
  async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), "ori-eval-product-home-"));
    isolatedRuntimeCache = await mkdtemp(path.join(os.tmpdir(), "ori-eval-product-runtime-"));
    repository = await mkdtemp(path.join(os.tmpdir(), "ori-eval-product-repo-"));
    const init = await run(["git", "init", "-q", repository], repository);
    assert.equal(init.exitCode, 0);
    const build = await run(
      [
        process.execPath,
        "--experimental-strip-types",
        "--experimental-sqlite",
        path.join(packageRoot, "src", "build.ts")
      ],
      packageRoot,
      { ...process.env, PATH: strippedPath }
    );
    assert.equal(build.exitCode, 0, build.stderr);
    await chmod(binary, 0o755);
  },
  { timeout: 120_000 }
);

after(async () => {
  if (isolatedHome !== "") await rm(isolatedHome, { recursive: true, force: true });
  if (isolatedRuntimeCache !== "") {
    await rm(isolatedRuntimeCache, { recursive: true, force: true });
  }
  if (repository !== "") await rm(repository, { recursive: true, force: true });
});

describe("production standalone eval product", () => {
  test("runs evals with PATH limited to the node directory and system bins", async () => {
    const scratchResult = await invoke(["--json", "eval", "scratch"], {
      env: { PATH: strippedPath }
    });
    assert.equal(scratchResult.exitCode, 0);
    const scratch = (
      decodeEnvelope(scratchResult.stdout) as {
        data: { path: string };
      }
    ).data.path;
    const evalFile = path.join(scratch, "bundled-runtime.eval.ts");
    await writeFile(
      evalFile,
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { setupAgent } from "routekit/eval";',
        "setupAgent;",
        'test("bundled runtime", () => assert.equal(2 + 2, 4));',
        ""
      ].join("\n")
    );

    const dryRun = await invoke(["--json", "eval", "--dry-run", "--path", evalFile], {
      cwd: scratch,
      env: { PATH: strippedPath }
    });
    assert.equal(dryRun.exitCode, 0);
    assertMatchObject(decodeEnvelope(dryRun.stdout), {
      data: {
        dryRun: true,
        testCount: 1
      }
    });
    const fullRun = await invoke(
      ["--json", "eval", "--allow-no-key", "--no-history", "--path", evalFile],
      {
        cwd: scratch,
        env: {
          OPENROUTER_API_KEY: undefined,
          PATH: strippedPath
        }
      }
    );
    assert.equal(fullRun.exitCode, 0);
    assertMatchObject(decodeEnvelope(fullRun.stdout), {
      data: {
        results: [],
        tests: [
          {
            name: "bundled runtime",
            status: "pass"
          }
        ]
      }
    });
  });

  test("exposes auth, login, code, eval, spawn, and version product commands", async () => {
    const result = await invoke(["--help"]);
    assert.equal(result.exitCode, 0);
    assert.ok(String(result.stdout).includes("login"));
    assert.ok(String(result.stdout).includes("auth"));
    assert.ok(String(result.stdout).includes("code"));
    assert.ok(String(result.stdout).includes("eval"));
    assert.ok(String(result.stdout).includes("spawn"));
    assert.ok(String(result.stdout).includes("version"));
    assert.ok(!String(result.stdout).includes("schedules"));
    assert.ok(!String(result.stdout).includes("slack"));
  });

  test("routes -v and --version to the version command", async () => {
    const dashed = await invoke(["--human", "--version"]);
    assert.equal(dashed.exitCode, 0);
    assert.match(String(dashed.stdout), /@ori\/eval-system\s+\S+/u);
    const short = await invoke(["--human", "-v"]);
    assert.equal(short.exitCode, 0);
    assert.match(String(short.stdout), /@ori\/eval-system\s+\S+/u);
    const json = await invoke(["--json", "--version"]);
    assert.equal(json.exitCode, 0);
    assertMatchObject(decodeEnvelope(json.stdout), {
      data: {
        name: "@ori/eval-system"
      }
    });
  });

  test("keeps spawn reachable through leading --json flags", async () => {
    const result = await invoke(["--json", "spawn", "manifest"], {
      env: { OPENROUTER_API_KEY: undefined }
    });
    assert.equal(result.exitCode, SPAWN_EXIT.ok);
    const envelope = decodeEnvelope(result.stdout);
    assertMatchObject(envelope, {
      ok: true,
      protocolVersion: SPAWN_PROTOCOL_VERSION,
      harness: "pi",
      authorHarnesses: [...AUTHOR_HARNESSES]
    });
    for (const key of MANIFEST_REQUIRED_KEYS) {
      assert.ok(Object.hasOwn(envelope, key), key);
    }
    const host = envelope.host as Record<string, unknown>;
    for (const key of HOST_REQUIRED_KEYS) {
      assert.ok(Object.hasOwn(host, key), key);
    }
    assertMatchObject(host, {
      apiBaseUrl: DEFAULT_EVAL_API_BASE_URL,
      apiBaseUrlEnv: EVAL_API_BASE_URL_ENV,
      credential: "missing",
      credentialEnv: "OPENROUTER_API_KEY"
    });
  });

  test("bare launch stays on help instead of starting a TUI", async () => {
    const result = await invoke([]);
    assert.equal(result.exitCode, 0);
    assert.ok(String(result.stdout).includes("spawn"));
    assert.ok(String(result.stdout).includes("eval"));
  });

  test("headless code without a prompt fails instead of launching tui", async () => {
    const result = await invoke(["code"]);
    assert.notEqual(result.exitCode, 0);
    assert.ok(`${result.stdout}\n${result.stderr}`.includes("prompt"));
  });

  test("embeds the production create-eval skill", async () => {
    const result = await invoke(["--human", "eval", "skill"]);
    assert.equal(result.exitCode, 0);
    assert.ok(String(result.stdout).includes("# Create Eval"));
    assert.ok(String(result.stdout).includes("Phase 1/5: Workspace context"));
    assert.ok(String(result.stdout).includes("[candidates]"));
    assert.ok(String(result.stdout).includes("[next-step]"));
  });

  test("creates the production scratch SDK and loads it through real node --test", async () => {
    const scratchResult = await invoke(["--json", "eval", "scratch"]);
    assert.equal(scratchResult.exitCode, 0);
    const envelope = decodeEnvelope(scratchResult.stdout) as { data: { path: string } };
    const scratch = envelope.data.path;
    const template = path.join(scratch, "starter.eval.ts.template");
    const evalFile = path.join(scratch, "starter.eval.ts");
    await copyFile(template, evalFile);

    const source = await readFile(evalFile, "utf8");
    assert.ok(String(source).includes('from "routekit/eval"'));
    assert.ok(
      String(await readFile(path.join(scratch, "sdk", "routekit", "eval.js"), "utf8")).includes(
        "setupAgent"
      )
    );

    const dryRun = await invoke(["--json", "eval", "--dry-run", "--path", evalFile], {
      cwd: scratch
    });
    assert.equal(dryRun.exitCode, 0);
    const dryEnvelope = decodeEnvelope(dryRun.stdout) as {
      data: { dryRun: boolean; testCount: number; tests: Array<{ status: string }> };
    };
    assert.equal(dryEnvelope.data.dryRun, true);
    assert.equal(dryEnvelope.data.testCount, 1);
    assert.equal(dryEnvelope.data.tests[0]?.status, "skipped");
  });

  test("runs the real node --test/JUnit/result/report/history pipeline without fabricating a provider call", async () => {
    const scratchResult = await invoke(["--json", "eval", "scratch"]);
    const scratch = (
      decodeEnvelope(scratchResult.stdout) as {
        data: { path: string };
      }
    ).data.path;
    const evalFile = path.join(scratch, "plumbing.eval.ts");
    await writeFile(
      evalFile,
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'import { setupAgent } from "routekit/eval";',
        'const agent = setupAgent({ model: "openai/gpt-5.6-terra" });',
        'test("production eval plumbing", () => {',
        '  assert.equal(typeof agent.run, "function");',
        "});",
        ""
      ].join("\n")
    );

    const result = await invoke(
      ["--json", "eval", "--allow-no-key", "--report", "report.md", "--path", evalFile],
      {
        cwd: scratch,
        env: { OPENROUTER_API_KEY: undefined }
      }
    );
    assert.equal(result.exitCode, 0);
    const envelope = decodeEnvelope(result.stdout) as {
      data: {
        results: unknown[];
        tests: Array<{ name: string; status: string }>;
      };
    };
    assert.deepEqual(envelope.data.results, []);
    assertMatchObject(envelope.data.tests, [
      {
        name: "production eval plumbing",
        status: "pass"
      }
    ]);
    assert.ok(
      String(await readFile(path.join(scratch, "report.md"), "utf8")).includes("## Run history")
    );
    const history = await readFile(path.join(scratch, ".ori", "eval", "history.jsonl"), "utf8");
    assert.ok(String(history).includes('"runs":0'));
    assert.ok(String(history).includes('"passed":1'));
  });

  test("writes structured scratch and eval-run artifacts for the outer workflow", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "ori-eval-product-artifacts-"));
    try {
      const scratchRecord = path.join(artifactRoot, "scratch.txt");
      const runRecord = path.join(artifactRoot, "runs.jsonl");
      const scratchResult = await invoke(["--json", "eval", "scratch"], {
        env: { ROUTEKIT_EVAL_SCRATCH_PATH_FILE: scratchRecord }
      });
      assert.equal(scratchResult.exitCode, 0);
      const scratch = (
        decodeEnvelope(scratchResult.stdout) as {
          data: { path: string };
        }
      ).data.path;
      assert.equal((await readFile(scratchRecord, "utf8")).trim(), scratch);

      const evalFile = path.join(scratch, "artifact.eval.ts");
      await writeFile(
        evalFile,
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'test("structured artifact", () => assert.equal(true, true));',
          ""
        ].join("\n")
      );
      const result = await invoke(["--json", "eval", "--allow-no-key", "--path", evalFile], {
        cwd: scratch,
        env: { ORI_EVAL_RUN_RECORD_FILE: runRecord }
      });
      assert.equal(result.exitCode, 0);
      const rows = (await readFile(runRecord, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(rows.length, 1);
      assertMatchObject(rows[0], {
        exitCode: 0,
        files: [evalFile],
        results: [],
        workingDirectory: scratch
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  test("uses the real credential gate and never starts a model run without auth", async () => {
    const auth = await invoke(["--json", "auth"], { env: { OPENROUTER_API_KEY: undefined } });
    assert.notEqual(auth.exitCode, 0);
    const authEnvelope = decodeEnvelope(auth.stdout) as { data: { authenticated: boolean } };
    assert.equal(authEnvelope.data.authenticated, false);

    const scratchResult = await invoke(["--json", "eval", "scratch"]);
    const scratch = (decodeEnvelope(scratchResult.stdout) as { data: { path: string } }).data.path;
    const evalFile = path.join(scratch, "starter.eval.ts");
    await copyFile(path.join(scratch, "starter.eval.ts.template"), evalFile);
    const result = await invoke(["--json", "eval", "--path", evalFile], {
      cwd: scratch,
      env: { OPENROUTER_API_KEY: undefined }
    });
    assert.notEqual(result.exitCode, 0);
    assert.ok(String(result.stdout).includes("not signed in to OpenRouter"));
  });

  test("owns the real outer run protocol and stops at the production auth boundary", async () => {
    const requestFile = path.join(repository, "request.txt");
    await writeFile(requestFile, "compare the real model behavior\n");
    const prepared = await invoke(
      ["spawn", "prepare", "--request-file", requestFile, "--repo", repository],
      { cwd: repository, env: { OPENROUTER_API_KEY: undefined } }
    );
    assert.equal(prepared.exitCode, 0);
    const prepareEnvelope = decodeEnvelope(prepared.stdout) as {
      runDirectory: string;
      state: {
        authorWorkspace: string;
        harness: string;
        judgeModel: string;
        runModel: string;
        status: string;
      };
    };
    for (const key of PREPARED_REQUIRED_KEYS) {
      assert.ok(Object.hasOwn(prepareEnvelope, key), key);
    }
    assertMatchObject(prepareEnvelope.state, {
      harness: "pi",
      judgeModel: "openai/gpt-5.6-terra",
      runModel: "openai/gpt-5.6-terra",
      status: "prepared"
    });
    assert.ok(
      String(await readFile(path.join(prepareEnvelope.runDirectory, "task.txt"), "utf8")).includes(
        "Use the create-eval skill"
      )
    );
    assert.ok(
      String(await readFile(path.join(prepareEnvelope.runDirectory, "task.txt"), "utf8")).includes(
        prepareEnvelope.state.authorWorkspace
      )
    );
    assertMatchObject(
      JSON.parse(
        await readFile(path.join(prepareEnvelope.runDirectory, "source-snapshot.json"), "utf8")
      ),
      {
        digest: /^[a-f0-9]{64}$/u
      }
    );
    assert.equal(
      (await stat(path.join(prepareEnvelope.runDirectory, "state.json"))).mode & 0o777,
      0o600
    );

    const duplicate = await invoke(
      ["spawn", "prepare", "--request-file", requestFile, "--repo", repository],
      { cwd: repository }
    );
    assertMatchObject(decodeEnvelope(duplicate.stdout), {
      status: "action-required",
      choices: ["resume", "archive", "stop"]
    });

    const result = await invoke(["spawn", "run", "--repo", repository], {
      cwd: repository,
      env: { OPENROUTER_API_KEY: undefined }
    });
    assert.equal(result.exitCode, SPAWN_EXIT.usage);
    assertMatchObject(decodeEnvelope(result.stdout), { status: "auth-required" });
    assert.equal(await fileExists(path.join(prepareEnvelope.runDirectory, "run.lock")), false);
  });

  test("passes an empty user request through unchanged", async () => {
    const repo = await makeRepository();
    try {
      const prepared = await invoke(["spawn", "prepare", "--repo", repo]);
      assert.equal(prepared.exitCode, 0);
      const envelope = decodeEnvelope(prepared.stdout) as {
        runDirectory: string;
        state: { request: string };
      };
      assert.equal(envelope.state.request, "");
      assert.ok(
        String(await readFile(path.join(envelope.runDirectory, "task.txt"), "utf8")).includes(
          "User request: \n"
        )
      );
      const status = await invoke(["spawn", "status", "--repo", repo]);
      assert.equal(status.exitCode, 0);
      assertMatchObject(decodeEnvelope(status.stdout), {
        state: { request: "" },
        status: "prepared"
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("accepts Claude and Codex as author harnesses and rejects unknown names", async () => {
    const repo = await makeRepository();
    try {
      const unknown = await invoke(["spawn", "prepare", "--repo", repo, "--harness", "opencode"]);
      assert.equal(unknown.exitCode, SPAWN_EXIT.usage);
      const envelope = decodeEnvelope(unknown.stdout);
      for (const key of ERROR_REQUIRED_KEYS) {
        assert.ok(Object.hasOwn(envelope, key), key);
      }
      assertMatchObject(envelope, {
        ok: false,
        status: "error",
        error: "unknown author harness opencode; expected pi, claude, codex"
      });
      const claude = await invoke(["spawn", "prepare", "--repo", repo, "--harness", "claude"]);
      assert.equal(claude.exitCode, 0);
      assertMatchObject(decodeEnvelope(claude.stdout), {
        state: { harness: "claude", status: "prepared" }
      });
      const archived = await invoke([
        "spawn",
        "prepare",
        "--repo",
        repo,
        "--harness",
        "codex",
        "--existing",
        "archive"
      ]);
      assert.equal(archived.exitCode, 0);
      assertMatchObject(decodeEnvelope(archived.stdout), {
        state: { harness: "codex", status: "prepared" }
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("normalizes resume requests and archives every prior artifact instead of deleting it", async () => {
    const repo = await makeRepository();
    try {
      const first = await invoke([
        "spawn",
        "prepare",
        "--request",
        "compare   this\nagent",
        "--repo",
        repo
      ]);
      const firstEnvelope = decodeEnvelope(first.stdout) as { runDirectory: string };
      const resumed = await invoke([
        "spawn",
        "prepare",
        "--request",
        "compare this agent",
        "--repo",
        repo,
        "--existing",
        "resume"
      ]);
      assertMatchObject(decodeEnvelope(resumed.stdout), { status: "prepared" });

      await writeFile(path.join(firstEnvelope.runDirectory, "answer-1.txt"), "paid work\n");
      const archived = await invoke([
        "spawn",
        "prepare",
        "--request",
        "a new request",
        "--repo",
        repo,
        "--existing",
        "archive"
      ]);
      const archiveEnvelope = decodeEnvelope(archived.stdout) as {
        archived: string;
        state: { request: string };
      };
      assert.equal(archiveEnvelope.state.request, "a new request");
      assert.equal(
        await readFile(path.join(archiveEnvelope.archived, "answer-1.txt"), "utf8"),
        "paid work\n"
      );
      assert.ok((await readdir(archiveEnvelope.archived)).includes("ori"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("refuses corrupt or incompatible state and reports orphan files", async () => {
    const repo = await makeRepository();
    try {
      const prepared = await invoke([
        "spawn",
        "prepare",
        "--request",
        "state validation",
        "--repo",
        repo
      ]);
      const envelope = decodeEnvelope(prepared.stdout) as { runDirectory: string };
      await writeFile(path.join(envelope.runDirectory, "state.json"), "{broken");

      const status = await invoke(["spawn", "status", "--repo", repo]);
      assertMatchObject(decodeEnvelope(status.stdout), {
        status: "invalid"
      });
      assert.ok(String(status.stdout).includes("not valid JSON"));

      const result = await invoke(["spawn", "run", "--repo", repo]);
      assert.notEqual(result.exitCode, 0);
      assert.ok(String(result.stdout).includes("not valid JSON"));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("recovers a stale lock and rejects a live owner", async () => {
    const repo = await makeRepository();
    try {
      const prepared = await invoke([
        "spawn",
        "prepare",
        "--request",
        "lock semantics",
        "--repo",
        repo
      ]);
      const envelope = decodeEnvelope(prepared.stdout) as { runDirectory: string };
      const lock = path.join(envelope.runDirectory, "run.lock");

      await writeFile(lock, "99999999\n");
      const stale = await invoke(["spawn", "run", "--repo", repo], {
        env: { OPENROUTER_API_KEY: undefined }
      });
      assertMatchObject(decodeEnvelope(stale.stdout), { status: "auth-required" });
      assert.equal(await fileExists(lock), false);

      await writeFile(lock, `${process.pid}\n`);
      const live = await invoke(["spawn", "run", "--repo", repo]);
      assert.equal(live.exitCode, SPAWN_EXIT.conflict);
      assert.ok(String(live.stdout).includes("another spawn run owns"));
      assert.equal(await readFile(lock, "utf8"), `${process.pid}\n`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("reflects a host API origin and environment credential in spawn manifest", async () => {
    const gateway = "https://gateway.example/api";
    const missing = await invoke(["spawn", "manifest"], {
      env: { [EVAL_API_BASE_URL_ENV]: gateway, OPENROUTER_API_KEY: undefined }
    });
    assert.equal(missing.exitCode, SPAWN_EXIT.ok);
    assertMatchObject(decodeEnvelope(missing.stdout), {
      host: {
        apiBaseUrl: gateway,
        credential: "missing"
      }
    });
    const present = await invoke(["spawn", "manifest"], {
      env: { [EVAL_API_BASE_URL_ENV]: `${gateway}/`, OPENROUTER_API_KEY: "sk-or-v1-test" }
    });
    assertMatchObject(decodeEnvelope(present.stdout), {
      host: {
        apiBaseUrl: gateway,
        credential: "environment"
      }
    });
  });

  test("provides the real spawn skill and never bundles unrelated Slack or chat UI product code", async () => {
    const skill = await invoke(["spawn", "skill"]);
    assert.equal(skill.exitCode, 0);
    assert.ok(String(skill.stdout).includes("ori-eval-system spawn prepare"));
    assert.ok(String(skill.stdout).includes("Never invent a model, result, cost"));
    assert.ok(String(skill.stdout).includes("accepted: false"));
    assert.ok(String(skill.stdout).includes("cheaperRerun"));
    assert.ok(String(skill.stdout).includes("model comparison"));
    assert.equal(String(skill.stdout).includes("Check for bun"), false);
    const manifest = await invoke(["spawn", "manifest"]);
    assert.equal(manifest.exitCode, 0);
    assertMatchObject(decodeEnvelope(manifest.stdout), {
      ok: true,
      protocolVersion: SPAWN_PROTOCOL_VERSION,
      harness: "pi",
      authorHarnesses: [...AUTHOR_HARNESSES],
      skills: {
        createEval: {
          sha256: /^[a-f0-9]{64}$/u
        },
        spawnOriEval: {
          sha256: /^[a-f0-9]{64}$/u
        }
      }
    });

    const entry = path.join(packageRoot, "src", "entry.ts");
    const result = await esbuild.build({
      absWorkingDir: repoRoot,
      bundle: true,
      define: {
        ORI_CLI_COMPILED: "false"
      },
      entryPoints: [entry],
      format: "esm",
      metafile: true,
      packages: "external",
      platform: "node",
      write: false
    });
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    assert.equal(
      inputs.some((input) => input.includes("framework/builtins/slack")),
      false
    );
    assert.equal(
      inputs.some((input) => input.includes("framework/builtins/chat-tui")),
      false
    );
    assert.equal(
      inputs.some((input) => input.includes("selected-adapter-contributions/claude")),
      true
    );
    assert.equal(
      inputs.some((input) => input.includes("selected-adapter-contributions/codex")),
      true
    );
    assert.equal(
      inputs.some((input) => input.includes("adapter-claude-acp")),
      true
    );
    assert.equal(
      inputs.some((input) => input.includes("adapter-codex-acp")),
      true
    );
    const localInputs = inputs.filter((input) => !input.includes("/node_modules/"));
    assert.equal(
      localInputs.every((input) => input.includes("packages/eval-engine/")),
      true
    );
  });
});

describe("credential-gated live production qualification", () => {
  const enabled = process.env.ORI_EVAL_LIVE === "1";
  const liveTest = enabled ? test : test.skip;

  liveTest(
    "runs a real model through daemon, harness, node SDK, JUnit, JSONL, and report",
    { timeout: 300_000 },
    async () => {
      const key = process.env.OPENROUTER_API_KEY;
      const model = process.env.ORI_EVAL_LIVE_MODEL;
      if (!key || !model)
        throw new Error("ORI_EVAL_LIVE requires OPENROUTER_API_KEY and ORI_EVAL_LIVE_MODEL");

      const scratchResult = await invoke(["--json", "eval", "scratch"], {
        env: { OPENROUTER_API_KEY: key }
      });
      const scratch = (decodeEnvelope(scratchResult.stdout) as { data: { path: string } }).data
        .path;
      const evalFile = path.join(scratch, "live.eval.ts");
      await writeFile(
        evalFile,
        `import { setupAgent } from "routekit/eval";\nimport { test } from "node:test";\nconst agent = setupAgent({ model: ${JSON.stringify(model)} });\ntest("real model call", async () => {\n  const run = await agent.run("Reply with exactly ROUTEKIT_LIVE_EVAL_OK");\n  run.toComplete();\n  run.toMention("ROUTEKIT_LIVE_EVAL_OK");\n});\n`
      );
      const result = await invoke(
        ["--json", "eval", "--no-history", "--report", "report.md", "--path", evalFile],
        { cwd: scratch, env: { OPENROUTER_API_KEY: key } }
      );
      assert.equal(result.exitCode, 0);
      const envelope = decodeEnvelope(result.stdout) as {
        data: { results: Array<{ outcome: string }>; tests: Array<{ status: string }> };
      };
      assert.equal(envelope.data.tests[0]?.status, "pass");
      assert.equal(envelope.data.results[0]?.outcome, "passed");
      assert.ok(
        String(await readFile(path.join(scratch, "report.md"), "utf8")).includes("## Models")
      );
    }
  );
});
