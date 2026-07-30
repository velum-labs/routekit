# CLI reference

RouteKit ships one public CLI: `@velum-labs/routekit` with the `routekit` binary.

## Install

```sh
curl -fsSL https://github.com/velum-labs/routekit/releases/latest/download/install.sh | sh
routekit config init
routekit providers status
routekit models list
routekit start
routekit codex openai/gpt-5.5
```

Or `npm install -g @velum-labs/routekit` when Node.js 22+ is already installed.
Upgrade with `routekit self-update`.

## Architecture

RouteKit is a thin client of one singleton daemon per `ROUTEKIT_HOME`. The
daemon owns a private authenticated `control.v1` listener, the stable model
gateway, provider/catalog state, subscription pools, usage, and canonical
global config. Every product command negotiates with it; help/version/shell
completion, terminal interaction, OAuth/editor subprocesses, and coding-tool
spawning stay local. Concurrent first calls race-safely start exactly one
daemon, using a persistent systemd user unit / launchd agent when available
and a clearly reported detached fallback otherwise.

The canonical file is `~/.config/routekit/router.yaml`. Project
`.routekit/router.yaml` files are explicit SDK/embedded-router inputs, not daemon
scopes. `routekit config import --from .routekit/router.yaml` validates and
replaces the complete canonical document; it does not merge layers.

`routekit start|status|stop` is the public lifecycle. The same bootstrap runs
implicitly before product commands, chooses systemd/launchd or detached
operation internally, and never requires a separate service-install workflow.
Advanced `routekit daemon reload|restart|upgrade|logs` and `daemon service
install|uninstall|status` commands remain available for repair, diagnostics,
and compatibility; there is no user-facing foreground serve command, and the
internal `daemon run` entrypoint is exec'd only by supervisors and the
detached spawner. Config/account reloads atomically switch router generations while
old in-flight streams drain; binary upgrade drains and restarts the combined
daemon, then the initiating client reconnects and retries.
See the [`@velum-labs/routekit` README](../packages/cli/README.md) for the
full service runbook.

## Lifecycle

```sh
routekit start
routekit status
routekit status --watch
routekit stop
```

## Coding-tool launchers

```sh
routekit codex [provider/model] [--effort <id>] [args...]
routekit claude [provider/model] [--effort <id>] [args...]
routekit cursor [provider/model] [--effort <id>]
```

Each launcher asks the daemon for the gateway URL and spawns the supported
coding-agent binary locally. Omitting the model uses the router `defaultModel`
when the tool allows it. Codex is Responses-only, so its picker hides obvious
OpenRouter chat-only models using a best-effort reasoning-capability heuristic.

`--effort` validates the opaque effort id against the selected model's
discovered reasoning metadata, then projects it into the tool:

- Codex writes `model_reasoning_effort` into the generated config.
- Claude Code launches with `--model <picker-base>:<effort>`, matching the
  Anthropic `/v1/models` picker variants.
- Cursor prints the BYOK model name as `routekit/<model>:<effort>`.

Claude Code and Cursor picker entries use `<base-model>:<effort>` for each
provider-advertised effort and keep the unsuffixed base entry for provider
defaults. Unknown or unsupported qualified ids fail with a client-visible error
and make no provider call.

Install or remove RouteKit-owned tool configuration:

```sh
routekit codex install
routekit codex uninstall
routekit claude install
routekit claude uninstall
```

The persistent installers target the selected local or named remote RouteKit
gateway; arbitrary gateway URLs are intentionally not accepted. They add only
RouteKit-owned configuration and preserve the rest of the real client home.
Codex receives a named provider and profiles, never a default-provider or default-
model change. Claude receives gateway discovery settings only. Each install issues
a dedicated data token and prints it once: export `ROUTEKIT_GATEWAY_TOKEN` before
starting Codex or `ANTHROPIC_AUTH_TOKEN` before starting Claude. The plaintext is
never written to client configuration or RouteKit state. Reinstalling the same
target updates configuration without revealing or replacing the token; pass
`--rotate-token` to rotate it. Uninstall revokes the tracked dedicated token.

Native clients own their histories and all native resume/delete commands. The
optional launchers forward native arguments after `--`, for example
`routekit codex -- resume <native-id>` and
`routekit claude -- --resume <native-id>`.

