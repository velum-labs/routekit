# CLI reference

RouteKit ships one public CLI: `@velum-labs/routekit` with the `routekit` binary.

## Install

```sh
curl -fsSL https://github.com/velum-labs/routekit/releases/download/routekit-latest/install.sh | sh
routekit setup
routekit providers status
routekit models list
routekit codex
```

Or `npm install -g @velum-labs/routekit` when Node.js 22+ is already installed.
Upgrade with `routekit self-update`.

On macOS and Linux, self-update automatically delegates to a verified
public-installer receipt, npm, pnpm, Yarn Classic, Bun, or Volta installation.
System package managers stay authoritative and receive safe upgrade guidance.
Local, linked, ephemeral, unknown, and ambiguous executions are not mutated.

`routekit setup` is interactive, local-only, and supports selecting multiple
API and subscription routes before choosing a live default model. It reads API
credentials from the environment and never stores them. Automation should use:

```sh
routekit config init
routekit config init --provider anthropic
routekit config init --provider openrouter
routekit config init --provider bedrock --default-model bedrock/MODEL_ID
routekit config init --empty
```

## Architecture

RouteKit is a thin client of one singleton daemon per `ROUTEKIT_HOME`. The
daemon owns a private authenticated `control.v2` listener, the stable model
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
install|uninstall|status` commands remain available for repair and diagnostics;
there is no user-facing foreground serve command, and the
internal `daemon run` entrypoint is exec'd only by supervisors and the detached
spawner. Its stable cluster primary owns service authority and shared listener
handles while one active worker owns control and routing state. Config/account
reloads atomically switch router generations; restart and binary upgrade roll
the worker on the same ports while old in-flight streams drain.
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
```

Each launcher asks the daemon for the gateway URL and spawns the supported
coding-agent binary in the current directory. Omitting the model selects a
suitable configured or compatible startup model. The compatible RouteKit
catalog remains available through the native model picker, so interactive users
can switch models without restarting the client.

Supplying an exact `provider/model` pins the startup route. Use that form for
automation, reproducible runs, and one-off comparisons. Codex is
Responses-only, so its picker hides obvious OpenRouter chat-only models using a
best-effort reasoning-capability heuristic. The exact supported builds are
Codex CLI `0.146.0` and Claude Code `2.1.216` or `2.1.220`; see
[client compatibility](routekit-supported-clients.md).

`--effort` validates the opaque effort id against the selected model's
discovered reasoning metadata, then projects it into the tool:

- Codex writes `model_reasoning_effort` into the generated config.
- Claude Code launches with its native `--effort <level>` selector; RouteKit
  forwards adaptive thinking and the selected effort to the routed provider.

Claude Code uses its native selector; RouteKit emits one base model per route.
Unknown or unsupported efforts fail before provider routing.

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
Codex receives one named `routekit` profile, never a default-provider or default-
model change. Launch `codex --profile routekit` and use its RouteKit-backed model
picker. Claude receives RouteKit-managed native `availableModels` entries from
the policy-filtered catalog, so its normal `/model` picker lists RouteKit
models without gateway-discovery aliases. Each install issues a dedicated data
token and stores it in macOS Keychain (or a private `0600` RouteKit secret file
elsewhere). Codex and Claude retrieve it on demand through their native
credential-helper settings, so terminal, IDE, and GUI launches need no shell
configuration. The plaintext is never written to client configuration, install
output, or the integration registry. Reinstalling the same target updates
configuration without revealing or replacing the token; pass `--rotate-token`
to rotate it. Claude's `--bare` mode intentionally ignores normal user settings,
including `apiKeyHelper`; use a normal launch or pass its settings file
explicitly. Uninstall revokes the tracked dedicated token.
Automation that manages the client environment separately can use `--no-token`:
it updates only RouteKit-owned client configuration and neither issues, rotates,
revokes, persists, nor registers a gateway credential. `--no-token` cannot be
combined with `--rotate-token`.

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
routekit setup
routekit config init
routekit config init --provider anthropic
routekit config init --empty
routekit config show
routekit config path
routekit config edit
routekit config import --from .routekit/router.yaml
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
routekit calls show <call-id>
routekit calls show <call-id> --json
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
| `--remote <name>` | Target a enrolled remote gateway. |
| `--local` | Force the local daemon when a remote is selected. |

## Environment variables

| Variable | Meaning |
| --- | --- |
| `ROUTEKIT_HOME` | Runtime state directory (default `~/.routekit`). |
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
