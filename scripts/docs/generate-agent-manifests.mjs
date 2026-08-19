#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commandPolicies,
  commandSummaryOverrides,
  errorCatalog,
  internalCommandPaths
} from "./agent-manifest-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliModulePath = path.join(root, "packages/cli/dist/cli.js");
const outputDirectory = path.join(root, "apps/docs/public/agent");
const commandOutputPath = path.join(outputDirectory, "commands.json");
const errorOutputPath = path.join(outputDirectory, "errors.json");
const check = process.argv.slice(2).includes("--check");

if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("usage: generate-agent-manifests.mjs [--check]");
}
if (!existsSync(cliModulePath)) {
  throw new Error(
    "RouteKit CLI build is missing. Run `pnpm build:cli` before generating agent manifests."
  );
}

const { buildProgram } = await import(pathToFileURL(cliModulePath).href);
const {
  commandArguments,
  commandNames,
  commandOptions,
  effectCommandPath,
  flattenEffectCommands
} = await import(
  pathToFileURL(path.join(root, "packages/cli-core/dist/index.js")).href
);
const { actionableCommandPaths } = await import(
  pathToFileURL(path.join(root, "packages/cli/dist/command-path.js")).href
);
const program = buildProgram();

const commandsByPath = new Map(
  flattenEffectCommands(program).map((command) => [effectCommandPath(program, command), command])
);
const actionablePaths = actionableCommandPaths(program);

for (const internalPath of internalCommandPaths) {
  if (!actionablePaths.includes(internalPath)) {
    throw new Error(`internal command policy references a missing command: ${internalPath}`);
  }
}

