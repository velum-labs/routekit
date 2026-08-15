# Host contract

This product is a measurement binary. A later host (RouteKit, a model router)
spawns `ori-eval-system` and drives JSON. It does not import this TypeScript.

The contract is additive. Required field or exit-code changes bump
`protocolVersion`.

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

- Import `src/` or `src/vendor/` as a library
- Answer interview questions for the user
- Invent costs, models, or results
- Point this process at a gateway that is not OpenAI-compatible at
  `{origin}/v1/models` until that seam is extended
