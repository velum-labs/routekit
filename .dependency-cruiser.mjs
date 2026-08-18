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
  "eval-contracts",
  "eval-core",
  "eval-engine",
  "eval-service",
  "eval-setup",
  "eval-store",
  "gateway",
  "harness-core",
  "registry",
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

const testSourcePattern =
  "^packages/[^/]+/src/(?:test|__tests__)/|\\.(?:test|spec)\\.[cm]?[jt]sx?$";
const productionSource = {
  path: "^packages/[^/]+/src/",
  pathNot: testSourcePattern
};

const internalRootBarrelRules = packageNames.map((packageName) => ({
  name: `no-${packageName}-internal-root-barrel-imports`,
  comment: "Production modules must import their package internals directly, not through index.ts.",
  severity: "error",
  from: {
    path: `^packages/${packageName}/src/.+`,
    pathNot: `^packages/${packageName}/src/index\\.ts$|^packages/${packageName}/src/(?:test|__tests__)/|\\.(?:test|spec)\\.[cm]?[jt]sx?$`
  },
  to: {
    path: `^packages/${packageName}/src/index\\.ts$`
  }
}));

const packageLayerRules = [
  {
    name: "gateway-layer-does-not-import-applications",
    from: { path: "^packages/gateway/", pathNot: testSourcePattern },
    to: { path: "^packages/(accounts|daemon|cli|tools|tool-[^/]+)/" }
  },
  {
    name: "accounts-layer-does-not-import-routing-applications",
    from: { path: "^packages/accounts/", pathNot: testSourcePattern },
    to: { path: "^packages/(gateway|daemon|cli|tools|tool-[^/]+)/" }
  },
  {
    name: "daemon-layer-does-not-import-cli",
    from: { path: "^packages/daemon/", pathNot: testSourcePattern },
    to: { path: "^packages/(cli|cli-core|cli-ui|tools|tool-[^/]+)/" }
  }
].map((rule) => ({
  ...rule,
  comment: "Package layers may depend only downward toward their owned ports.",
  severity: "error"
}));

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular",
      comment: "Production package code must remain acyclic.",
      severity: "error",
      from: productionSource,
      to: { circular: true }
    },
    {
      name: "no-unresolved",
      comment: "Every production import must resolve.",
      severity: "error",
      from: productionSource,
      to: { couldNotResolve: true }
    },
    {
      name: "no-undeclared-dependencies",
      comment: "External production imports must be declared by their owning package.",
      severity: "error",
      from: productionSource,
      to: {
        dependencyTypes: ["npm-no-pkg", "npm-unknown"]
      }
    },
    {
      name: "no-cross-package-src-imports",
      comment:
        "Workspace packages must import each other through @velum-labs/routekit* package entry points, not relative paths into another package's src tree.",
      severity: "error",
      from: {
        path: "^packages/([^/]+)/src/",
        pathNot: testSourcePattern
      },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: "^packages/$1/",
        dependencyTypesNot: ["aliased-tsconfig-paths", "aliased-workspace"]
      }
    },
    {
      name: "no-runtime-root-facade-imports",
      comment:
        "Production modules import a named Runtime subpath rather than the published root façade.",
      severity: "error",
      from: {
        path: productionSource.path,
        pathNot: [productionSource.pathNot, "^packages/eval-engine/"]
      },
      to: {
        path: "^packages/runtime/src/index\\.ts$"
      }
    },
    {
      name: "production-does-not-import-test-code",
      comment: "Production modules must not depend on test fixtures or test-only helpers.",
      severity: "error",
      from: {
        path: "^packages/[^/]+/src/",
        pathNot: "/(?:test|__tests__)/|\\.(?:test|spec)\\.[cm]?[jt]sx?$"
      },
      to: {
        path: "/(?:test|__tests__)/|\\.(?:test|spec)\\.[cm]?[jt]sx?$"
      }
    },
    {
      name: "tests-do-not-import-other-package-test-internals",
      comment:
        "Cross-package tests consume published package surfaces, not another package's private fixtures.",
      severity: "error",
      from: {
        path: "^packages/([^/]+)/src/(?:test|__tests__)/|^packages/([^/]+)/src/.+\\.(?:test|spec)\\.[cm]?[jt]sx?$"
      },
      to: {
        path: "^packages/[^/]+/src/(?:test|__tests__)/|^packages/[^/]+/src/.+\\.(?:test|spec)\\.[cm]?[jt]sx?$",
        pathNot: "^packages/$1/"
      }
    },
    {
      name: "tools-only-via-registry",
      comment:
        "Individual tool-* integration packages may only be imported by tool-registry, tools, and themselves.",
      severity: "error",
      from: {
        path: "^packages/[^/]+/src/",
        pathNot: [
          testSourcePattern,
          "^packages/(tool-registry|tool-codex|tool-claude|tool-cursor|tool-opencode|tools)/"
        ]
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
        path: "^packages/[^/]+/src/",
        pathNot: [
          testSourcePattern,
          "^packages/(tool-registry|tool-codex|tool-claude|tool-cursor|tool-opencode|tools)/"
        ]
      },
      to: {
        path: "node_modules/@velum-labs/routekit-tool-(codex|claude|cursor|opencode)(/|$)"
      }
    },
    {
      name: "foundation-does-not-import-upward",
      comment:
        "Foundation packages cannot depend on application, daemon, gateway, or tool implementation layers.",
      severity: "error",
      from: {
        path: "^packages/(contracts|runtime|registry|config-core|eval-contracts|eval-engine)/",
        pathNot: testSourcePattern
      },
      to: {
        path: "^packages/(cli|daemon|gateway|accounts|tools|tool-[^/]+|eval-core|eval-store)/"
      }
    },
    {
      name: "eval-does-not-import-online-request-path",
      comment:
        "Evaluation packages must not import the gateway, daemon, or CLI online path.",
      severity: "error",
      from: {
        path: "^packages/eval-(contracts|core|engine|service|setup|store)/",
        pathNot: testSourcePattern
      },
      to: {
        path: "^packages/(cli|daemon|gateway|accounts)/"
      }
    },
    {
      name: "online-request-path-does-not-import-eval-engine",
      comment:
        "Gateway, daemon, accounts, and CLI production paths cannot consume the offline eval engine; eval-service owns that composition.",
      severity: "error",
      from: {
        path: "^packages/(gateway|daemon|accounts|cli)/",
        pathNot: testSourcePattern
      },
      to: {
        path: "^packages/eval-engine/"
      }
    },
    {
      name: "eval-engine-only-via-eval-service",
      comment:
        "Production packages consume the offline engine only through the eval-service composition layer.",
      severity: "error",
      from: {
        path: "^packages/[^/]+/",
        pathNot: [testSourcePattern, "^packages/(eval-engine|eval-service)/"]
      },
      to: {
        path: "^packages/eval-engine/"
      }
    },
    {
      name: "eval-service-only-via-cli",
      comment:
        "The RouteKit CLI and private testkit are composition roots for offline eval workflows.",
      severity: "error",
      from: {
        path: "^packages/[^/]+/",
        pathNot: [testSourcePattern, "^packages/(cli|eval-service|testkit)/"]
      },
      to: {
        path: "^packages/eval-service/"
      }
    },
    {
      name: "config-does-not-import-gateway",
      comment: "Configuration ownership is below gateway implementation layers.",
      severity: "error",
      from: {
        path: "^packages/(config|config-core)/",
        pathNot: testSourcePattern
      },
      to: {
        path: "^packages/gateway/"
      }
    },
    ...packageLayerRules,
    ...internalRootBarrelRules
  ],
  options: {
    doNotFollow: {
      path: [
        "node_modules",
        "dist",
        "docs/generated",
        "apps/docs",
        "packages/eval-engine/src/vendor",
        "packages/eval-engine/test/standalone"
      ]
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.depcruise.json"
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
        "packages/eval-engine/src/vendor",
        "packages/eval-engine/test/standalone"
      ]
    }
  }
};