const manifestPaths = actionablePaths.filter(
  (commandPath) => !internalCommandPaths.has(commandPath)
);
const missingPolicies = manifestPaths.filter(
  (commandPath) => commandPolicies[commandPath] === undefined
);
const stalePolicies = Object.keys(commandPolicies).filter(
  (commandPath) => !manifestPaths.includes(commandPath)
);
if (missingPolicies.length > 0 || stalePolicies.length > 0) {
  throw new Error(
    [
      missingPolicies.length > 0
        ? `commands missing agent policy: ${missingPolicies.join(", ")}`
        : undefined,
      stalePolicies.length > 0
        ? `agent policies without commands: ${stalePolicies.join(", ")}`
        : undefined
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function argumentShape(argument) {
  const value = `${argument.name}${argument.variadic ? "..." : ""}`;
  return argument.optional ? `[${value}]` : `<${value}>`;
}

function serializeArgument(argument) {
  return {
    name: argument.name,
    required: !argument.optional,
    variadic: argument.variadic,
    ...(argument.description ? { description: argument.description } : {})
  };
}

function serializeOption(option) {
  const names = [
    ...option.aliases.map((alias) => alias.length === 1 ? `-${alias}` : `--${alias}`),
    `--${option.name}`
  ];
  return {
    flags: `${names.join(", ")}${option.boolean ? "" : " <value>"}`,
    description: option.description ?? "",
    value: option.boolean ? "none" : "required",
    ...(option.hidden ? { visibility: "hidden" } : {})
  };
}

function documentationLinks(routes) {
  return routes.map((html) => ({ html, markdown: `${html}.md` }));
}

function verifyDocumentationRoute(route) {
  if (!route.startsWith("/docs")) return;
  const relative = route === "/docs" ? "index" : route.slice("/docs/".length);
  const sourcePath = path.join(root, "apps/docs/content/docs", `${relative}.mdx`);
  if (!existsSync(sourcePath))
    throw new Error(`agent manifest references missing docs route: ${route}`);
}

for (const policy of Object.values(commandPolicies)) {
  for (const route of policy.docs) verifyDocumentationRoute(route);
}
for (const error of errorCatalog) {
  for (const route of error.docs) verifyDocumentationRoute(route);
}

const commandManifest = {
  schemaVersion: 1,
  product: "RouteKit",
  surface: "cli",
  documentationPolicy:
    "Describes current behavior on main, including changes scheduled for the next package release.",
  freshness: {
    source: "The checked-out Effect command tree plus reviewed agent safety policy.",
    check: "CLI tests fail when this manifest differs from the command tree.",
    regenerate: "pnpm docs:generate-agent-manifests"
  },
  globalOptions: commandOptions(program).map(serializeOption),
  commands: Object.keys(commandPolicies)
    .sort((left, right) => left.localeCompare(right))
    .map((manifestPath) => {
      const command = commandsByPath.get(manifestPath);
      if (command === undefined) throw new Error(`missing command: ${manifestPath}`);
      const policy = commandPolicies[manifestPath];
      const summary = commandSummaryOverrides[manifestPath] ?? command.description;
      if (!summary) throw new Error(`command has no agent-facing summary: ${manifestPath}`);
      const arguments_ = commandArguments(command);
      const argumentSyntax = arguments_.map(argumentShape);
      return {
        path: manifestPath,
        argv: ["routekit", ...manifestPath.split(" ")],
        usage: ["routekit", manifestPath, ...argumentSyntax].filter(Boolean).join(" "),
        summary,
        ...(commandNames(command).length > 1 ? { aliases: commandNames(command).slice(1) } : {}),
        arguments: arguments_.map(serializeArgument),
        options: commandOptions(command).map(serializeOption),
        category: policy.category,
        visibility: policy.visibility,
        safety: {
          effect: policy.effect,
          target: policy.target,
          interaction: policy.interaction,
          jsonOutput: policy.jsonOutput,
          ...(policy.jsonNotes !== undefined ? { jsonNotes: policy.jsonNotes } : {}),
          secretOutput: policy.secretOutput,
          sensitiveInputs: policy.sensitiveInputs
        },
        ...(policy.verification !== undefined ? { verification: policy.verification } : {}),
        documentation: documentationLinks(policy.docs)
      };
    })
};

const errorManifest = {
  schemaVersion: 1,
  product: "RouteKit",
  surface: "cli-and-control-errors",
  documentationPolicy:
    "Describes current behavior on main, including changes scheduled for the next package release.",
  envelope: {
    contentType: "application/json",
    shape: {
      error: {
        code: "string",
        message: "string",
        details: "optional array",
        hint: "optional string",
        try: "optional human-readable shell command",
        tryArgv: "optional exact argv array",
        docs: "optional documentation URL"
      }
    },
    instruction:
      "Prefer tryArgv when present. Do not parse or execute the human-readable try string blindly."
  },
  freshness: {
    source: [
      "packages/cli-core/src/errors.ts",
      "packages/runtime/src/service/control.ts",
      "packages/cli/src"
    ],
    regenerate: "pnpm docs:generate-agent-manifests"
  },
  errors: [...errorCatalog]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((error) => ({
      code: error.code,
      surface: error.surface,
      meaning: error.meaning,
      retry: error.retry,
      diagnosticArgv: error.diagnostics,
      ...(error.recovery !== undefined ? { recoveryArgv: error.recovery } : {}),
      guidance: error.guidance,
      documentation: documentationLinks(error.docs)
    }))
};

const outputs = [
  { path: commandOutputPath, content: `${JSON.stringify(commandManifest, null, 2)}\n` },
  { path: errorOutputPath, content: `${JSON.stringify(errorManifest, null, 2)}\n` }
];

if (check) {
  for (const output of outputs) {
    const current = existsSync(output.path) ? await readFile(output.path, "utf8") : undefined;
    if (current !== output.content) {
      console.error(
        `${path.relative(root, output.path)} is stale; run pnpm docs:generate-agent-manifests`
      );
      process.exitCode = 1;
    }
  }
  if (process.exitCode === undefined) {
    console.log(
      `Agent manifests match ${commandManifest.commands.length} commands and ${errorManifest.errors.length} error codes.`
    );
  }
} else {
  await mkdir(outputDirectory, { recursive: true });
  for (const output of outputs) await writeFile(output.path, output.content);
  console.log(
    `Generated agent manifests for ${commandManifest.commands.length} commands and ${errorManifest.errors.length} error codes.`
  );
}
