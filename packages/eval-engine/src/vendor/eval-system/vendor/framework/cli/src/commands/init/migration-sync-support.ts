import { Effect, FileSystem, Option, Path } from "effect";

import { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import { FeatureRuntime } from "../../../../runloop/local/src/feature-runtime/service.ts";
import { writeProgressNotice } from "../dev/progress-notice.ts";
import {
  advanceWorkspaceBaseline,
  buildValidationMigrationReport,
  formatMigrationReportLines,
} from "../features/migration-report-support.ts";

const FEATURES_DIR = "features";

/**
 * Run the RFC 0002 migration report on an existing-target sync (`routekit-eval init .`),
 * then advance the workspace baseline.
 *
 * The RFC ("Migration report at update and validate") makes `routekit-eval init .` a
 * SHOULD producer of the report, with the same baseline contract as `routekit-eval update`
 * and `routekit-eval features validate`: after a report with **no blockers**, rewrite the
 * `routekit-eval.md` `version` to the running CLI version (advancing the baseline); when a
 * blocker is present, the baseline MUST NOT advance so the next run re-reports.
 *
 * Two differences from the `routekit-eval update` path:
 *   - the report runs on the **current** binary (no install just happened), so
 *     `buildValidationMigrationReport` uses the in-process `readVersionInfo` —
 *     no version override needed;
 *   - `routekit-eval init .` is interactive scaffolding, not a scriptable gate, so a
 *     blocker is surfaced as printed findings and a "baseline not advanced" note
 *     rather than a non-zero exit. The sync itself already succeeded.
 *
 * It is best-effort and never fails the sync: no workspace `features/` dir, or a
 * workspace that fails to resolve (`inspectDefinition` throws), is a no-op with a
 * note — neither is a reason to fail an otherwise-good `routekit-eval init .`.
 *
 * `workspaceRoot` is the synced project root (the dir holding `routekit-eval.md`).
 */
export const runInitSyncMigrationReport = Effect.fn(
  "ProjectInit.runMigrationReport"
)(function* (workspaceRoot: string) {
  const cliIo = yield* CliIo;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const featuresRoot = path.join(workspaceRoot, FEATURES_DIR);
  const hasFeatures = yield* fs
    .exists(featuresRoot)
    .pipe(Effect.orElseSucceed(() => false));
  if (!hasFeatures) {
    return;
  }

  const runtime = yield* FeatureRuntime;
  const definition = yield* runtime
    .inspectDefinition(featuresRoot)
    .pipe(Effect.option);
  if (Option.isNone(definition)) {
    yield* writeProgressNotice(
      "\nMigration report skipped: the workspace did not resolve. Run `routekit-eval features validate` to see why.\n"
    );
    return;
  }

  const report = yield* buildValidationMigrationReport(
    featuresRoot,
    definition.value
  );
  for (const line of formatMigrationReportLines(report, true)) {
    yield* cliIo.writeStderr(`${line}\n`);
  }

  if (report.hasBlocker) {
    yield* writeProgressNotice(
      "\nWorkspace baseline not advanced (migration blocker present). Fix the findings above, then re-run `routekit-eval init .` or `routekit-eval features validate`.\n"
    );
    return;
  }

  const advanced = yield* advanceWorkspaceBaseline(
    workspaceRoot,
    report.runningVersion
  );
  if (advanced) {
    yield* writeProgressNotice(
      `Workspace baseline advanced to ${report.runningVersion}.\n`
    );
  }
});
