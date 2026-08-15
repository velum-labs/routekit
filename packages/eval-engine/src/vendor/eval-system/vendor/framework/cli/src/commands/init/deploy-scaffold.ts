import { Crypto, Effect, FileSystem, Path, Schema } from "effect";

import { formatHint } from "../../../../contracts/internal/src/cli/cli-messages.ts";
import { writeProgressNotice } from "../dev/progress-notice.ts";
import { readVersionInfo } from "../version/version-info.ts";

import deployBundleJson from "./deploy-artifacts/deploy-bundle.json.txt";
import { hashDeployContent, stampDeployContent } from "./deploy-stamp.ts";

const DEPLOY_DIR = "deploy";

// The deploy bundle is generated from the repo's canonical deploy/ files and
// compiled into the CLI as a text artifact,
// so it is decoded through a schema rather than trusted as a raw cast.
const DeployBundleSchema = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.String),
});
const decodeDeployBundleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DeployBundleSchema)
);

/** Which headless-deploy artifacts `routekit-eval init` materializes. */
type DeployTarget = "docker" | "systemd";

// Files each target owns, so `--with-docker` writes the container pair and
// `--with-systemd` writes only the unit. The union of every target's files
// MUST stay a subset of what the generator bundles (guarded at write time).
const TARGET_FILES = {
  docker: ["Dockerfile", "compose.yaml"],
  systemd: ["routekit-eval.service"],
} as const satisfies Record<DeployTarget, readonly string[]>;

// RFC 0004: the base unit is operator-owned once scaffolded — `routekit-eval update
// --sync-systemd` never rewrites it — so it must not carry the managed stamp.
const OPERATOR_OWNED_FILES = new Set<string>(["routekit-eval.service"]);

type DeployArtifactStatus = "written" | "kept";

interface DeployArtifactOutcome {
  readonly file: string;
  readonly status: DeployArtifactStatus;
}

interface DeployScaffoldResult {
  readonly deployDir: string;
  readonly outcomes: readonly DeployArtifactOutcome[];
}

interface ScaffoldDeployArtifactsInput {
  readonly workspaceRoot: string;
  readonly targets: readonly DeployTarget[];
  readonly force: boolean;
}

/**
 * Materialize the embedded headless-deploy scaffolding into
 * `<workspaceRoot>/deploy/` for the requested targets. `docker` writes the
 * `Dockerfile` and `compose.yaml`; `systemd` writes the `routekit-eval.service` unit. The
 * contents come from the CLI's compiled-in copy, so this needs no network or
 * repo checkout and always matches the running CLI version. Existing files are
 * kept untouched unless `force` is set, so an operator's local edits survive a
 * re-run (for example a `routekit-eval init .` refresh).
 */
export const scaffoldDeployArtifacts = Effect.fn("Deploy.scaffold")(function* (
  input: ScaffoldDeployArtifactsInput
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const version = yield* readVersionInfo;
  const bundle = yield* decodeDeployBundleJson(deployBundleJson);
  const deployDir = path.join(input.workspaceRoot, DEPLOY_DIR);

  const wanted = new Set<string>(
    input.targets.flatMap((target) => TARGET_FILES[target])
  );

  yield* fs.makeDirectory(deployDir, { recursive: true });

  const outcomes: DeployArtifactOutcome[] = [];
  // Iterate the bundle so writes follow its deterministic order regardless of
  // target order, and only touch files the caller asked for.
  for (const [name, content] of Object.entries(bundle.files)) {
    if (!wanted.has(name)) {
      continue;
    }
    const target = path.join(deployDir, name);
    const relative = path.join(DEPLOY_DIR, name);
    const exists = yield* fs.exists(target);
    if (exists && !input.force) {
      outcomes.push({
        file: relative,
        status: "kept",
      });
      continue;
    }
    if (OPERATOR_OWNED_FILES.has(name)) {
      yield* fs.writeFileString(target, content);
    } else {
      const hash = yield* hashDeployContent(crypto, content);
      yield* fs.writeFileString(
        target,
        stampDeployContent(version.version, hash, content)
      );
    }
    outcomes.push({
      file: relative,
      status: "written",
    });
  }

  // Every requested file must exist in the embedded bundle; a mismatch means
  // the compiled-in copy drifted from TARGET_FILES, so fail loudly rather than
  // scaffolding a partial deploy/.
  if (outcomes.length !== wanted.size) {
    return yield* Effect.die(
      new Error(
        "The embedded deploy bundle is missing files the requested targets need."
      )
    );
  }

  return {
    deployDir,
    outcomes,
  } satisfies DeployScaffoldResult;
});

const COMPOSE_HINT =
  "Build and run it locally with:\n  ROUTEKIT_EVAL_BEARER_TOKEN=sk-or-... docker compose -f deploy/compose.yaml up --build";
const SYSTEMD_HINT =
  'Install the unit on a host: see the systemd section of the "Run an intern headless" guide.';

/**
 * Render the per-file written/kept summary plus a next-step hint tailored to the
 * artifacts that were scaffolded (the Compose one-liner for a container deploy,
 * the systemd install pointer for the unit).
 */
export const formatDeployScaffoldSummary = (
  result: DeployScaffoldResult
): string => {
  const lines = [`Deploy scaffolding at ${result.deployDir}:`];
  for (const outcome of result.outcomes) {
    const verb = outcome.status === "written" ? "wrote" : "kept ";
    lines.push(`  ${verb} ${outcome.file}`);
  }

  const keptCount = result.outcomes.filter(
    (outcome) => outcome.status === "kept"
  ).length;
  if (keptCount > 0) {
    lines.push(
      "",
      formatHint(
        `${keptCount} file(s) already existed and were left unchanged. Delete them and re-run to refresh after a CLI upgrade.`
      )
    );
  }

  const wroteCompose = result.outcomes.some((outcome) =>
    outcome.file.endsWith("compose.yaml")
  );
  const wroteUnit = result.outcomes.some((outcome) =>
    outcome.file.endsWith("routekit-eval.service")
  );
  if (wroteCompose) {
    lines.push("", formatHint(COMPOSE_HINT));
  }
  if (wroteUnit) {
    lines.push("", formatHint(SYSTEMD_HINT));
  }

  return `${lines.join("\n")}\n`;
};

/**
 * Materialize the requested headless-deploy artifacts into `<projectRoot>/deploy/`
 * when `--with-docker`/`--with-systemd` are set, then print the per-file summary.
 * A no-op when neither flag is set, so the default `routekit-eval init` scaffold stays
 * deploy-free. Used by both the create and existing-target sync paths.
 */
export const writeDeployScaffold = Effect.fn("Deploy.writeScaffold")(
  function* (input: {
    readonly projectRoot: string;
    readonly withDocker: boolean;
    readonly withSystemd: boolean;
  }) {
    const targets: DeployTarget[] = [];
    if (input.withDocker) {
      targets.push("docker");
    }
    if (input.withSystemd) {
      targets.push("systemd");
    }
    if (targets.length === 0) {
      return;
    }

    const result = yield* scaffoldDeployArtifacts({
      force: false,
      targets,
      workspaceRoot: input.projectRoot,
    });
    yield* writeProgressNotice(formatDeployScaffoldSummary(result));
  }
);

export { DEPLOY_DIR, TARGET_FILES };
export type {
  DeployArtifactOutcome,
  DeployArtifactStatus,
  DeployScaffoldResult,
  DeployTarget,
};
