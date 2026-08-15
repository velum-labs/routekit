# Standalone eval system

This directory is an independent source distribution of the real Ori eval
pipeline. The complete authored standalone distribution is copied directly into
this RouteKit package. The first integration phase intentionally preserves the
working standalone behavior before scope reduction. A minimal Effect-native
library seam now sits beside it for discovery, portable-import validation, and
comparison normalization.

The product contains:

- `login` and `auth` for OpenRouter credentials;
- headless code authoring through the production Pi, Claude, and Codex adapters;
- the copied code persona and exact `create-eval` skill;
- `eval`, `eval docs`, `eval skill`, and `eval scratch`;
- the generated `ori/eval` SDK and ephemeral daemon protocol;
- real candidate and judge provider calls;
- node:test semantics, JUnit parsing, crash-tolerant JSONL results, Markdown
  reports, run history, and baseline comparison;
- a durable outer `spawn` controller for the authoring interview;
- `version` / `-v`.

There are no fake providers, harnesses, test processes, or replacement result
paths. Slack, chat/TUI, schedules, and unrelated code skills are not part of
this focused product. `code` is headless only (`--prompt` / `--prompt-file`);
use `spawn` for the interview. Pi is the default author harness; Claude and
Codex are available when their native CLIs (or the bundled Codex executable)
are present.

## Product interface

The installed product requires Node 22.22 or newer. It does not require bun.
Eval files are node:test modules that `ori eval` runs through `node --test`.
Callers run `node dist/ori-eval-system.mjs` (or the `ori-eval-system` bin after
install). Child eval and Pi processes reuse the host Node executable. Claude
and Codex author turns use their native executables when those harnesses are
selected.

The package exports an Effect `EvalEngine` service. `discover` and `validate`
reuse the vendored recursive discovery and portable-import implementation.
`runComparison` validates RouteKit's shared comparison contract and consumes
the vendored JUnit/JSONL result shapes through an injected
`EvalExecutionPort`.

The execution port is intentionally explicit at this checkpoint. The copied
generated author SDK still talks to its private HTTP daemon with Promise APIs,
and that daemon creates a second `ManagedRuntime`. Supplying that unchanged
path as the library implementation would violate RouteKit's single-runtime
boundary. The next engine step is to adapt the generated SDK to an injected
invocation service and run the vendored candidate, assertion, and judge
behavior without the private daemon.

The standalone executable remains only as a baseline qualification artifact.
See `HOST.md` for its legacy process contract; new RouteKit integrations should
use the exported Effect service instead.

Source contributors use Node 22.22 or newer. When working inside the Ori
monorepo:

```bash
npm install --ignore-scripts --no-workspaces
```

A copied-out tree (no parent workspaces) can use:

```bash
npm install --ignore-scripts
```

## RouteKit workspace verification

```bash
pnpm --filter @velum-labs/routekit-eval-engine typecheck
pnpm --filter @velum-labs/routekit-eval-engine test
pnpm --filter @velum-labs/routekit-eval-engine build
```

The source-boundary integration test copies the authored product tree to a
temporary location, builds it using the RouteKit workspace dependencies, and
runs its help surface without reading the external source checkout. The built
standalone baseline is `dist/ori-eval-system.mjs`; it is a private qualification
artifact and is not exposed as a package binary.

## Direct eval use

```bash
node dist/ori-eval-system.mjs login
node dist/ori-eval-system.mjs eval scratch
node dist/ori-eval-system.mjs eval --path /path/to/test.eval.ts --report report.md
```

`eval --dry-run` and `eval --list` require no credential. Candidate and judge
runs require real OpenRouter access.

## Authoring workflow

```bash
node dist/ori-eval-system.mjs spawn skill
node dist/ori-eval-system.mjs spawn manifest
node dist/ori-eval-system.mjs --json spawn prepare --request-file request.txt --repo /path/to/repo
node dist/ori-eval-system.mjs --json spawn run --repo /path/to/repo
node dist/ori-eval-system.mjs --json spawn answer --answer-file answer.txt --repo /path/to/repo
node dist/ori-eval-system.mjs spawn status --repo /path/to/repo
```

The controller creates a private repository copy under a deterministic
`/tmp/spawn-ori-eval-<hash>` directory, persists interview state and attempts,
relays one question at a time, records structured scratch/eval artifacts, and
audits the original repository for mutation. Exit status 75 means it is waiting
for the user's answer.

See `FEATURE_COMPLETENESS.md` for what remains unqualified.
