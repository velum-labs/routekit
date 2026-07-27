/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
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
    }
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
