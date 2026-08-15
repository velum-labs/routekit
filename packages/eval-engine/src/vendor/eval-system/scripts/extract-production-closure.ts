#!/usr/bin/env node

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface MetafileInput {
  readonly imports: readonly {
    readonly external?: boolean;
    readonly kind: string;
    readonly original?: string;
    readonly path: string;
  }[];
}

interface BuildMetafile {
  readonly inputs: Readonly<Record<string, MetafileInput>>;
}

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const sourceRoot = path.join(packageRoot, "src");
const vendorRoot = path.join(sourceRoot, "vendor");
const manifestPath = path.join(packageRoot, "PROVENANCE.json");
const entry = path.join(sourceRoot, "entry.ts");
const sourceCommit = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

const resolveFrom = (specifier: string, importerDirectory: string): string =>
  createRequire(path.join(importerDirectory, "package.json")).resolve(specifier);

const sha256 = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

const sourceSpecifiers = (contents: string): readonly string[] => {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ] as const;
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  return [...specifiers];
};

const isEvalSkillTypeSeam = (source: string, specifier: string): boolean =>
  source === path.join(repositoryRoot, "framework/cli/src/commands/eval/command.ts") &&
  specifier === "@routekit-eval-runtime/cli/commands/eval/skill-command";

const excludedProductionSource = (source: string): boolean => {
  const relative = path.relative(repositoryRoot, source).split(path.sep).join("/");
  return (
    relative === "framework/cli/src/commands/eval/skill-command.ts" ||
    relative === "framework/cli/src/commands/skills/skills-result.ts" ||
    relative === "framework/runloop/builtins-catalog/src/code-skill.ts" ||
    relative === "framework/runloop/builtins-catalog/src/source-root.ts" ||
    relative.startsWith("framework/builtins/code/skills/")
  );
};

const buildResult = await esbuild.build({
  bundle: true,
  define: {
    ROUTEKIT_EVAL_CLI_COMPILED: "false",
    ROUTEKIT_EVAL_CLI_PACKAGE_NAME: JSON.stringify("@velum-labs/routekit-eval-engine"),
    ROUTEKIT_EVAL_CLI_VERSION: JSON.stringify("0.4.0-eval-system"),
  },
  entryPoints: [entry],
  external: ["esbuild"],
  format: "esm",
  metafile: true,
  minify: false,
  platform: "node",
  plugins: [
    {
      name: "extraction-source-bootstrap",
      setup(build) {
        build.onResolve({ filter: /vendor\/framework/u }, (args) => {
          const requested = path.resolve(path.dirname(args.importer), args.path);
          const relative = path.relative(vendorRoot, requested);
          if (
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            !relative.startsWith(`framework${path.sep}`)
          ) {
            return undefined;
          }
          return { path: path.join(repositoryRoot, relative) };
        });
      },
    },
  ],
  write: false,
});
if (buildResult.errors.length > 0) {
  for (const log of buildResult.errors) console.error(log);
  throw new Error("could not calculate the production source closure");
}

const resolveMetafileInput = (input: string): string => {
  if (path.isAbsolute(input)) return input;
  const fromPackage = path.resolve(packageRoot, input);
  const fromRepo = path.resolve(repositoryRoot, input);
  if (existsSync(fromPackage)) return fromPackage;
  if (existsSync(fromRepo)) return fromRepo;
  return fromRepo;
};

const metafile = buildResult.metafile as BuildMetafile;
const bundledLocalInputs = Object.keys(metafile.inputs)
  .filter((input) => !input.includes("/node_modules/"))
  .map(resolveMetafileInput);
const productionInputSet = new Set(
  bundledLocalInputs.filter(
    (input) => !input.startsWith(`${packageRoot}${path.sep}`) && !excludedProductionSource(input),
  ),
);
const pending = [...productionInputSet];

while (pending.length > 0) {
  const source = pending.pop()!;
  if (!source.endsWith(".ts") && !source.endsWith(".tsx")) continue;
  const contents = await readFile(source, "utf8");
  for (const specifier of sourceSpecifiers(contents)) {
    if (isEvalSkillTypeSeam(source, specifier)) continue;
    let resolved: string;
    try {
      resolved = resolveFrom(specifier, path.dirname(source));
    } catch {
      continue;
    }
    if (
      resolved.includes(`${path.sep}node_modules${path.sep}`) ||
      resolved.startsWith("node:") ||
      resolved.startsWith("bun:") ||
      resolved.startsWith(`${packageRoot}${path.sep}`)
    ) {
      continue;
    }
    const relative = path.relative(repositoryRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (excludedProductionSource(resolved)) continue;
    if (!productionInputSet.has(resolved)) {
      productionInputSet.add(resolved);
      pending.push(resolved);
    }
  }
}

const productionInputs = [...productionInputSet].sort();

await rm(vendorRoot, { force: true, recursive: true });
await mkdir(vendorRoot, { recursive: true });

const destinationFor = (source: string): string => {
  const relative = path.relative(repositoryRoot, source);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`closure input is outside the source repository: ${source}`);
  }
  return path.join(vendorRoot, relative);
};

