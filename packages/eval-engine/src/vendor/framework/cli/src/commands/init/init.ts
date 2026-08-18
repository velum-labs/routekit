import { Effect, FileSystem, Path } from "effect";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { writeProgressNotice } from "../dev/progress-notice.ts";
import { writeAgentInstructions } from "./agent-instructions.ts";
import {
  ensureAuthorContractsCurrent,
  ProjectInitError,
} from "./author-contracts.ts";
import { writeDeployScaffold } from "./deploy-scaffold.ts";
import { writeDocsCache } from "./docs-cache.ts";
import {
  createInitialCommit,
  runGitInit,
} from "./init-git.ts";
import { linkDeclaredRemoteFeatures } from "./linked-remote-features.ts";
import { runInitSyncMigrationReport } from "./migration-sync-support.ts";
import {
  normalizeProjectName,
  resolveProjectName,
} from "./project-name.ts";
import {
  ensureGitignoreEntries,
  materializeTemplate,
} from "./template-source.ts";
import { ensureOpenRouterCredential } from "../login/login.ts";

import { runBufferedCommand, writeCommandOutput } from "./command-output.ts";
import { runInstallStep } from "./init-install-step.ts";
import { describeInitResult } from "./init-result.ts";

const COMMAND_SUCCESS_EXIT_CODE = 0;

const NAME_DERIVATION_EXIT_CODE = 1;

const TARGET_EXISTS_EXIT_CODE = 1;

interface InitProjectOptions {
  readonly cwd: string;
  /**
   * Turn a failed `npm install` into a fatal `ProjectInitError`. Set by the
   * global-workspace auto-scaffold, which boots the workspace it just created
   * in the same invocation. Unset for interactive `ori init <name>`, which
   * just warns and lets the user retry.
   */
  readonly failOnInstallError?: boolean;
  /**
   * Targets the global workspace at `~/.ori/global`. Only changes the
   * post-scaffold "next steps" message (the target path is encoded in
   * `cwd`/`name`); `ori dev`/`ori start` find it from any directory.
   */
  readonly global?: boolean;
  /** Run `npm install` after scaffolding. Disabled via `--no-install`. */
  readonly install: boolean;
  /** Explicit workspace name; when omitted the name is prompted or generated. */
  readonly name: string | undefined;
  /**
   * Skip the OpenRouter credential gate. Set during `ori dev`/`ori start`
   * auto-scaffold: the command runs its own authoritative credential check
   * right after, so prompting here would mean two login prompts on a fresh machine.
   */
  readonly skipCredentialGate?: boolean;
  /**
   * Skip the post-scaffold "next steps" banner. Set when `ori dev`/`ori start`
   * auto-scaffold the global workspace mid-flow, where a "Start it with: ori dev"
   * message would be confusing (the user is already running it).
   */
  readonly suppressNextSteps?: boolean;
  /** Persona template to scaffold; `default` is the baseline workspace. */
  readonly template: string;
  /**
   * Also scaffold `deploy/Dockerfile` and `deploy/compose.yaml` for a headless
   * container deploy (`--with-docker`). Off by default: a new workspace carries
   * no deployment opinion unless it is asked for.
   */
  readonly withDocker?: boolean;
  /**
   * Also scaffold `deploy/ori.service` for a headless systemd deploy
   * (`--with-systemd`). Off by default.
   */
  readonly withSystemd?: boolean;
}

const SYNC_TARGET_NOT_WORKSPACE_EXIT_CODE = 1;

const scaffoldWorkspace = Effect.fn("ProjectInit.scaffoldWorkspace")(
  function* (input: {
    readonly cliIo: CliIo["Service"];
    readonly projectRoot: string;
    readonly template: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectName = normalizeProjectName(path.basename(input.projectRoot));
    if (projectName === "") {
      return yield* new ProjectInitError({
        detail: `Could not derive a usable project name from "${input.projectRoot}".`,
        exitCode: NAME_DERIVATION_EXIT_CODE,
        operation: "resolving the project name",
      });
    }

    const exists = yield* fs
      .exists(input.projectRoot)
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return yield* new ProjectInitError({
        detail: `Target directory already exists: ${input.projectRoot}`,
        exitCode: TARGET_EXISTS_EXIT_CODE,
        operation: "creating project directory",
      });
    }

    return yield* Effect.gen(function* () {
      yield* materializeTemplate({
        targetDir: input.projectRoot,
        template: input.template,
        workspaceName: projectName,
      });
      // Best-effort: mirror the embedded docs into `.ori/docs/` so the intern has
      // version-matched docs locally (the built-in feature-development skill points
      // there). A docs-cache failure must not roll back an otherwise good scaffold.
      yield* writeDocsCache(input.projectRoot).pipe(Effect.ignore);
      // Best-effort: drop AGENTS.md so an external coding agent opening the project
      // inherits the same authoring rules the runtime injects for itself. Created
      // only when absent, so a template shipping its own guide wins.
      yield* writeAgentInstructions(input.projectRoot).pipe(Effect.ignore);
      return yield* runGitInit({
        cliIo: input.cliIo,
        cwd: input.projectRoot,
      });
    }).pipe(
      Effect.tapError(() =>
        fs.remove(input.projectRoot, { recursive: true }).pipe(Effect.ignore)
      )
    );
  }
);

