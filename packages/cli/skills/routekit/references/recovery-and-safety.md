# Recover and Protect RouteKit

## Protect secrets

Never print, request in chat, log, or commit API keys, OAuth credentials,
RouteKit tokens, authorization headers, complete secret files, or raw eval
child output.

Treat these commands as secret-producing:

- `$ROUTEKIT token issue`
- `$ROUTEKIT daemon auth show`

Prefer environment-variable references over literal token arguments. API keys
belong in provider-supported environment variables, not router YAML.

## Diagnose before retrying

Use:

```text
[...routekitArgv, ...targetArgs, "doctor", "--json"]
[...routekitArgv, ...targetArgs, "status", "--json"]
[...routekitArgv, ...targetArgs, "providers", "status", "--json"]
[...routekitArgv, ...targetArgs, "accounts", "status", "--json"]
```

This public `doctor` command is for a selected recovery workflow; it does not
replace or extend the root Resolution gate.

In JSON errors, use a supplied `tryArgv` exactly rather than parsing prose.
Offer one public CLI remediation and wait. Never run the remediation,
auto-recover, or automatically retry a mutation.

After an interrupted eval or publication command, inspect `eval status` and
`eval results` before deciding that work remains.

## Preserve boundaries

- Keep the default loopback bind unless authenticated network exposure is
  intentional.
- Do not cross provider or billing classes as an improvised fallback.
- Do not replace existing configuration without explicit approval.
- Do not describe missing pricing or measurements as zero.
- Do not spend, expose repository material to models, issue plaintext tokens,
  or publish routing activation silently.
- Do not report a passing pilot or classifier-only run as production routing
  qualification.
