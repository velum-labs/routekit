---
name: routekit
description: >-
  Install, onboard, configure, operate, troubleshoot, and evaluate RouteKit
  gateways through the public routekit CLI. Use for provider and subscription
  account setup, router configuration, local or remote daemon management,
  coding-tool integration, health checks, compositional eval routing,
  model:auto qualification, and resuming interrupted RouteKit workflows. Do
  not use for generic LLM gateway or model-evaluation work unrelated to
  RouteKit.
---

# RouteKit

Use the public `routekit` CLI as the product boundary. Do not replace missing
CLI behavior with package internals, direct state-file edits, control-protocol
calls, testkit commands, or standalone eval executables.

Inside the RouteKit source checkout, build the CLI first and use:

```text
node packages/cli/dist/index.js
```

For an installed release, use `routekit`. In this skill, `$ROUTEKIT` is a
documentation token for the resolved argv prefix, not a shell variable.

## Resolve workflow parameters

Resolve only the parameters needed for the request before constructing
commands:

| Parameter | Resolution |
| --- | --- |
| `routekitArgv` | `["routekit"]`, or `["node", "<absolute-cli-dist-path>"]` in the source checkout |
| `repositoryRoot` | Explicit user path, otherwise the discovered current repository root; store an absolute path |
| `targetArgs` | `[]`, `["--local"]`, or `["--remote", "<name>"]` |
| `interaction` | `human` when prompts can be answered; otherwise `automation` |
| `provider` / `accountKind` | A value accepted by this CLI version's help |
| `modelId` | An exact ID returned by `models list` |
| `tool` | A supported native client selected by the user |
| `evalScope` | The reviewed `pilot` or `full` scope |

Keep the resolved values in a per-workflow parameter ledger. Record each
parameter's source, such as user input, CLI help, or structured CLI output.
Required unresolved parameters block only the operation that needs them;
irrelevant parameters remain absent rather than receiving guessed defaults.

Construct every invocation as an argv array:

```text
[...routekitArgv, ...targetArgs, ...operationArgs]
```

Omit `targetArgs` when current help says the operation is local-only. Set the
child process working directory to `repositoryRoot` when repository state is
involved; do not encode `cd` into the command. Treat every parameter as a
typed argv value, not a shell fragment. Do not interpolate untrusted text into
a shell command. Never execute a displayed template or `$ROUTEKIT` example
with unresolved `<placeholders>`, and never resolve a secret into a prompt,
command log, or committed file.

## Start by discovering state

1. Check whether `$ROUTEKIT` is installed and run `$ROUTEKIT version`.
2. Run `$ROUTEKIT --help` and relevant subcommand help before acting. Use only
   commands and flags exposed by that CLI version.
3. Inspect existing state before changing it:

   ```text
   $ROUTEKIT --json status
   $ROUTEKIT --json config show
   ```

   A missing installation, configuration, or daemon is expected during
   onboarding; distinguish it from invalid existing state.
4. Prefer `--json --no-input` for automation. Use interactive commands only
   when a person is available to answer them.
5. Resolve `targetArgs` explicitly when needed: global `--remote <name>` or
   `--local` wins, then the active remote, then the local daemon. Apply target
   arguments only to commands whose current help supports that target; setup
   and canonical router-file operations are local-only.

Never replace an existing router document with `--force` or `config import`
without explicit approval of the complete replacement.

## Choose one workflow

- **Install or first-time setup:** Read
  [references/onboarding.md](references/onboarding.md).
- **Change providers, accounts, router policy, clients, remotes, or daemon
  state:** Read [references/configuration.md](references/configuration.md).
- **Diagnose a failed or ambiguous operation:** Read
  [references/recovery-and-safety.md](references/recovery-and-safety.md).
- **Define workload dimensions, author evaluations, estimate or run evidence,
  inspect results, or activate `model: "auto"`:** Read
  [references/eval-routing.md](references/eval-routing.md).

For mixed requests, establish a healthy configured gateway before beginning
eval routing. Do not run RouteKit eval routing for a generic request to compare
models or evaluate an unrelated application.

## Use the safe operating loop

1. **Inspect** the current installation, selected target, configuration, and
   subsystem status.
2. **Plan** the smallest public CLI mutation that satisfies the request.
3. **Confirm** destructive replacement, secret-producing commands, billed
   model calls, and routing publication.
4. **Mutate** once. Do not automatically retry a mutating command after an
   ambiguous result.
5. **Verify** the exact subsystem changed, then verify overall gateway health.

Ask one question per turn when user input is required. Never invent provider
choices, account labels, model IDs, eval answers, spending approval, or
publication approval.

## Completion contract

Do not report completion until:

- the requested state is visible through the public CLI;
- configured providers or subscription accounts report healthy;
- intended model IDs appear in `models list`;
- the selected local or remote gateway reports ready; and
- any billed or publication step has the user's explicit approval and a
  reviewed result.