/**
 * No `commandName` is passed: init scaffolds a workspace and hands back, so it
 * has nothing truthful to name as the next command and the diagnostic names the
 * condition instead. The gate stays soft — a missing credential is a normal
 * outcome of a headless `ori init`, not a failure.
 */
const runCredentialGate = Effect.fn("ProjectInit.credentialGate")(
  function* (input: {
    readonly cliIo: CliIo["Service"];
    readonly startDir: string;
  }) {
    yield* ensureOpenRouterCredential({
      startDir: input.startDir,
    }).pipe(
      Effect.catch(() =>
        input.cliIo.writeStderr(
          "\nSign-in didn't finish. Run `ori login` before anything that calls a model.\n"
        )
      ),
      Effect.ignore
    );
  }
);

const runVerifyStep = Effect.fn("ProjectInit.verifyStep")(function* (input: {
  readonly cliIo: CliIo["Service"];
  readonly name: string;
  readonly projectRoot: string;
}) {
  const result = yield* runBufferedCommand(input.projectRoot, "npm", [
    "run",
    "typecheck",
  ]);
  if (result.exitCode === COMMAND_SUCCESS_EXIT_CODE) {
    return;
  }

  yield* input.cliIo.writeStderr(
    `\nTypecheck failed (exit code ${result.exitCode}). Run \`cd ${input.name} && npm run typecheck\` to see details.\n`
  );
  yield* writeCommandOutput(input.cliIo, result.output);
});

const formatNextSteps = (
  name: string,
  options: { readonly global: boolean }
): string =>
  options.global
    ? `\nYour global intern is ready. Start it from any directory with:\n\n  ori dev\n\nAdd a new capability any time with:\n\n  ori features new <name> --features ~/.ori/global/features\n`
    : `\nYour intern "${name}" is ready. Start it with:\n\n  cd ${name}\n  ori dev\n\nAdd a new capability any time with:\n\n  ori features new <name>\n`;

/**
 * Post-scaffold sequence for a freshly created workspace: install dependencies,
 * record the initial commit, run the credential gate, verify the typecheck, and
 * print the next-steps banner. Ordering is load-bearing (install before
 * verify; commit before the gate) and unchanged from the inline flow.
 */
const finalizeScaffoldedWorkspace = Effect.fn(
  "ProjectInit.finalizeScaffoldedWorkspace"
)(function* (input: {
  readonly cliIo: CliIo["Service"];
  readonly gitInitialized: boolean;
  readonly name: string;
  readonly options: InitProjectOptions;
  readonly projectRoot: string;
}) {
  const { cliIo, gitInitialized, name, options, projectRoot } = input;
  // Write deploy/ before the initial commit so the scaffolding is captured in it.
  yield* writeDeployScaffold({
    projectRoot,
    withDocker: options.withDocker ?? false,
    withSystemd: options.withSystemd ?? false,
  });
  const fs = yield* FileSystem.FileSystem;
  // Only a fatal `failOnInstallError` removes the scaffolded directory, or a
  // retry would find the existing `features/` "already scaffolded" and boot
  // the same broken, dependency-less workspace this error exists to prevent.
  // Scoped to just this step so an unrelated finalize failure still leaves
  // the scaffold in place for the user to recover, as it always has.
  const installed = yield* runInstallStep({
    cliIo,
    failOnInstallError: options.failOnInstallError ?? false,
    install: options.install,
    name,
    projectRoot,
  }).pipe(
    Effect.tapError(() =>
      fs.remove(projectRoot, { recursive: true }).pipe(Effect.ignore)
    )
  );
  if (gitInitialized) {
    yield* createInitialCommit(projectRoot);
  }
  if (!options.skipCredentialGate) {
    yield* runCredentialGate({
      cliIo,
      startDir: projectRoot,
    });
  }
  if (installed) {
    yield* runVerifyStep({
      cliIo,
      name,
      projectRoot,
    });
  }

  if (!options.suppressNextSteps) {
    yield* writeProgressNotice(
      formatNextSteps(name, { global: options.global ?? false })
    );
  }
  return installed;
});

/**
 * Existing-target path for `ori init`: refresh the `.ori/sdk` author-contracts
 * cache in place when the target is an Ori workspace, then ensure `.gitignore`
 * ignores the generated `.ori/` cache — so a `postinstall: ori init .` never
 * leaves the materialized cache commit-able. Both writes are idempotent. When
 * the directory exists but is not an Ori workspace, fail loudly so
 * `ori init <existing-non-workspace>` keeps its old "won't overwrite" behavior.
 *
 * When `install` is set (the default), run `npm install` after refreshing the
 * SDK cache: the workspace consumes `.ori/sdk` through `node_modules/ori`,
 * which an install must copy across before a content change is visible.
 */
