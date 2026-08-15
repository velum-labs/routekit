// What a dry run says, in both output modes. Split out of `dry-run.ts` so that
// file stays about reading Node (the never-matching filter, the verdict decode,
// the child) and this one owns turning the result into human lines or the json
// envelope, without either outgrowing the max-lines cap.
import { Effect, Option } from "effect";

import type { CliIo } from "../../../../contracts/internal/src/cli/cli-io.ts";
import type { EvalDryRunSummary } from "./dry-run.ts";
import type { EvalTestRow } from "./junit.ts";

import {
  CliOutputAlreadyReported,
  renderEnvelope,
} from "../../../../contracts/internal/src/cli/cli-output.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import { EVAL_SUFFIX } from "./discover.ts";

const testLines = (tests: readonly EvalTestRow[]): readonly string[] =>
  tests.map((test) =>
    test.file === undefined
      ? `  would run  ${test.name}`
      : `  would run  ${test.file}  ${test.name}`
  );

/**
 * The human summary. Leads with the files, because "did it find my eval" is the
 * other half of what somebody running this is asking, then says plainly that
 * nothing was called so the reader does not have to infer it from an absent
 * cost line.
 */
const writeHumanDryRun = Effect.fn("EvalDryRun.writeHuman")(function* (input: {
  readonly cliIo: CliIo["Service"];
  readonly files: readonly string[];
  readonly testCount: number;
  readonly tests: readonly EvalTestRow[];
}) {
  for (const file of input.files) {
    yield* input.cliIo.writeStdout(`load  ${file}\n`);
  }
  for (const line of testLines(input.tests)) {
    yield* input.cliIo.writeStdout(`${line}\n`);
  }
  const files = `${input.files.length} ${input.files.length === 1 ? "file" : "files"}`;
  const tests = `${input.testCount} ${input.testCount === 1 ? "test" : "tests"}`;
  yield* input.cliIo.writeStdout(
    `${files} load, ${tests} would run. No model was called.\n`
  );
});

/**
 * A bare specifier that did not resolve, which usually means the workspace was
 * never installed rather than that the eval is wrong.
 *
 * Node separates the two for us: a package it cannot resolve is `Cannot find
 * package 'date-fns'`, while a relative path is `Cannot find module './helpers'`.
 * Only the first is worth mentioning `npm install` for.
 *
 * The full run installs the workspace on its way to booting the daemon
 * (`prepareDevFeaturesRoot({ install: true })`). A dry run deliberately does not:
 * a check whose whole promise is that it costs nothing should not reach the
 * network and write `node_modules` to answer whether a file parses. So it can
 * legitimately meet an uninstalled tree the real run never would, and the one
 * thing it owes that person is not to call their import broken.
 */
const UNINSTALLED_DEPENDENCY = /Cannot find package /mu;

/**
 * Worded to cover the three ways this fails, because they do not look alike.
 * Usually Node printed the parse or import error and the output above names the
 * file. Sometimes the tree was simply never installed. And in the rarer case the
 * run was rejected for a count Node reported rather than an error it printed, so
 * the output looks clean and a message promising it "says why" would send
 * somebody looking for a message that is not there.
 */
const dryRunFailure = (input: {
  readonly files: readonly string[];
  readonly output: string;
}): CliFailureError =>
  new CliFailureError({
    detail: `\`routekit-eval eval --dry-run\` could not confirm that ${input.files.length === 1 ? "the eval" : "every eval"} it discovered loaded.`,
    hint: UNINSTALLED_DEPENDENCY.test(input.output)
      ? "That package is not installed, so this is probably the workspace rather than the eval: run `npm install`, then `routekit-eval eval --dry-run` again. A full `routekit-eval eval` installs the workspace itself; a dry run does not, because it is meant to cost nothing."
      : "Fix the import or syntax error named in the `node --test` output above. If it names none, `node --test` did not read every discovered file.",
  });

/**
 * How many tests the run would have executed.
 *
 * Node gives this figure twice and they are not the same measurement: the spec
 * summary counts file-level results on a dry-run, the JUnit file lists every
 * case it knows about. They agree on everything ordinary, including `test.skip`
 * and nested `describe`. A dry-run writes one file-level `<testcase>` per
 * loaded file rather than the filtered-out `test()` names.
 *
 * So the JUnit rows win whenever there are any, and the count a reader sees is
 * the length of the list printed above it rather than a second opinion about it.
 *
 * This counts a `describe.skip`ped case even though a real run would not execute
 * it. JUnit renders that case and a filtered-out one identically as `<skipped/>`,
 * so there is nothing here to tell them apart with.
 */
const reportedTestCount = (input: {
  readonly summary: Option.Option<EvalDryRunSummary>;
  readonly tests: readonly EvalTestRow[];
}): number =>
  input.tests.length > 0
    ? input.tests.length
    : Option.match(input.summary, {
        onNone: () => 0,
        onSome: (summary) => summary.testCount,
      });

/**
 * Report the dry run.
 *
 * Split from {@link runEvalDryRun} so that function stays about the child and
 * this one owns both output modes. json mode gets one envelope carrying the same
 * `files` key every other `routekit-eval eval` envelope carries, plus what the dry run
 * learned.
 */
export const reportDryRun = Effect.fn("EvalDryRun.report")(function* (input: {
  readonly cliIo: CliIo["Service"];
  readonly files: readonly string[];
  readonly mode: "human" | "json";
  readonly output: string;
  readonly summary: Option.Option<EvalDryRunSummary>;
  readonly tests: readonly EvalTestRow[];
}) {
  const ok = Option.isSome(input.summary);
  const testCount = reportedTestCount({
    summary: input.summary,
    tests: input.tests,
  });
  if (input.mode === "json") {
    yield* input.cliIo.writeStdout(
      renderEnvelope(
        "eval",
        {
          dryRun: true,
          files: input.files,
          // The child's own words travel with the envelope, so an agent reading
          // piped stdout gets the import error rather than only being told there
          // was one. `null` on success rather than an omitted key, for the same
          // reason `comparison` is null there.
          problem: ok ? null : input.output,
          testCount,
          tests: input.tests,
        },
        ok
      )
    );
    return yield* ok
      ? Effect.void
      : new CliOutputAlreadyReported({
          cause:
            "`routekit-eval eval --dry-run` could not load every eval it discovered.",
        });
  }

  if (!ok) {
    return yield* dryRunFailure({
      files: input.files,
      output: input.output,
    });
  }
  yield* writeHumanDryRun({
    cliIo: input.cliIo,
    files: input.files,
    testCount,
    tests: input.tests,
  });
});

/**
 * The dry run that had nothing to do.
 *
 * Node is never spawned: `node --test` with no file arguments runs every test
 * under the directory, which is the opposite of what this command promises. json
 * mode still owes the same envelope shape, so an agent branching on `dryRun` or
 * reading `testCount` does not have to special-case an empty directory the way
 * it would if this fell through to the plain discovery reporter.
 */
export const reportEmptyDryRun = Effect.fn("EvalDryRun.reportEmpty")(
  function* (input: {
    readonly cliIo: CliIo["Service"];
    readonly mode: "human" | "json";
  }) {
    if (input.mode === "human") {
      return yield* input.cliIo.writeStdout(`No ${EVAL_SUFFIX} files found.\n`);
    }
    return yield* reportDryRun({
      cliIo: input.cliIo,
      files: [],
      mode: input.mode,
      output: "",
      summary: Option.some({
        fileCount: 0,
        testCount: 0,
      }),
      tests: [],
    });
  }
);