## Providers and models

```sh
routekit providers add openai
routekit providers remove anthropic
routekit providers status
routekit models list
routekit models list --provider openai
routekit models info openai/gpt-5.5
```

## Subscription accounts

```sh
routekit accounts login claude-code --name personal
routekit accounts login codex --name work
routekit accounts add codex --name primary
routekit accounts list
routekit accounts status
routekit accounts remove codex --name work
routekit accounts rename codex work personal
```

`--no-browser` prefers a device-code or copyable-URL flow for headless hosts.

## Usage and quotas

```sh
routekit usage
routekit usage --watch 10
routekit usage redeem --provider codex
routekit usage redeem --provider codex --label work --credit-id RateLimitResetCredit_…
routekit usage redeem --provider codex --label work --yes
```

Interactive redemption selects an eligible account and banked reset credit, then
asks for final confirmation. Non-input use requires `--yes`; absent an explicit
credit ID, RouteKit selects the soonest-expiring detailed credit. Count-only
provider data remains redeemable and is explicitly reported as provider-selected.

## Configuration

```sh
routekit config init
routekit config show
routekit config path
routekit config edit
routekit config import --from .routekit/router.yaml
routekit config migrate
```

See [Configuration](configuration.md) for router YAML fields and precedence.

## Remote gateways

```sh
routekit remote add <name> --url <gateway> --ssh <host>
routekit remote use <name>
routekit --remote <name> status
routekit remote list
routekit remote remove <name>
```

## Tokens and call attribution

```sh
routekit token issue <label>
routekit token list
routekit token revoke <label>
routekit calls inspect <call-id>
routekit calls inspect <call-id> --json
routekit leaderboard
routekit leaderboard --by model --sort requests --window 24h --json
```

`routekit leaderboard` ranks named principals (default), models, or providers
over the daemon's retained call window. Use `--window live` for the in-memory
store, or `1h` / `24h` / `7d` when `leaderboard.durable: true` is set in
`router.yaml`.

## Diagnostics and telemetry

```sh
routekit doctor
routekit telemetry status
routekit telemetry on
routekit telemetry off
routekit telemetry category usage off
routekit telemetry category reliability on
routekit telemetry category adoption on
routekit telemetry schema
routekit telemetry reset
routekit completion bash
routekit version
```

## Global options

| Option | Meaning |
| --- | --- |
| `--json` | Machine-readable output where supported. |
| `--no-input` | Disable interactive prompts. |
| `--yes` | Accept defaults without prompting. |
| `--quiet` | Suppress non-essential output. |
| `--config <path>` | Recovery/foreground SDK path only; not a daemon scope selector. |
| `--remote <name>` | Target a enrolled remote gateway. |
| `--local` | Force the local daemon when a remote is selected. |

## Environment variables

| Variable | Meaning |
| --- | --- |
| `ROUTEKIT_HOME` | Runtime state directory (default `~/.routekit`). |
| `ROUTEKIT_CONFIG` | Explicit router config path for recovery/foreground use. |
| `ROUTEKIT_NO_TUI` | Force plain output. |
| `ROUTEKIT_DRAIN_GRACE` | Grace period for in-flight streams during shutdown (seconds). |
| `ROUTEKIT_TELEMETRY` | Explicit telemetry override (`1`, `true`, `on`, or `yes` enables; `0`, `false`, `off`, or `no` disables). |
| `ROUTEKIT_POSTHOG_KEY` | Optional non-empty override for RouteKit's bundled PostHog project token. |
| `ROUTEKIT_POSTHOG_HOST` | Optional PostHog ingest host override (default `https://us.i.posthog.com`). |
| `DO_NOT_TRACK` | Force-disable telemetry, taking precedence over all other controls. |
| Provider keys | Registry-defined variables such as `OPENAI_API_KEY`, read by the daemon from its environment or `~/.routekit/env/daemon.env` on supervised installs. |


Product telemetry is off by default. Category controls separately gate usage,
reliability, and adoption events. See [the exact telemetry inventory](telemetry-inventory.md)
for destination, fields, aggregation, forbidden data, identity, and remote semantics.
