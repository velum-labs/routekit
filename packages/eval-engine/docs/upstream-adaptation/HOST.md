# Host contract

This product is a measurement binary. A later host (RouteKit, a model router)
spawns `routekit-eval-engine` and drives JSON. It does not import this TypeScript.

The contract is additive. Required field or exit-code changes bump
`protocolVersion`.

## Process

Callers run `routekit-eval-engine`. They do not invoke bun. Isolate the process:

| Env | Role |
| --- | --- |
| `HOME` | Private directory. Credentials and `~/.routekit-eval` stay here. |
| `ROUTEKIT_EVAL_BEARER_TOKEN` | Host-owned credential. Sufficient for auth; do not run `login`. |
| `ROUTEKIT_EVAL_INFERENCE_ORIGIN` | OpenAI-compatible API origin. Default `http://127.0.0.1:8080`. |
| `ROUTEKIT_EVAL_RUNTIME_CACHE` | Optional private Node-runtime cache. |
| `ROUTEKIT_EVAL_TELEMETRY` | Set `0` unless the host wants RouteKit Eval telemetry. |

When `ROUTEKIT_EVAL_INFERENCE_ORIGIN` is set and `ANTHROPIC_BASE_URL` is not, the
process copies the origin onto `ANTHROPIC_BASE_URL` so Claude follows the host
gateway. Catalog and endpoint fetches use `{origin}/v1/models`. Pi's
`models.json` `providers.gateway.baseUrl` is `{origin}/v1` when the origin
is not the Gateway default. A user-set Pi `baseUrl` is left alone.

Do not run `routekit-eval-engine login` from a host. An environment key is the
credential. `login` writes `~/.routekit-eval/credentials.json` under `HOME`.

## Spawn protocol

`routekit-eval-engine --json spawn <command> …`

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

`host.inferenceOrigin` is the origin this process will call. `host.credential` is
`environment` when `ROUTEKIT_EVAL_BEARER_TOKEN` is set, otherwise `missing`.
`host.inferenceOriginEnv` is `ROUTEKIT_EVAL_INFERENCE_ORIGIN`. `host.credentialEnv` is
`ROUTEKIT_EVAL_BEARER_TOKEN`.

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
