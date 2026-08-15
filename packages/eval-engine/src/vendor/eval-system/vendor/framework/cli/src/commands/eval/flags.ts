// The `routekit-eval eval` flag surface. Split out of `command.ts` so that file stays about
// behaviour (the daemon provider, the child spawn, the results channel) rather
// than growing a second job as the CLI option catalogue.
import { Option } from "effect";
import { Argument, Flag } from "effect/unstable/cli";

import type { EvalBaselineSelector } from "./baseline-selector.ts";

import { DEFAULT_DAEMON_HOST } from "../dev/session-support.ts";
import {
  DEFAULT_EVAL_BASELINE,
  parseEvalBaselineSelector,
} from "./baseline-selector.ts";
import { EVAL_SUFFIX } from "./discover.ts";

// Real model calls are slow, so the per-test default is far above Node's own.
const DEFAULT_EVAL_TIMEOUT_MS = 120_000;

export const pathFlag = Flag.string("path").pipe(
  Flag.withDescription(
    `Directory or file to search for ${EVAL_SUFFIX} files (default: the current directory)`
  ),
  Flag.optional
);

// `routekit-eval eval <file>` is what people reach for first, because it reads like
// `node --test`. Accepted positionally as well as through `--path`; without this the
// argument was ignored and the command ran every eval under the current
// directory instead, spending a real model call on each.
export const targetArgument = Argument.string("target").pipe(
  Argument.withDescription(
    `Directory or ${EVAL_SUFFIX} file to run (same as --path). Omit to run every ${EVAL_SUFFIX} file under the current directory.`
  ),
  Argument.optional
);

export const featuresFlag = Flag.string("features").pipe(
  Flag.withDescription(
    "Directory the eval's agent loads features from (default: the target's features/ when that directory exists). Otherwise existing workspace and global resolution applies"
  ),
  Flag.optional
);

export const hostFlag = Flag.string("host").pipe(
  Flag.withDescription(
    `Host to bind the temporary runtime to (default: ${DEFAULT_DAEMON_HOST}). A plain run does not need this: routekit-eval eval starts and tears down that runtime itself`
  ),
  Flag.withDefault(DEFAULT_DAEMON_HOST)
);

export const listFlag = Flag.boolean("list").pipe(
  Flag.withDescription("List the discovered eval files without running them")
);

// `--list` looks like the cheap check and is not: it returns at discovery, before
// the import guard runs, so it proves a file was found and nothing more. This
// flag is the one that answers "does my eval actually load".
export const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription(
    "Load every discovered eval and run no test, so a parse error or an unresolved import fails here instead of after a model call. Needs no credential. Does not check that an eval passes: nothing in a test body runs, though top-level code in the file still does"
  )
);

export const evalTimeoutFlag = Flag.integer("timeout").pipe(
  Flag.filterMap(
    (timeout) => (timeout >= 1 ? Option.some(timeout) : Option.none()),
    (timeout) => `an integer of at least 1 ms (received ${timeout})`
  ),
  Flag.withDescription(
    "Per-test timeout in milliseconds (must be at least 1 ms; default: 120000; an eval file's per-test { timeout } option takes precedence)"
  ),
  Flag.withDefault(DEFAULT_EVAL_TIMEOUT_MS)
);

// History is on by default. A record you have to opt into only starts on the run
// after the one you wish you had recorded, which defeats the point of watching a
// number move. The file is git-ignored and bounded, and this flag skips the write
// for a run you would rather not see in the series.
export const noHistoryFlag = Flag.boolean("no-history").pipe(
  Flag.withDescription(
    "Do not append this run's summary to .routekit/eval/history.jsonl"
  )
);

// Which earlier run this one is held against. Defaults to the previous run, which
// is the question someone iterating on a prompt is already asking. `model:<slug>`
// is the other direction: pin the model you trust and compare everything to its
// last run. Comparison is reporting only — the exit code still says nothing but
// whether `node --test` passed.
export const baselineFlag = Flag.string("baseline").pipe(
  Flag.filterMap(
    (raw) => parseEvalBaselineSelector(raw),
    (raw) => `"last", "best", or "model:<slug>" (received ${raw})`
  ),
  Flag.withDescription(
    'Run to compare this one against: "last" (default), "best", or "model:<slug>". Needs an RouteKitEval workspace, because the run history it reads is only kept inside one'
  ),
  Flag.withDefault(DEFAULT_EVAL_BASELINE)
);

// The shareable artefact, opt-in and written exactly where the user names it.
// No default path on purpose: the history is a record the workspace keeps for
// itself, but this is a document somebody wrote to hand to another person, and a
// file they chose the name of is one they can find again. It also keeps `routekit-eval eval`
// writing nothing new into a project unless it was asked to.
export const reportFlag = Flag.string("report").pipe(
  Flag.withDescription(
    "Write a shareable markdown report of this run to the given path (relative paths resolve against the eval directory)"
  ),
  Flag.optional
);

// `routekit-eval eval` is meant to run in CI, where a real model call is expected. The
// default is to require a credential; `--allow-no-key` lets a discovery-only
// run (`--list`) proceed on a machine with no key configured.
export const allowNoKeyFlag = Flag.boolean("allow-no-key").pipe(
  Flag.withDescription(
    "Do not fail when no credential is available from ROUTEKIT_EVAL_BEARER_TOKEN or routekit-eval login (useful with --list; --dry-run already needs no credential)"
  )
);

// Re-exported from where the flag lives: the selector type is what this flag
// parses to, so a consumer of the flag needs it without also reaching into the
// comparison module.
export type { EvalBaselineSelector };
