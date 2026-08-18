import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_SHARED_PACKAGES,
  canonicalSharedPackageViolations,
  polynomialTrailingSlashRegexViolations,
  retiredEng814SourceViolations,
  routekitDependencyViolations,
  routekitSourceViolations,
  runtimeRootImportViolations,
  toolRegistryCliSourceViolations,
  toolRegistryCompositionViolations,
  toolRegistryConstructionViolations,
  toolRegistryConsumerSourceViolations
} from "../scripts/lib/architecture-guards.mjs";

const FORBIDDEN_PRODUCT = ["fu", "sion", "kit"].join("");
const FORBIDDEN_SCOPE = `@${FORBIDDEN_PRODUCT}/`;

function workspacePackage(name, dependencies = {}) {
  return {
    manifestPath: `packages/${name.split("/")[1]}/package.json`,
    manifest: { name, dependencies }
  };
}

test("RouteKit dependency guard rejects non-RouteKit workspace dependencies", () => {
  const foreignProtocol = `${FORBIDDEN_SCOPE}protocol`;
  const foreignRegistry = `${FORBIDDEN_SCOPE}registry`;
  const manifests = [
    workspacePackage("@velum-labs/routekit-contracts"),
    workspacePackage("@velum-labs/routekit-registry", {
      "@velum-labs/routekit-contracts": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit-gateway", {
      "@velum-labs/routekit-registry": "workspace:*"
    }),
    workspacePackage(foreignProtocol, {
      "@velum-labs/routekit-contracts": "workspace:*"
    }),
    workspacePackage(foreignRegistry, {
      "@velum-labs/routekit-registry": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit-bad-direct", {
      [foreignProtocol]: "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit-bad-transitive", {
      "@velum-labs/routekit-bad-direct": "workspace:*"
    })
  ];

  assert.deepEqual(
    routekitDependencyViolations(manifests).map((violation) => violation.dependencyPath),
    [
      ["@velum-labs/routekit-bad-direct", foreignProtocol],
      ["@velum-labs/routekit-bad-transitive", "@velum-labs/routekit-bad-direct", foreignProtocol]
    ]
  );
});

test("canonical shared package guard pins every owner name to its path", () => {
  const manifests = [...CANONICAL_SHARED_PACKAGES].map(([dir, name]) => ({
    dir,
    manifestPath: `${dir}/package.json`,
    manifest: { name }
  }));
  assert.deepEqual(canonicalSharedPackageViolations(manifests), []);
  const runtime = manifests.find((entry) => entry.dir === "packages/runtime");
  assert.ok(runtime);
  runtime.manifest.name = `${FORBIDDEN_SCOPE}runtime-utils`;
  assert.match(
    canonicalSharedPackageViolations(manifests)[0],
    /must declare @velum-labs\/routekit-runtime/
  );
});

test("tool registry guard enforces one neutral composition point for the RouteKit CLI", () => {
  const clean = [
    workspacePackage("@velum-labs/routekit-tools"),
    workspacePackage("@velum-labs/routekit-tool-codex"),
    workspacePackage("@velum-labs/routekit-tool-claude"),
    workspacePackage("@velum-labs/routekit-tool-cursor"),
    workspacePackage("@velum-labs/routekit-tool-opencode"),
    workspacePackage("@velum-labs/routekit-tool-registry", {
      "@velum-labs/routekit-tools": "workspace:*",
      "@velum-labs/routekit-tool-codex": "workspace:*",
      "@velum-labs/routekit-tool-claude": "workspace:*",
      "@velum-labs/routekit-tool-cursor": "workspace:*",
      "@velum-labs/routekit-tool-opencode": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit", {
      "@velum-labs/routekit-tool-registry": "workspace:*"
    })
  ];
  assert.deepEqual(toolRegistryCompositionViolations(clean), []);

  clean.at(-1).manifest.dependencies["@velum-labs/routekit-tool-codex"] = "workspace:*";
  assert.deepEqual(toolRegistryCompositionViolations(clean), [
    "@velum-labs/routekit must compose tools through @velum-labs/routekit-tool-registry, not @velum-labs/routekit-tool-codex"
  ]);
});

test("tool registry source guard rejects parallel imports and construction", () => {
  assert.deepEqual(
    toolRegistryConsumerSourceViolations(
      "packages/cli/src/tools.ts",
      [
        `import { setToolDriverRegistry } from "${FORBIDDEN_SCOPE}ensemble";`,
        'import { toolRegistry } from "@velum-labs/routekit-tool-registry";',
        "setToolDriverRegistry(toolRegistry);"
      ].join("\n")
    ),
    []
  );
  assert.deepEqual(
    toolRegistryConsumerSourceViolations(
      "packages/cli/src/launch.ts",
      [
        'import { codexTool } from "@velum-labs/routekit-tool-codex";',
        'import { createToolRegistry } from "@velum-labs/routekit-tools";',
        "export const toolRegistry = createToolRegistry([codexTool]);"
      ].join("\n")
    ),
    [
      "packages/cli/src/launch.ts must not import individual tool integrations",
      "packages/cli/src/launch.ts must not construct a parallel tool registry"
    ]
  );
});

test("tool registry CLI source guard scans every production source", () => {
  const routekitSources = [
    {
      file: "packages/cli/src/launch.ts",
      source: 'import { toolRegistry } from "@velum-labs/routekit-tool-registry";'
    },
    {
      file: "packages/cli/src/commands/install.ts",
      source: 'export { installCodexIntegration } from "@velum-labs/routekit-tool-codex";'
    }
  ];
  assert.deepEqual(toolRegistryCliSourceViolations("@velum-labs/routekit", routekitSources), [
    "packages/cli/src/commands/install.ts must not import individual tool integrations"
  ]);

  const foreignCli = `${FORBIDDEN_SCOPE}cli`;
  const foreignSources = [
    {
      file: "packages/cli/src/tools.ts",
      source: [
        'import { toolRegistry } from "@velum-labs/routekit-tool-registry";',
        "setToolDriverRegistry(toolRegistry);"
      ].join("\n")
    },
    {
      file: "packages/cli/src/commands/setup.ts",
      source: 'const loadTool = () => import("@velum-labs/routekit-tool-cursor");'
    }
  ];
  assert.deepEqual(toolRegistryCliSourceViolations(foreignCli, foreignSources), [
    "packages/cli/src/commands/setup.ts must not import individual tool integrations"
  ]);

  assert.deepEqual(
    toolRegistryCliSourceViolations("@velum-labs/routekit", [
      { file: "packages/cli/src/commands.ts", source: "export const commands = [];" }
    ]),
    ["@velum-labs/routekit production sources must import @velum-labs/routekit-tool-registry"]
  );
});

test("tool registry construction guard allows exactly one production owner", () => {
  const owner = {
    file: "packages/tool-registry/src/index.ts",
    source: "export const toolRegistry = createToolRegistry(toolIntegrations);"
  };
  assert.deepEqual(toolRegistryConstructionViolations([owner]), []);
  assert.deepEqual(
    toolRegistryConstructionViolations([
      owner,
      {
        file: "packages/other/src/tools.ts",
        source: "export const otherRegistry = createToolRegistry([]);"
      }
    ]),
    ["packages/other/src/tools.ts constructs a parallel tool registry"]
  );
  assert.deepEqual(toolRegistryConstructionViolations([]), [
    "packages/tool-registry/src/index.ts must construct the canonical registry exactly once"
  ]);
});

test("trailing slash guard rejects polynomial regexes but allows fixed /v1 matching", () => {
  const file = "packages/example/src/url.ts";
  assert.deepEqual(
    polynomialTrailingSlashRegexViolations(
      file,
      'export const normalize = (url) => url.replace(/\\/+$/, "");'
    ),
    [
      "packages/example/src/url.ts uses a polynomial trailing-slash regex; use @velum-labs/routekit-runtime slash helpers"
    ]
  );
  assert.deepEqual(
    polynomialTrailingSlashRegexViolations(
      file,
      'export const withoutV1 = (url) => url.replace(/\\/v1\\/?$/, "");'
    ),
    []
  );
});

test("Runtime root façade imports are rejected in production source", () => {
  assert.deepEqual(
    runtimeRootImportViolations(
      "packages/example/src/process.ts",
      'import { buildChildEnv } from "@velum-labs/routekit-runtime";'
    ),
    [
      "packages/example/src/process.ts must import a named @velum-labs/routekit-runtime subpath"
    ]
  );
  assert.deepEqual(
    runtimeRootImportViolations(
      "packages/example/src/process.ts",
      'import { buildChildEnv } from "@velum-labs/routekit-runtime/environment";'
    ),
    []
  );
  assert.deepEqual(
    runtimeRootImportViolations(
      "packages/eval-engine/src/library/gateway-bridge.ts",
      'import { buildChildEnv } from "@velum-labs/routekit-runtime";'
    ),
    []
  );
});

test("retired ENG-814 protocol and runner identifiers cannot return", () => {
  assert.deepEqual(
    retiredEng814SourceViolations(
      "packages/example/src/old.ts",
      "export type RoutingProfile = {}; export const runEvalSuite = () => undefined;"
    ),
    [
      "packages/example/src/old.ts contains retired ENG-814 identifier RoutingProfile",
      "packages/example/src/old.ts contains retired ENG-814 identifier runEvalSuite"
    ]
  );
  assert.deepEqual(
    retiredEng814SourceViolations(
      "packages/example/src/executor.ts",
      "export const request = { spendLimitUsd: 1 };"
    ),
    ["packages/example/src/executor.ts contains unenforced spendLimitUsd"]
  );
  assert.deepEqual(
    retiredEng814SourceViolations(
      "packages/eval-engine/src/library/eval-engine.ts",
      "export const request = { spendLimitUsd: 1 };"
    ),
    []
  );
});

test("RouteKit source guard targets production paths, declarations, and imports", () => {
  const foreignProtocol = `${FORBIDDEN_SCOPE}protocol`;
  assert.deepEqual(
    routekitSourceViolations(
      "packages/routekit-example/src/fusion-router.ts",
      `import { value } from "${foreignProtocol}";\nexport const ${FORBIDDEN_PRODUCT}Panel = value;\n`
    ),
    [
      "fusion vocabulary in production source path",
      `imports ${FORBIDDEN_SCOPE}*`,
      "fusion vocabulary in a declared production name"
    ]
  );
  assert.deepEqual(
    routekitSourceViolations(
      "packages/routekit-example/src/catalog.ts",
      `// ${FORBIDDEN_PRODUCT} is discussed in docs and tests, not banned as prose.\nexport const catalog = {};\n`
    ),
    []
  );
  assert.deepEqual(
    routekitSourceViolations(
      "packages/routekit-example/src/catalog.ts",
      'export const diffusionModel = { description: "supports diffusion models" };\n'
    ),
    []
  );
});
