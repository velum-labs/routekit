# Host contract

This product exposes a process-independent library API for hosts such as
RouteKit, plus the existing measurement CLI for compatibility. Hosts import
`@velum-labs/routekit-eval-engine/authoring`; they do not import private
TypeScript under `src/`.

The contract is additive. Required field or exit-code changes bump
`protocolVersion`.

## Library

`createEvalAuthoring(runtime)` returns `prepare`, `run`, `answer`, `status`,
`manifest`, and `skill`. Every operation returns a plain Promise and
JSON-compatible data; no Effect type crosses the package boundary.

The default `runAuthorTurn` adapter directly runs Ori's production headless
author session with an isolated environment, home/state root, and captured CLI
IO. It may spawn the selected provider harness. The skill's `ori eval` command
is an Ori-owned shim to `eval-tool.mjs`, a minimal worker that calls the
production eval command and node:test pipeline without launching the Ori CLI.
`stateRoot`, `environment`, `clock`, repository resolution, credential checks,
author execution, and the eval-worker command remain injectable.

The library controller does not inspect host argv, write host process stdio,
mutate host process environment, set an exit code, or execute the Ori
executable. It reuses the same collection prompt, create-eval skill, headless
author runtime, eval execution, private workspace, state, lock, mutation audit,
eval-record aggregation, and reporting logic as the CLI controller.

## Process

Callers run `ori-eval-system`. They do not invoke bun. Isolate the process:

| Env | Role |
| --- | --- |
| `HOME` | Private directory. Credentials and `~/.ori` stay here. |
| `OPENROUTER_API_KEY` | Host-owned credential. Sufficient for auth; do not run `login`. |
| `ORI_EVAL_API_BASE_URL` | OpenAI-compatible API origin. Default `https://openrouter.ai/api`. |
| `ORI_EVAL_RUNTIME_CACHE` | Optional private Node-runtime cache. |
| `ORI_TELEMETRY` | Set `0` unless the host wants Ori telemetry. |

When `ORI_EVAL_API_BASE_URL` is set and `ANTHROPIC_BASE_URL` is not, the
process copies the origin onto `ANTHROPIC_BASE_URL` so Claude follows the host
gateway. Catalog and endpoint fetches use `{origin}/v1/models`. Pi's
`models.json` `providers.openrouter.baseUrl` is `{origin}/v1` when the origin
is not the OpenRouter default. A user-set Pi `baseUrl` is left alone.

Do not run `ori-eval-system login` from a host. An environment key is the
credential. `login` writes `~/.ori/credentials.json` under `HOME`.

## Spawn protocol

`ori-eval-system --json spawn <command> …`

Spawn prints one JSON document to stdout. It does not use Effect CLI envelopes.

| Command | Purpose |
| --- | --- |
| `skill` | Markdown skill text (not JSON) |
| `manifest` | Protocol version, default harness/models, skill digests, host seam |
| `prepare` | Create or resume a durable run |
| `run` | One author turn |
| `answer` | Append the user's answer and run again |
| `status` | Read durable state |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, including `action-required` and `stopped` |
| `2` | Usage error or `auth-required` |
| `3` | Lock conflict or failed run |
| `75` | `waiting` — relay `question` and call `answer` |

### `manifest`

Required keys: `ok`, `protocolVersion`, `harness`, `authorHarnesses`,
`runModel`, `judgeModel`, `skills`, `host`.

`host.apiBaseUrl` is the origin this process will call. `host.credential` is
`environment` when `OPENROUTER_API_KEY` is set, otherwise `missing`.
`host.apiBaseUrlEnv` is `ORI_EVAL_API_BASE_URL`. `host.credentialEnv` is
`OPENROUTER_API_KEY`.

### `prepare`

`--request` / `--request-file`, `--repo`, `--harness pi\|claude\|codex`,
`--existing resume\|archive\|stop`.

Statuses: `prepared`, `action-required`, `stopped`, `error`.

### `run` / `answer`

`waiting` includes `context`, `question`, `tag`. `completed` / `failed` include
`attempt`, `attemptTotals`, `evalRunTotals`, and `sourceTree`. Recoverable
provider failures add `providerFailure`.

## What the host must not do

- Import `src/` or `src/vendor/` instead of the package root
- Answer interview questions for the user
- Invent costs, models, or results
- Point this process at a gateway that is not OpenAI-compatible at
  `{origin}/v1/models` until that seam is extended
