---
name: setup-eval-routing
description: >-
  Onboard a repository into RouteKit eval-driven model routing through the
  public routekit eval CLI. Use when the user wants to create or resume eval
  setup, author and review routing evals, compare explicit models, estimate a
  billed run, publish measured routing evidence, or configure trustworthy
  model:auto. Do not use for merely running an existing model-free test suite.
---

# Set Up Eval Routing

Use the public `routekit eval` CLI as the sole product boundary. Do not call internal
`EvalSetup` services, invoke a standalone eval executable, or run testkit live
qualification commands as a substitute for a missing product command.

When working inside the RouteKit source checkout, build first and invoke:

```text
node packages/cli/dist/index.js
```

For an installed release, invoke:

```text
routekit
```

Refer to either form below as `$ROUTEKIT`.

## Start

1. Run `$ROUTEKIT eval --help`. Use only commands exposed by that CLI version;
   never invent flags or subcommands.
2. Choose a stable lowercase `--profile` ID with the user.
3. Run:

   ```text
   $ROUTEKIT --json eval status --profile <id> --repository <root>
   ```

4. If no state exists, run:

   ```text
   $ROUTEKIT --json eval prepare --profile <id> --repository <root>
   ```

Setup is durable. Resume existing state instead of starting over after an
interruption.

## Authoring interview

- Relay exactly one returned question and its context. Ask one question per turn.
- Never answer an authoring question for the user.
- Submit the answer unchanged with `eval answer`. Prefer a private temporary
  `--answer-file` for multiline content; remove it after the command finishes.
- If the state is waiting for an answer, do not call `eval run`.
- Before any `eval run`, explain the next billed/model-backed step, show the
  selected gateway and explicit model roles, and obtain user approval.
- Candidate, author, classifier, and judge roles must use explicit
  `provider/model` IDs. Eval traffic must never use `model: auto`.

Use `eval status` after every interruption or ambiguous command result. Do not
repeat accepted answers or duplicate a completed paid run.

## Validate, estimate, run

After the CLI reports an authored eval artifact:

1. Run `eval validate`. This must dry-load the suite without executing cases.
2. Run `eval estimate --mode pilot` or `--mode full`.
3. Report the CLI's exact call count and pricing status. Missing pricing is
   unknown, never zero.
4. Obtain explicit approval for the reported run scope.
5. Run `eval run` with exactly one dedicated credential source:
   `--token-file`, `--token`, or the documented environment source. Prefer a
   private regular `0600` token file.
6. Report failures without exposing credentials, request bodies, provider
   responses, headers, or raw child output.

Do not silently reduce case counts, change candidates, replace failed rows, or
publish incomplete evidence.

## Publish

Run `eval publish` only after all of the following are true:

- the authored suite validates;
- the measured run completed successfully;
- candidate and judge evidence is complete;
- the user reviewed the result; and
- the user explicitly approved publication.

Publication must compile already-measured evidence and must not trigger another
paid run.

## Compositional routing boundary

The current public CLI may expose only the single-profile workflow. If
`$ROUTEKIT eval --help` does not expose the compositional area-catalog,
classifier-qualification, full matrix, and routing-explanation operations the
user requested:

- state the CLI capability gap clearly;
- do not claim that repeated single-profile setup creates compositional v2 routing;
- do not bypass the gap with internal services or the live testdrive; and
- offer to implement the missing RouteKit CLI surface.

When the installed CLI does expose compositional operations, preserve the v2
protocol boundary: classification receives only the request and reviewed area
definitions; deterministic scoring receives the resulting area vector,
requirements, objective, and published model-by-area evidence.

## Safety

- Never spend or publish silently.
- Never send repository material until the user approves the model-backed
  authoring step.
- Never log, echo, or commit credentials.
- Never describe unknown cost as zero.
- Never evaluate the router recursively through `model: auto`.
- Keep generated evals and sanitized structured results reviewable in the
  repository when the user approves committing them.
