# Configure and Operate RouteKit

Use the smallest command that owns the requested state. Run its `--help`
before mutation and prefer structured output for inspection and verification.

`$ROUTEKIT` denotes the resolved `routekitArgv` from `SKILL.md`; do not use it
as a shell variable or pass the literal token.

Resolve `targetArgs`, `provider`, `accountKind`, `modelId`, `tool`, `remoteName`,
and `callId` only when the requested operation needs them. Obtain enumerated
values and IDs from current CLI help or structured discovery output. Never
guess them or reuse values from an unrelated target.

## Inspect

```text
$ROUTEKIT status --json
$ROUTEKIT config show --json
$ROUTEKIT providers status --json
$ROUTEKIT accounts status --json
$ROUTEKIT models list --json
```

Use `$ROUTEKIT remote list --json` and `$ROUTEKIT remote show --json` when a
remote may be active. Add resolved `targetArgs` when target ambiguity could
change the affected gateway and the command supports remote targeting.
Canonical router-file operations and guided setup are local-only.

## Select the owning command

- Router document: `config show`, `config edit`, or complete `config import`.
- API provider lifecycle: `providers add`, `providers remove`, and
  `providers status`.
- Subscription accounts: `accounts login`, `accounts add`, `accounts rename`,
  `accounts remove`, and `accounts status`.
- Daemon lifecycle: `start`, `status`, and `stop`; use hidden `daemon`
  operations only for their documented advanced cases.
- Native clients: `codex install|uninstall` and
  `claude install|uninstall`.
- Shared gateways: `remote`, `token`, and `peer` commands.
- Model selection: `models list` and `models info`.

The singleton CLI daemon uses the canonical global router document. It does not
layer project configuration. `config import` validates and atomically replaces
the complete document; it does not merge.

Canonical model IDs are `provider/native-model`. Resolve `modelId`, aliases,
reasoning efforts, and provider capabilities from the selected target rather
than constructing or guessing them.

## Verify the changed subsystem

| Change | Verification |
| --- | --- |
| Router document | `$ROUTEKIT config show --json` |
| API provider | `$ROUTEKIT providers status <provider> --json` |
| Subscription account | `$ROUTEKIT accounts status --json` |
| Model or policy | `$ROUTEKIT models list --json` and `models info` |
| Daemon lifecycle | `$ROUTEKIT status --json` |
| Remote | `$ROUTEKIT remote show [name] --json` |
| Native client | Send one request and inspect its call ID |

After a native-client request, use:

```text
$ROUTEKIT calls inspect <call-id> --json
```

Do not infer success solely from a file write or a zero exit from a setup
command when live discovery or daemon state is part of the requested result.
