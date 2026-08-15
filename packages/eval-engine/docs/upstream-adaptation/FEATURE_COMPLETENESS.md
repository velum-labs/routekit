# Completeness and qualification matrix

Status on August 13, 2026.

This document separates implementation from observed qualification. The source
extraction and offline pipeline are real; a paid end-to-end provider run and the
full platform matrix are still required before calling the shipped product
feature-complete.

## Source and distribution

| Capability                | Implemented                                      | Qualified here                                                     | Remaining                                |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------- |
| Independent source tree   | yes; 687 copied production files with provenance | isolated copy installs, typechecks, verifies, builds, and runs     | publish as its own repository/package    |
| No RouteKit Eval dependency         | yes; no RouteKit Eval/workspace dependencies or imports    | metafile boundary test                                             | keep the gate in CI                      |
| Dist CLI                  | yes; `dist/routekit-eval-engine.mjs` (esbuild ESM, `packages: "external"`) | Linux x64 Node 22.22+ / 24                                     | Node SEA / signed binary                 |
| Product CLI               | login, auth, code, eval, spawn, version          | help, `-v`, `--json spawn`, headless-only code                     | hosted installer                         |
| Requires Node 22.22+; does not require bun | yes | eval scratch/dry-run/full zero-call test with PATH limited to the node directory plus `/usr/bin:/bin` | platform release smoke                   |
| Hosted curl installer     | no                                               | no                                                                 | versioned endpoint, checksums, installer |

## Real pipeline

| Surface                  | Implemented                    | Qualified here                     | Remaining                     |
| ------------------------ | ------------------------------ | ---------------------------------- | ----------------------------- |
| Login/auth               | extracted production code      | missing-key and stored-key gates   | interactive live login        |
| Pi author                | extracted production adapter   | process/bootstrap/auth boundary    | live author turn              |
| Claude author            | extracted production adapter   | catalog and `--harness claude`     | live author turn with `claude` |
| Codex author             | extracted production adapter   | catalog and `--harness codex`      | live author turn with Codex    |
| Code persona/create-eval | copied exact assets            | digest and output checks           | full live interview           |
| Scratch/generated SDK    | extracted production code      | generation, import, node --test load | live candidate assertions     |
| Daemon/runtime           | extracted production code      | zero-provider runtime starts/stops | real traffic                  |
| Candidate/judge          | extracted real Gateway path | cutoff/empty reconciliation        | paid candidate and judge rows |
| JUnit/JSONL              | extracted production code      | offline real runner and parsers    | paid partial failure          |
| Report/history/baseline  | extracted production code      | offline complete pipeline          | live multi-model comparison   |

Pi is the default author harness. Claude and Codex remain in the product
catalog and are selected with `--harness claude` or `--harness codex`. They
need their native CLI (or the bundled Codex executable) at runtime; absence is
a diagnostic, not a removed feature.

## Outer workflow

Implemented and tested:

- deterministic per-repository run directory;
- versioned and skill-digest-gated state;
- normalized request matching and non-destructive archive/resume/stop;
- PID lock, stale-lock recovery, active child tracking, signal forwarding;
- private repository copy that skips bulky trees and external symlinks, with
  file/byte caps; source snapshot recaptured immediately before the child;
- after-the-fact source content audit that fails the run if the original tree
  still changes;
- one-question parsing, option/prompt/table-header relay, and exact transcript
  replay only when the reply answers the open question;
- clarification-versus-answer handling (`accepted: false`, no append, no restart);
- structured scratch path and eval-run records;
- candidate/judge counts, durations, tokens, and cost projected only from
  measured records; unknown values remain unknown;
- completed/waiting `costTable` and `cheaperRerun` lines; `bakeoff` rewritten to
  `model comparison` on relay;
- `spawn` reachable through leading `--json`/`--human` flags;
- `version` / `-v` / `--version`;
- host contract: `HOST.md`, spawn `manifest.host`, exit-code constants, and
  `ROUTEKIT_EVAL_INFERENCE_ORIGIN` overlay for catalog, endpoints, Claude, and Pi;
- recoverable insufficient-credit, rate-limit, and provider-timeout
  classification on failed author turns;
- no interactive TUI: bare launch is help, `code` without a prompt fails.

Not yet fully implemented or qualified against every branch of the hosted
240-line `spawn-routekit-eval` protocol snapshot:

- interrupted-paid-turn recovery after spend has already started;
- rollback of writes that still escape the private copy. Mutation detection
  after a turn cannot restore arbitrary user-tree edits.

## Credential-gated qualification

No Gateway credential is installed in this environment. These remain
unobserved:

- [ ] real Pi author call;
- [ ] real Claude author call;
- [ ] real Codex author call;
- [ ] complete five/six-question create-eval interview;
- [ ] generated multi-model eval;
- [ ] real candidate calls;
- [ ] real judge calls;
- [ ] live result/report/history/baseline/recommendation;
- [ ] author + candidate + judge cost reconciliation;
- [ ] provider error and interruption recovery after spend begins.

Run the credential-gated test explicitly:

```bash
ROUTEKIT_EVAL_LIVE=1 \
ROUTEKIT_EVAL_LIVE_MODEL=<gateway-model-slug> \
ROUTEKIT_EVAL_BEARER_TOKEN=<credential> \
npm test
```

## Host / RouteKit

The spawn host contract is frozen in `HOST.md` (`protocolVersion` 2): process
env, JSON envelopes, exit codes, and an injectable `ROUTEKIT_EVAL_INFERENCE_ORIGIN`.
RouteKit itself is unchanged. A later host shells out to `routekit-eval-engine`; it
does not import this TypeScript. Remaining merge work is artifact distribution,
credential ownership, lifecycle, and live qualification — not a missing URL
seam.

## Conclusion

The standalone **source boundary is real**. The core eval execution path uses
extracted production code and no mocks. The product CLI now includes spawn and
version and refuses an interactive TUI. It is **not yet feature-complete** until
the remaining outer protocol behavior and live provider qualification above are
completed.