const sourceToDestination = new Map(
  productionInputs.map((source) => [source, destinationFor(source)]),
);

const packageNameFor = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
};

const externalPackages = new Set<string>();
const metadataBySource = new Map(
  Object.entries(metafile.inputs).map(([input, metadata]) => [
    resolveMetafileInput(input),
    metadata,
  ]),
);
const replacementBySource = new Map<string, Map<string, string>>();

for (const source of productionInputs) {
  const metadata = metadataBySource.get(source);
  const replacements = new Map<string, string>();
  const imports = new Map<string, { readonly original?: string; readonly path: string }>(
    (metadata?.imports ?? []).map((item) => [item.original ?? item.path, item]),
  );
  if (source.endsWith(".ts") || source.endsWith(".tsx")) {
    const contents = await readFile(source, "utf8");
    for (const specifier of sourceSpecifiers(contents)) {
      if (!imports.has(specifier)) {
        imports.set(specifier, { path: specifier });
      }
    }
  }

  for (const imported of imports.values()) {
    const specifier = imported.original ?? imported.path;
    if (isEvalSkillTypeSeam(source, specifier)) continue;
    let resolved: string | undefined;
    if (path.isAbsolute(imported.path)) {
      resolved = imported.path;
    } else {
      try {
        resolved = resolveFrom(specifier, path.dirname(source));
      } catch {
        resolved = undefined;
      }
    }
    if (resolved?.includes(`${path.sep}node_modules${path.sep}`)) {
      externalPackages.add(packageNameFor(specifier));
      continue;
    }
    if (resolved === undefined || resolved.startsWith("node:") || resolved.startsWith("bun:")) {
      continue;
    }
    const destination = sourceToDestination.get(resolved);
    if (destination === undefined) continue;
    let relative = path
      .relative(path.dirname(destinationFor(source)), destination)
      .split(path.sep)
      .join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    replacements.set(specifier, relative);
  }

  replacementBySource.set(source, replacements);
}

const rewriteSpecifiers = (contents: string, replacements: ReadonlyMap<string, string>): string => {
  let rewritten = contents;
  const ordered = [...replacements].sort(([left], [right]) => right.length - left.length);
  for (const [from, to] of ordered) {
    rewritten = rewritten.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
  }
  return rewritten;
};

