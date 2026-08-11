const packageNames = [
  "accounts",
  "cli",
  "cli-core",
  "cli-ui",
  "config",
  "config-core",
  "contracts",
  "control",
  "daemon",
  "gateway",
  "harness-core",
  "registry",
  "router",
  "runtime",
  "telemetry-core",
  "testkit",
  "tool-claude",
  "tool-codex",
  "tool-cursor",
  "tool-opencode",
  "tool-registry",
  "tools",
  "tracing"
];

const internalRootBarrelRules = packageNames.map((packageName) => ({
  name: `no-${packageName}-internal-root-barrel-imports`,
  comment: "Production modules must import their package internals directly, not through index.ts.",
  severity: "error",
  from: {
    path: `^packages/${packageName}/src/.+`,
    pathNot:
      packageName === "daemon"
        ? "^packages/daemon/src/(index|host|worker)\\.ts$"
        : `^packages/${packageName}/src/index\\.ts$`
  },
  to: {
    path: `^packages/${packageName}/src/index\\.ts$`
  }
}));

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular",
      comment: "Production package code must remain acyclic.",
      severity: "error",
      from: {
        pathNot: "^packages/daemon/src/(index|host|worker)\\.ts$"
      },
      to: { circular: true }
    },
    {
      name: "no-unresolved",
      comment: "Every production import must resolve.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true }
    },
    {
      name: "no-undeclared-dependencies",
      comment: "External production imports must be declared by their owning package.",
      severity: "error",
      from: {},
      to: {
        dependencyTypes: ["npm-no-pkg", "npm-unknown"]
      }
    },
    {
      name: "no-cross-package-src-imports",
      comment:
        "Workspace packages must import each other through @velum-labs/routekit* package entry points, not relative paths into another package's src tree.",
      severity: "error",
      from: { path: "^packages/([^/]+)/" },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: "^packages/$1/"
      }
    },
    {
      name: "tools-only-via-registry",
      comment:
        "Individual tool-* integration packages may only be imported by tool-registry, tools, and themselves.",
      severity: "error",
      from: {
        pathNot:
          "^packages/(tool-registry|tool-codex|tool-claude|tool-cursor|tool-opencode|tools)/"
      },
      to: {
        path: "^packages/tool-(codex|claude|cursor|opencode)/"
      }
    },
    {
      name: "no-direct-tool-package-imports",
      comment:
        "Do not import @velum-labs/routekit-tool-* (except tool-registry) outside tool-registry/tools/owners.",
      severity: "error",
      from: {
        pathNot:
          "^packages/(tool-registry|tool-codex|tool-claude|tool-cursor|tool-opencode|tools)/"
      },
      to: {
        path: "node_modules/@velum-labs/routekit-tool-(codex|claude|cursor|opencode)(/|$)"
      }
    },
    {
      name: "foundation-does-not-import-upward",
      comment:
        "Foundation packages cannot depend on application, daemon, gateway, router, or tool implementation layers.",
      severity: "error",
      from: {
        path: "^packages/(contracts|runtime|registry|config-core)/"
      },
      to: {
        path: "^packages/(cli|daemon|gateway|router|accounts|tools|tool-)/"
      }
    },
    ...internalRootBarrelRules
  ],
  options: {
    doNotFollow: {
      path: ["node_modules", "dist", "docs/generated", "apps/docs"]
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json"
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"]
    },
    exclude: {
      path: [
        "node_modules",
        "dist",
        "docs/generated",
        "apps/docs",
        "\\.test\\.(ts|tsx|js)$",
        "/test/"
      ]
    }
  }
};
