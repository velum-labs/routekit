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

## Required Resolution gate

Complete this gate before choosing a workflow reference or running any workflow
command. Resolution is a gate, not another workflow.

| Parameter | Resolution |
| --- | --- |
| `routekitArgv` | `["routekit"]`, or `["node", "<absolute-cli-dist-path>"]` in the source checkout |
| `repositoryRoot` | Explicit user path, otherwise the discovered current repository root; store an absolute path |
| `target` | Exactly `["--local"]` or `["--remote", "<name>"]`; never an empty argv or the implicit active remote |
| `health` | `unresolved`, `ready`, or one named gap derived from structured CLI output |

Fill this parameter ledger first and record every value's source.

1. Resolve `routekitArgv` and `repositoryRoot`. Run `version`, root help, and
   relevant subcommand help through that exact argv.
2. Resolve `target` explicitly:
   - honor an explicit user choice of local or a named remote;
   - otherwise inspect configured remotes with
     `[...routekitArgv, "--local", "remote", "list", "--json"]`;
   - if a remote is active, show its name and ask whether to use it or local;
     for eval requests, make local the default and select that remote only
     after the user confirms it; and
   - if no remote is active, use `["--local"]`.
3. Set `targetArgs = target`. Never guess a remote name or leave
   `targetArgs` empty.
4. With the child-process working directory set to `repositoryRoot`, run:

```text
[...routekitArgv, ...targetArgs, "status", "--json"]
[...routekitArgv, ...targetArgs, "config", "show", "--json"]
```

Use these two commands as the health gate. Do not add a parallel health sweep
or substitute `doctor` for this gate. Set `health = ready` only when their
structured results show that the selected target has a validated router
configuration and a ready daemon or gateway.

If either result exposes a gap, set `health` to one stable named gap, report it,
offer exactly one public CLI remediation, and wait. Prefer one exact `tryArgv`
returned by the CLI. Do not run the remediation, retry the gate, auto-recover,
guess another target, choose a workflow, or enter `eval propose`, `eval
estimate`, or `eval run`.

Missing configuration is expected during first setup, not a reason to improvise
recovery. Offer `setup` for guided first-route onboarding or `config init` when
the request is only to create the canonical router, but offer only the one that
matches the request. For an eval request, name a missing `router.yaml` as
`router_missing` and offer `config init`; name an unready daemon as
`daemon_unready` and offer `setup`. Never offer a billed eval command as the
fix.

Do not translate Resolution gaps into environment-specific infrastructure,
remote-shell, installer-layout, or release-bump procedures.

## Resolve workflow-specific parameters

Only after `health = ready`, extend the ledger with parameters needed by the
selected workflow:

| Parameter | Resolution |
| --- | --- |
| `interaction` | `human` when prompts can be answered; otherwise `automation` |
| `provider` / `accountKind` | A value accepted by this CLI version's help |
| `modelId` | An exact ID returned by `models list` |
| `tool` | A supported native client selected by the user |
| `evalScope` | The reviewed `pilot` or `full` scope |
| `spendApproved` / `publishApproved` | Separate explicit decisions; both default to false |

Required unresolved parameters block only the operation that needs them;
irrelevant parameters remain absent rather than receiving guessed defaults.
Construct every later invocation as
`[...routekitArgv, ...targetArgs, ...operationArgs]`. Omit `targetArgs` only
when current help marks the operation local-only. Do not encode `cd` into the
command. Treat every parameter as a typed argv value, not a shell fragment.
Never execute a displayed template or `$ROUTEKIT` example with unresolved
`<placeholders>`, and never resolve a secret into a prompt, command log, or
committed file.

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
4. **Mutate** once. Never auto-recover or automatically retry a mutating
   command after an ambiguous result.
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