const syncExistingWorkspace = Effect.fn("ProjectInit.syncExistingWorkspace")(
  function* (input: {
    readonly cliIo: CliIo["Service"];
    readonly install: boolean;
    readonly name: string;
    readonly projectRoot: string;
    readonly withDocker: boolean;
    readonly withSystemd: boolean;
  }) {
    const synced = yield* ensureAuthorContractsCurrent(input.projectRoot);
    if (!synced) {
      return yield* new ProjectInitError({
        detail: `Target directory already exists: ${input.projectRoot}`,
        exitCode: SYNC_TARGET_NOT_WORKSPACE_EXIT_CODE,
        operation: "creating project directory",
      });
    }

    yield* ensureGitignoreEntries(input.projectRoot);
    // Refresh the mirrored docs alongside the SDK cache so a `postinstall` re-sync
    // keeps `.ori/docs/` current. Best-effort and idempotent.
    yield* writeDocsCache(input.projectRoot).pipe(Effect.ignore);

    yield* writeProgressNotice(
      `\nMaterialized the Ori SDK cache (.ori/sdk) in ${input.projectRoot}.\n`
    );

    // Refresh (or add) requested deploy/ artifacts on a sync too, so
    // `ori init . --with-docker` materializes them into an existing workspace.
    yield* writeDeployScaffold({
      projectRoot: input.projectRoot,
      withDocker: input.withDocker,
      withSystemd: input.withSystemd,
    });

    // Must run before the install below: `npm install` resolving a `workspace:*`
    // dependency on a remote feature is what makes it visible to tsc and tests.
    yield* linkDeclaredRemoteFeatures(input.projectRoot);

    // Install so the refreshed `.ori/sdk` lands in `node_modules/ori`. npm copies a
    // `file:` dependency into `node_modules` rather than always leaving a stale
    // snapshot, so a content change to the cache is invisible to the running
    // workspace until an install copies it across. Honors `--no-install` exactly
    // like the create path.
    //
    // Safe under a `"postinstall": "ori init ."` hook: the enclosing
    // `npm install` already finished copying node_modules before postinstall
    // runs, so this install is what actually updates node_modules. npm does not
    // re-enter lifecycle scripts for a nested install of the same tree.
    const installed = yield* runInstallStep({
      cliIo: input.cliIo,
      install: input.install,
      name: input.name,
      projectRoot: input.projectRoot,
    });

    // RFC 0002 migration report (existing-target sync): correlate the workspace's
    // recorded `ori.md` version against the running CLI, print what stopped
    // loading, and advance the baseline on a clean report. Best-effort — never
    // fails an otherwise-good sync, so a version-info read or baseline-write
    // failure (its `CliFailureError`/`PlatformError` channel) is swallowed here,
    // mirroring the other best-effort steps above (`writeDocsCache`, gitignore).
    yield* runInitSyncMigrationReport(input.projectRoot).pipe(Effect.ignore);
    return installed;
  }
);

export const initProject = Effect.fn("ProjectInit.initProject")(function* (
  options: InitProjectOptions
) {
  const cliIo = yield* CliIo;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const isTty = yield* cliIo.isStdinTty;
  const name = yield* resolveProjectName({
    isTty,
    name: options.name,
  });
  // `name` may be a path target (absolute, or relative like `../playground`), so
  // resolve against cwd: an absolute name is honored verbatim and a bare name is
  // placed under cwd. `path.join` would instead splice an absolute name onto cwd.
  const projectRoot = path.resolve(options.cwd, name);

  // When the target already exists, fall back to sync mode for an existing Ori
  // workspace: materialize the `.ori/sdk` author-contracts cache so typecheck
  // can resolve the bare `ori` specifier. This is what makes `ori init .` work,
  // and lets a generated project wire `"postinstall": "ori init ."`. A target
  // that exists but is *not* an Ori workspace still fails loudly.
  const targetExists = yield* fs
    .exists(projectRoot)
    .pipe(Effect.orElseSucceed(() => false));
  if (targetExists) {
    const installed = yield* syncExistingWorkspace({
      cliIo,
      install: options.install,
      name,
      projectRoot,
      withDocker: options.withDocker ?? false,
      withSystemd: options.withSystemd ?? false,
    });
    return yield* describeInitResult({
      global: options.global ?? false,
      installed,
      name,
      outcome: "synced",
      projectRoot,
    });
  }

  const gitInitialized = yield* scaffoldWorkspace({
    cliIo,
    projectRoot,
    template: options.template,
  });

  const installed = yield* finalizeScaffoldedWorkspace({
    cliIo,
    gitInitialized,
    name,
    options,
    projectRoot,
  });
  return yield* describeInitResult({
    global: options.global ?? false,
    installed,
    name,
    outcome: "created",
    projectRoot,
  });
});

export type { InitProjectOptions };
