# Onboard RouteKit

Use this workflow for installation and a first healthy route.

## Install

If `routekit` is absent on macOS or Linux, use the official installer and
then resolve `routekitArgv` and verify the executable:

```sh
curl -fsSL https://github.com/velum-labs/routekit/releases/download/routekit-latest/install.sh | sh
```

```text
$ROUTEKIT version
```

`$ROUTEKIT` denotes the resolved `routekitArgv` from `SKILL.md`; do not use it
as a shell variable or pass the literal token.

Do not use `sudo`. If installation fails, report the failing prerequisite or
installer diagnostic rather than improvising a different global installation.

## Inspect before setup

Run:

```text
$ROUTEKIT config show --json
$ROUTEKIT status --json
```

If a valid configuration already exists, treat the request as maintenance.
Do not replace it merely because the user asked to "set up RouteKit."

## Choose the setup path

Ask which API providers or subscriptions the user wants to connect. Ask one
question per turn and never ask the user to paste credential values.

- With a person available, prefer `$ROUTEKIT setup`. It can combine selected API
  and subscription routes, verify them, choose a live default, and start the
  local gateway.
- For one unattended API provider, use
  `$ROUTEKIT config init --provider <provider>`.
- Before subscription-only enrollment, use `$ROUTEKIT config init --empty`.
- Import a complete reviewed router only with
  `$ROUTEKIT config import --from <path>` and explicit replacement approval.

Resolve `<provider>` and `<account-kind>` from the installed command's help.
Examples in documentation are not a substitute for the current accepted
values.

API credentials must already exist in the process environment. Subscription
login is interactive:

```text
$ROUTEKIT accounts login <account-kind> --name <label>
```

Use `$ROUTEKIT accounts add` only when the user wants to import an existing
official CLI login.

## Verify

Run:

```text
$ROUTEKIT status --json
$ROUTEKIT providers status --json
$ROUTEKIT accounts status --json
$ROUTEKIT models list --json
```

Require a ready gateway and at least one intended live model. Use only model IDs
returned by `models list`.

Finish with the shortest relevant use command, for example:

```text
$ROUTEKIT <tool> <model-id>
```

Do not claim onboarding succeeded when configuration exists but provider
discovery, account health, daemon readiness, or model discovery failed.
