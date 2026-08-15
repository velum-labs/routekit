# Standalone eval system

This directory is an independent source distribution of the real RouteKit Eval eval
pipeline. The required production closure is copied into `src/vendor`, its
imports are rewritten to local paths, and `PROVENANCE.json` records the original
path, source hash, extracted hash, and source commit for every copied file.
There are no RouteKit Eval workspace dependencies and the directory builds after being
copied out of this repository.

The product contains:

- `login` and `auth` for Gateway credentials;
- headless code authoring through the production Pi, Claude, and Codex adapters;
- the copied code persona and exact `create-eval` skill;
- `eval`, `eval docs`, `eval skill`, and `eval scratch`;
- the generated `routekit/eval` SDK and ephemeral daemon protocol;
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
Eval files are node:test modules that `routekit-eval eval` runs through `node --test`.
Callers run `node dist/routekit-eval-engine.mjs` (or the `routekit-eval-engine` bin after
install). Child eval and Pi processes reuse the host Node executable. Claude
and Codex author turns use their native executables when those harnesses are
selected.

A later host (RouteKit, a model router) spawns this binary and drives JSON.
See `HOST.md` for the process env, spawn envelopes, exit codes, and injectable
API origin. Do not import `src/` as a library.

Source contributors use Node 22.22 or newer. When working inside the RouteKit Eval
monorepo:

```bash
npm install --ignore-scripts --no-workspaces
```

A copied-out tree (no parent workspaces) can use:

```bash
npm install --ignore-scripts
```

## Independent-source verification

```bash
npm run typecheck
npm run verify-boundary
npm test
npm run build
```

`verify-boundary` fails when:

- `package.json` contains an RouteKit Eval, `workspace:*`, or `file:` dependency;
- a source import uses an `@routekit-eval-*` or package `#` alias;
- a copied file differs from its provenance hash; or
- any non-third-party bundle input resolves outside this directory.

The source-boundary integration test copies only this directory to a temporary
location, installs its pinned third-party dependencies, typechecks it, verifies
the boundary, compiles it, and runs its help surface. The built CLI is
`dist/routekit-eval-engine.mjs` and requires Node on PATH plus this package's
`node_modules`.

## Direct eval use

```bash
node dist/routekit-eval-engine.mjs login
node dist/routekit-eval-engine.mjs eval scratch
node dist/routekit-eval-engine.mjs eval --path /path/to/test.eval.ts --report report.md
```

`eval --dry-run` and `eval --list` require no credential. Candidate and judge
runs require real Gateway access.

## Authoring workflow

```bash
node dist/routekit-eval-engine.mjs spawn skill
node dist/routekit-eval-engine.mjs spawn manifest
node dist/routekit-eval-engine.mjs --json spawn prepare --request-file request.txt --repo /path/to/repo
node dist/routekit-eval-engine.mjs --json spawn run --repo /path/to/repo
node dist/routekit-eval-engine.mjs --json spawn answer --answer-file answer.txt --repo /path/to/repo
node dist/routekit-eval-engine.mjs spawn status --repo /path/to/repo
```

The controller creates a private repository copy under a deterministic
`/tmp/spawn-routekit-eval-<hash>` directory, persists interview state and attempts,
relays one question at a time, records structured scratch/eval artifacts, and
audits the original repository for mutation. Exit status 75 means it is waiting
for the user's answer.

See `EXTRACTION.md` for the exact source boundary and flow, and
`FEATURE_COMPLETENESS.md` for what remains unqualified.