const applyStandaloneOverlays = (source: string, contents: string): string => {
  if (source === path.join(repositoryRoot, "framework/cli/src/commands/eval/command.ts")) {
    const runRecordSupport = `
const EVAL_RUN_RECORD_FILE_ENV = "ROUTEKIT_EVAL_RUN_RECORD_FILE";

const appendEvalRunRecord = Effect.fn("EvalCommand.appendRunRecord")(
  function* (input: {
    readonly exitCode: number;
    readonly files: readonly string[];
    readonly results: readonly EvalResultRow[];
    readonly tests: readonly EvalTestRow[];
    readonly workingDirectory: string;
  }) {
    const hostProcess = yield* HostProcess;
    const env = yield* hostProcess.env;
    const recordFile = env[EVAL_RUN_RECORD_FILE_ENV]?.trim();
    if (recordFile === undefined || recordFile === "") return;
    yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: async () => {
        const { appendFile, mkdir } = await import("node:fs/promises");
        const path = await import("node:path");
        await mkdir(path.dirname(recordFile), { recursive: true });
        await appendFile(
          recordFile,
          \`\${JSON.stringify({
            endedAt: new Date().toISOString(),
            exitCode: input.exitCode,
            files: input.files,
            results: input.results,
            tests: input.tests,
            workingDirectory: input.workingDirectory,
          })}\\n\`,
          { encoding: "utf8", mode: 0o600 }
        );
      },
    }).pipe(Effect.ignore);
  }
);
`;
    return contents
      .replace(
        'import { evalSkillCommand } from "@routekit-eval-runtime/cli/commands/eval/skill-command";',
        'import type { evalSystemSkillCommand } from "../../../../../../eval-skill-command.ts";',
      )
      .replace(
        "\ninterface EvalCommandConfig {",
        `${runRecordSupport}\ninterface EvalCommandConfig {`,
      )
      .replace(
        "  const telemetry = yield* TelemetryService;\n",
        `  const telemetry = yield* TelemetryService;
  yield* appendEvalRunRecord({
    exitCode: input.exitCode,
    files: input.files,
    results: input.results,
    tests: input.tests,
    workingDirectory: input.workingDirectory,
  });
`,
      )
      .replace(
        "export const makeEvalCommand = (\n  options: DevCommandRuntimeOptions\n)",
        `export const makeEvalCommand = (
  options: DevCommandRuntimeOptions,
  skillCommand: typeof evalSystemSkillCommand
)`,
      )
      .replace("      evalSkillCommand,", "      skillCommand,");
  }
  if (source === path.join(repositoryRoot, "framework/cli/src/commands/eval/scratch-command.ts")) {
    const scratchRecordSupport = `
const SCRATCH_PATH_FILE_ENV = "ROUTEKIT_EVAL_SCRATCH_PATH_FILE";

const recordScratchPath = Effect.fn("EvalScratch.recordPath")(function* (
  root: string
) {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  const recordFile = env[SCRATCH_PATH_FILE_ENV]?.trim();
  if (recordFile === undefined || recordFile === "") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(recordFile), { recursive: true });
  yield* fs.writeFileString(recordFile, \`\${root}\\n\`);
});
`;
    return contents
      .replace(
        'import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";',
        `import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";`,
      )
      .replace(
        "\nexport const evalScratchCommand =",
        `${scratchRecordSupport}\nexport const evalScratchCommand =`,
      )
      .replace(
        "    const root = yield* createScratchWorkspace();\n",
        `    const root = yield* createScratchWorkspace();
    yield* recordScratchPath(root);
`,
      );
  }
  if (source === path.join(repositoryRoot, "framework/cli/src/default-command.ts")) {
    return contents
      .replace(
        "// Bare routekit-eval launches the coding agent; help stays at root and version routes to its subcommand.\n",
        `// This focused product has no interactive TUI. Bare launches stay at root help,
// \`-v\`/\`--version\` route to the version command, and unknown argv is not
// rewritten into \`code\`.\n`,
      )
      .replace(
      `  const insertDefault = (): readonly string[] => [
    ...args.slice(0, firstCommandIndex),
    DEFAULT_COMMAND_NAME,
    ...args.slice(firstCommandIndex),
  ];
  if (firstArg === undefined) {
    return args.length === 0 ? [DEFAULT_COMMAND_NAME] : insertDefault();
  }
  if (firstArg === "--help" || firstArg === "-h") {
    return args;
  }
  if (!firstArg.startsWith("-") && knownCommands.has(firstArg)) {
    return args;
  }
  return insertDefault();
};`,
      `  if (firstArg === undefined) {
    return [...args.slice(0, firstCommandIndex), "--help"];
  }
  if (firstArg === "--help" || firstArg === "-h") {
    return args;
  }
  if (!firstArg.startsWith("-") && knownCommands.has(firstArg)) {
    return args;
  }
  return args;
};`,
    );
  }
  if (
    source ===
    path.join(repositoryRoot, "framework/cli/src/commands/code/one-shot-launch.ts")
  ) {
    return contents
      .replace(
        `import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { interactiveCommandError } from "../../../../contracts/internal/src/cli/cli-output.ts";
`,
        `import { interactiveCommandError } from "../../../../contracts/internal/src/cli/cli-output.ts";
`,
      )
      .replace(
        `const NO_PROMPT_HINT =
  'Pass a prompt (\`routekit-eval code -p "<task>"\`) to run a single headless turn, or run it in a TTY.';`,
        `const NO_PROMPT_HINT =
  'Pass a prompt (\`routekit-eval-engine code -p "<task>"\` or \`--prompt-file\`) to run a single headless turn, or use \`spawn\` for the eval interview. This product has no interactive TUI.';`,
      )
      .replace(
        `      const cliIo = yield* CliIo;
      const { mode } = yield* OutputMode;
      const isStdoutTty = yield* cliIo.isStdoutTty;
      if (mode === "json" || !isStdoutTty) {
        return yield* interactiveCommandError("code", NO_PROMPT_HINT);
      }
      return { kind: "tui" } satisfies CodeLaunch;`,
        `      return yield* interactiveCommandError("code", NO_PROMPT_HINT);`,
      );
  }
  if (source === path.join(repositoryRoot, "framework/cli/src/routekit-eval.ts")) {
    return contents.replace(
      `"Gateway's intern. Create a workspace, build features, and run them locally."`,
      `"Standalone RouteKitEval eval system. Login, author a headless eval interview with spawn, and run *.eval.ts files against a real model."`,
    );
  }
  const hostEnvSpecifier = (): string => {
    let relative = path
      .relative(path.dirname(destinationFor(source)), path.join(sourceRoot, "host-env.ts"))
      .split(path.sep)
      .join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    return relative;
  };
  const requireOverlay = (next: string, label: string): string => {
    if (next === contents) throw new Error(`${label} overlay did not apply`);
    return next;
  };
  if (source === path.join(repositoryRoot, "framework/contracts/author/src/gateway-models.ts")) {
    return requireOverlay(
      contents
        .replace(
          'import { Schema } from "effect";\n',
          `import { Schema } from "effect";\n\nimport { evalModelsCatalogUrl } from "${hostEnvSpecifier()}";\n`,
        )
        .replace(
          "  fetchGatewayModelsRequest(fetchImpl, GATEWAY_MODELS_URL);",
          "  fetchGatewayModelsRequest(fetchImpl, evalModelsCatalogUrl());",
        ),
      "gateway-models host origin",
    );
  }
  if (source === path.join(repositoryRoot, "framework/contracts/author/src/gateway-endpoints.ts")) {
    return requireOverlay(
      contents
        .replace(
          'import { Schema } from "effect";\n',
          `import { Schema } from "effect";\n\nimport { evalModelEndpointsUrlBase } from "${hostEnvSpecifier()}";\n`,
        )
        .replace(
          "  `${GATEWAY_ENDPOINTS_URL_BASE}/${slug\n",
          "  `${evalModelEndpointsUrlBase()}/${slug\n",
        ),
      "gateway-endpoints host origin",
    );
  }
  if (source === path.join(repositoryRoot, "framework/runloop/local/src/gateway/models-live.ts")) {
    return requireOverlay(
      contents
        .replace(
          'import { Effect, Layer } from "effect";\n',
          `import { Effect, Layer } from "effect";\nimport { evalModelsCatalogUrl } from "${hostEnvSpecifier()}";\n`,
        )
        .replace(
          "  decodeGatewayModels,\n  GATEWAY_MODELS_URL,\n",
          "  decodeGatewayModels,\n",
        )
        .replaceAll("GATEWAY_MODELS_URL", "evalModelsCatalogUrl()"),
      "gateway models-live host origin",
    );
  }
  if (
    source ===
    path.join(repositoryRoot, "framework/runloop/adapters/adapter-claude-acp/src/native/process-config.ts")
  ) {
    return requireOverlay(
      contents
        .replace(
          'import { Redacted } from "effect";\n',
          `import { Redacted } from "effect";\n\nimport { evalApiBaseUrl } from "${hostEnvSpecifier()}";\n`,
        )
        .replace(
          '  ANTHROPIC_BASE_URL: Redacted.make("https://gateway.ai/api"),\n',
          "  ANTHROPIC_BASE_URL: Redacted.make(\n    baseEnv.ANTHROPIC_BASE_URL?.trim() || evalApiBaseUrl(baseEnv),\n  ),\n",
        ),
      "claude process-config host origin",
    );
  }
  if (
    source ===
    path.join(
      repositoryRoot,
      "framework/builtins/harness-pi/src/gateway-attribution/gateway-attribution.ts",
    )
  ) {
    return requireOverlay(
      contents
        .replace(
          'import { mkdir, readFile, writeFile } from "node:fs/promises";\n',
          `import { mkdir, readFile, writeFile } from "node:fs/promises";\n\nimport {\n  DEFAULT_EVAL_API_BASE_URL,\n  evalApiBaseUrl,\n  evalOpenAiCompatibleUrl,\n} from "${hostEnvSpecifier()}";\n`,
        )
        .replace(
          `const clearOwnedCaptureBaseUrl = (
  gateway: Record<string, unknown>
): boolean => {`,
          `const PI_ROUTEKIT_EVAL_HOST_API_BASE_URL_FIELD = "__oriHostApiBaseUrl";

const mergeHostApiBaseUrl = (
  gateway: Record<string, unknown>
): boolean => {
  const wanted =
    evalApiBaseUrl() === DEFAULT_EVAL_API_BASE_URL
      ? undefined
      : evalOpenAiCompatibleUrl();
  const owned = gateway[PI_ROUTEKIT_EVAL_HOST_API_BASE_URL_FIELD] === true;
  const existing = gateway[PI_BASE_URL_FIELD];
  if (wanted === undefined) {
    if (!owned) return false;
    gateway[PI_BASE_URL_FIELD] = undefined;
    gateway[PI_ROUTEKIT_EVAL_HOST_API_BASE_URL_FIELD] = undefined;
    return true;
  }
  if (typeof existing === "string" && !owned) return false;
  if (existing === wanted && owned) return false;
  gateway[PI_BASE_URL_FIELD] = wanted;
  gateway[PI_ROUTEKIT_EVAL_HOST_API_BASE_URL_FIELD] = true;
  return true;
};

const clearOwnedCaptureBaseUrl = (
  gateway: Record<string, unknown>
): boolean => {`,
        )
        .replace(
          "  const baseUrlChanged = clearOwnedCaptureBaseUrl(gateway);\n",
          "  const baseUrlChanged = clearOwnedCaptureBaseUrl(gateway);\n  const hostBaseUrlChanged = mergeHostApiBaseUrl(gateway);\n",
        )
        .replace(
          "    !(headersChanged || capChanged || baseUrlChanged || cacheControlChanged)\n",
          "    !(headersChanged || capChanged || baseUrlChanged || hostBaseUrlChanged || cacheControlChanged)\n",
        ),
      "pi models.json host origin",
    );
  }
  if (source === path.join(repositoryRoot, "framework/cli/src/commands/code/command.ts")) {
    return contents
      .replace(
        "    launch: CodeLaunch\n",
        '    launch: Exclude<CodeLaunch, { readonly kind: "tui" }>\n',
      )
      .replace(
        `  // Run the one best-effort launch-time update check before booting the daemon
  // or spawning the chat TUI. When it applies an update it relaunches the
  // original command on the fresh binary and fails with \`RouteKitEvalCliExit\`, so this
  // handler never reaches the session below on that path. A headless launch
  // skips it entirely: the check's own gate already skips non-interactive
  // terminals, but \`--print\`/\`--output jsonl\` on a TTY would otherwise still
  // prompt.
  if (launch.kind === "tui") {
    yield* runCodeUpdateLaunch();
  }
`,
        `  // Headless-only product: there is no TUI update prompt.
`,
      )
      .replace(
        `    const session = codeHeadlessConfig(inputs);
    if (launch.kind !== "tui") {
      return yield* Effect.scoped(
        runCodeHeadlessSession({
          harness: inputs.harness,
          launchCwd: inputs.launchCwd,
          model: inputs.model,
          options,
          output: launch.kind,
          prompt: launch.prompt,
          session,
          sessionId: inputs.sessionId,
        })
      );
    }
    return yield* Effect.scoped(runCodeScopedSession(options, inputs, session));`,
        `    const session = codeHeadlessConfig(inputs);
    return yield* Effect.scoped(
      runCodeHeadlessSession({
        harness: inputs.harness,
        launchCwd: inputs.launchCwd,
        model: inputs.model,
        options,
        output: launch.kind,
        prompt: launch.prompt,
        session,
        sessionId: inputs.sessionId,
      })
    );`,
      );
  }
  return contents;
};

const files: {
  readonly destination: string;
  readonly sha256: string;
  readonly source: string;
  readonly sourceSha256: string;
}[] = [];

for (const source of productionInputs) {
  const destination = destinationFor(source);
  await mkdir(path.dirname(destination), { recursive: true });
  const original = new Uint8Array(await readFile(source));
  const extension = path.extname(source);
  if (extension === ".ts" || extension === ".tsx") {
    const rewritten = applyStandaloneOverlays(
      source,
      rewriteSpecifiers(
        new TextDecoder().decode(original),
        replacementBySource.get(source) ?? new Map(),
      ),
    );
    await writeFile(destination, rewritten);
  } else {
    await copyFile(source, destination);
  }
  const extracted = new Uint8Array(await readFile(destination));
  files.push({
    destination: path.relative(packageRoot, destination).split(path.sep).join("/"),
    sha256: sha256(extracted),
    source: path.relative(repositoryRoot, source).split(path.sep).join("/"),
    sourceSha256: sha256(original),
  });
}

await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      externalPackages: [...externalPackages].sort(),
      files,
      generatedAt: new Date().toISOString(),
      sourceCommit,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `extracted ${files.length} production inputs into ${path.relative(repositoryRoot, vendorRoot)}`,
);
