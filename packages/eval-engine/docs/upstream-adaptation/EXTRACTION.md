# Production extraction map

## Independent boundary

The standalone source tree contains its complete production implementation:

```text
standalone/eval-system/
├── src/                    # focused product and outer controller
├── src/vendor/             # extracted production closure
├── skills/                 # exact embedded persona/protocol assets
├── PROVENANCE.json         # source/destination hashes and source commit
├── scripts/                # extraction and boundary verification
└── test/production/        # pipeline and isolated-source tests
```

The current manifest contains 687 production source/assets copied from RouteKit Eval
commit `45c1bb03b9d74b2d0d7a75fb1faf1a39e855c431`. All internal specifiers were
rewritten to relative paths. The only source dependencies are pinned third-party
packages: Effect's Node platform, Effect, MCP SDK, Gateway Agent, Codex CLI,
esbuild, fflate, and yaml.

**Extractor freeze:** do not run `scripts/extract-production-closure.ts` until
the Node port of this tree is merged. A raw extract from `framework/` would
restore Bun APIs into `src/vendor`.

The extractor derives the reachable closure from a Bun metafile, follows
runtime and type-only local imports, copies only reachable files, applies the
small focused-product seams (headless `code`, spawn skill wiring, and
`ROUTEKIT_EVAL_INFERENCE_ORIGIN` on catalog/endpoints/Claude/Pi), rewrites imports, and
emits hashes. This is not a workspace composition root: `verify-boundary`
proves that a normal build never reads `framework/`, another RouteKit Eval package, or an
installed `routekit-eval` module.

## Focused production surface

| Product surface                    | Extracted implementation                                           |
| ---------------------------------- | ------------------------------------------------------------------ |
| CLI parsing/output/error reporting | production CLI bootstrap and focused command roster                |
| Credentials                        | production login/auth/credential resolution                        |
| Author                             | production headless code command and Pi, Claude, and Codex adapters |
| Persona/skill                      | copied code persona and exact create-eval markdown                 |
| Eval command                       | discovery, portability gate, dry run, child node --test, reports   |
| Runtime                            | production feature runner, daemon, loopback protocol, SQLite state |
| Eval SDK                           | production generated `routekit/eval` artifact and injection             |
| Results                            | candidate/judge JSONL join, JUnit, history, baseline, report       |
| Outer workflow                     | standalone durable spawn controller                                |

Removed from the closure are Slack, chat/TUI, schedules, feature-development,
unrelated code skills, and generic product commands. Claude and Codex stay in
the author catalog; they are optional at runtime until their native CLIs (or
the bundled Codex executable) are present.

## Runtime flow

```text
spawn prepare
  -> deterministic private run directory
  -> state/task/steps files and source content snapshot

spawn run / answer
  -> auth gate
  -> private repository copy
  -> headless code command using the selected production author harness
     (Pi by default; Claude or Codex when `--harness` names them)
  -> code persona + create-eval interview
  -> one tagged question relayed and durably persisted per turn
  -> eval scratch and generated routekit/eval SDK
  -> authored *.eval.ts
  -> eval command and ephemeral daemon
  -> real candidate and judge calls through Gateway
  -> node --test process
  -> JUnit + JSONL result reconciliation
  -> history/baseline/report and measured cost projection
  -> source mutation audit and final relay
```

## Node 22 runtime

Production eval files use node:test. The installed product requires Node 22.22
or newer and invokes evals with `node --test`. Child eval and Pi processes use
the host node executable; they do not need bun on PATH.

## Durable outer artifacts

```text
/tmp/spawn-routekit-eval-<hash>/
├── state.json
├── task.txt
├── steps.txt
├── run.lock
├── answer-N.txt
├── error-N.log
├── bin/routekit-eval
├── repository/
├── source-snapshot.json
├── source-mutation.json
├── routekit-eval/scratch-workspace.txt
├── routekit/eval-runs.jsonl
└── previous/<timestamp>/
```

State pins protocol and skill hashes. A live PID lock prevents concurrent runs;
stale locks recover. Signals forward to the author process group. The original
repository is read and audited, while authoring occurs in the private copy.

## Qualification boundary

The offline suite proves the real zero-provider portions, auth boundary,
Node runtime path, result/report/history machinery, outer persistence, and
source independence. It does not prove paid candidate/judge behavior without a
credential, nor untested release platforms. See `FEATURE_COMPLETENESS.md`.
