# Configuration

RouteKit configuration is a single router document. The singleton daemon loads
exactly one canonical file; credentials stay outside YAML.

## Canonical router config

The standalone `routekit` CLI daemon uses exactly one canonical config:
`~/.config/routekit/router.yaml`. It does not vary routing policy by the
caller's working directory; that would make one gateway ambiguous when two
projects run concurrently. To migrate a project file into the daemon, replace
the canonical document explicitly:

```sh
routekit config import --from .routekit/router.yaml
```

The CLI has no alternate config selector. Embedders may pass one explicit
complete document to `@velum-labs/routekit-config`; no project discovery or
layering occurs. `config import` validates and atomically replaces the complete
canonical document.

## Scaffold

```sh
routekit setup
```

The guided setup explicitly selects one or more first-launch routes, performs
live API discovery before writing a fresh config, enrolls selected
subscriptions, and selects a default from the live catalog. API keys remain in
the caller environment.

For deterministic scripts:

```sh
routekit config init
routekit config init --provider anthropic
routekit config init --provider openrouter
routekit config init --provider bedrock --default-model bedrock/MODEL_ID
routekit config init --empty
```

The no-flag form retains the OpenAI starter. `--empty` creates the
subscription bootstrap used before `accounts login`.

## Provider map

Enable each provider explicitly. RouteKit obtains API URLs and credential
environment-variable names from its registry, performs live discovery at
startup, and publishes only namespaced model IDs:

```yaml
providers:
  openai: {}
  anthropic: {}
defaultModel: openai/gpt-5.5
```

The first-launch provider IDs include `openai`, `anthropic`, `openrouter`,
`bedrock`, `codex`, and `claude-code`. API providers read registry-defined
environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and
`OPENROUTER_API_KEY`. Bedrock instead uses the AWS SDK default credential chain;
configure its region, profile/role, least-privilege IAM policy, model access,
and operator preflight with the [AWS Bedrock setup guide](aws-bedrock-setup.md).
Optional provider-specific base URL variables avoid placing URLs in router
YAML; they do not expand the support contract beyond these named providers.
Registry presence is non-contractual and does not make a provider part of
RouteKit's public launch surface.

## Model policy

Use the optional top-level `modelPolicy` to limit the live discovered catalog:

```yaml
modelPolicy:
  allow:
    - openai/gpt-*
    - openrouter/moonshotai/*
  deny:
    - openai/gpt-*-preview
```

Rules match the complete canonical namespaced model ID. Only `*` is special; it
matches zero or more characters, including `/`. Every other character is
literal. An omitted or empty inclusive allowlist permits every discovered
model. A nonempty inclusive allowlist narrows the catalog, then the denylist
subtracts matches and always wins. Each rule must begin with a supported
provider namespace and have a nonempty model portion.

Policy runs after every configured provider authenticates and performs live
discovery, but before aliases and the default are finalized. Excluded models do
not appear in model lists, provider status, native client pickers, or routing.
An excluded configured `defaultModel` or `modelAliases` target makes startup
fail with a policy-specific error.

## Subscription pooling

Subscription providers are configured in the same map. Their policy controls
selection across every enrolled account:

```yaml
providers:
  claude-code:
    strategy: capacity_weighted
    switchThreshold: 0.9
  codex:
    strategy: capacity_weighted
    switchThreshold: 0.9
defaultModel: codex/gpt-5.6-sol
```

Log in one or more named accounts through RouteKit. Each login uses an isolated
temporary official-CLI profile, so it does not replace the user's normal Claude
Code or Codex login. The first enrollment adds the provider to the effective
config; no model or route is created manually:

```sh
routekit accounts login claude-code --name personal
routekit accounts login claude-code --name work
routekit accounts login codex --name primary
routekit accounts status
routekit models list
routekit claude claude-code/claude-sonnet-4-5
```

`routekit accounts add <kind> --name <label>` remains available for explicitly
importing the current official CLI login.

Startup discovers models from every healthy account and publishes their union
under one provider namespace. Requests are eligible only for accounts that
advertise the requested model. Quotas, refresh, cooldowns, and reset windows are
tracked per account; `sticky`, `round_robin`, and `capacity_weighted` select
among eligible accounts. A pooled exhaustion error is returned only when all
eligible accounts are unavailable.

## Usage leaderboard

Optional operator observability for shared gateways. Defaults match the
historical in-memory call attribution budget (1 000 records / 24 h). Enable
durable hourly rollups when you need history across daemon restarts:

```yaml
leaderboard:
  liveLimit: 5000
  liveTtlHours: 72
  durable: true
  durableRetentionDays: 14
```

Then inspect ranked usage:

```sh
routekit leaderboard
routekit leaderboard --by model --sort tokens --window 24h
```

Rollups land at `$ROUTEKIT_HOME/usage/leaderboard-rollups.v1.json` (mode `0600`)
and never store prompts, response bodies, or credentials.

## Compositional eval routing

`model: auto` evaluates requests against the published model-by-dimension evidence
matrix. This is the only automatic-routing architecture:

```yaml
classifierModel: openai/gpt-5.6-luna
compositionalRouting:
  maximumUnknownWeight: 0.25
  objective:
    kind: highest-quality
  minimumDimensionQuality:
    gateway-protocols: 0.70
  maximumFailureRate: 0.20
```

Automatic routing fails closed when the routing basis, classifier vector,
evidence matrix, live capabilities, or objective cannot support a decision.
Explicit model requests remain unchanged.

The classifier sees only the reviewed workload-dimension definitions and request text. Hard
requirements such as endpoint, tools, image input, and output limits are
derived from the request envelope. Model selection is then deterministic from
the request decomposition, published evidence, live model capabilities, and configured
objective.

Supported objectives are `highest-quality`, `lowest-cost`, `lowest-latency`,
`balanced`, and `pareto`. Cost-dependent objectives exclude models whose
required evidence is unpriced; unknown cost is never treated as zero.
`maximumUnknownWeight` controls how much of a request may fall outside the
reviewed routing basis.

The routing artifact is stored at
`$ROUTEKIT_HOME/eval/published-routing.json`; the previous complete
generation is retained as `published-routing.previous.json`.

## Loading

RouteKit rejects inline API keys, authorization headers, and tokens. The CLI
loads only the canonical global document. An embedding may explicitly pass one
complete document instead. Omitting a model selects `defaultModel` (or the first live model). Supplying an
unknown or unnamespaced model is an error and never falls through to that
default. If any configured provider cannot authenticate or discover models,
startup fails with a provider-specific diagnostic.

## Editing

```sh
routekit config show
routekit config edit
routekit providers add openrouter
routekit providers remove openrouter
```

Every mutation is validated and written atomically through the daemon control
plane.

## Runtime state

| Path | Purpose |
| --- | --- |
| `ROUTEKIT_HOME` (default `~/.routekit`) | Daemon records, secrets, subscriptions, usage. |
| `~/.routekit/secrets/data-token` | Gateway bearer token (mode `0600`). |
| `~/.routekit/subscriptions/<kind>/` | Enrolled subscription credentials. |
| `~/.routekit/usage/leaderboard-rollups.v1.json` | Optional durable leaderboard rollups (mode `0600`). |
| `~/.routekit/env/daemon.env` | Provider environment for supervised installs (mode `0600`). |

## Replacing a router file

RouteKit accepts only the current canonical provider schema. Import validates
the complete document before atomically replacing the singleton configuration:

```sh
routekit config import --from <router.yaml>
```
