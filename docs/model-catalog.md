# Model catalog

Provider activation, live model discovery, and dispatch belong to RouteKit.
Enable providers in `~/.config/routekit/router.yaml` (or a project file you
import explicitly); do not copy individual models into configuration:

```yaml
providers:
  openai: {}
  anthropic: {}
  codex:
    strategy: capacity_weighted
    switchThreshold: 0.9
defaultModel: openai/gpt-5.5
```

Every configured provider authenticates and discovers models at startup.
RouteKit publishes the merged catalog with source-qualified IDs and strips the
source prefix before upstream egress. An optional `modelPolicy` filters these
canonical IDs after live discovery and before aliases or defaults are resolved:

```text
openai/gpt-5.5
anthropic/claude-sonnet-4-5
codex/gpt-5.6-sol
openrouter/moonshotai/kimi-k2-thinking
```

```yaml
modelPolicy:
  allow: ["openai/gpt-*", "openrouter/moonshotai/*"]
  deny: ["openrouter/*/preview"]
```

Policy globs are anchored to the full ID. Only `*` is special and it can span
`/`; all other characters are literal. The inclusive allowlist defaults to all
models when omitted or empty. A nonempty inclusive allowlist narrows the live
catalog, and the denylist subtracts from it with precedence. Excluded models
are absent and unroutable from every catalog-backed surface, including provider
status and native client pickers. Provider authentication and discovery still
run even when policy excludes all of that provider's models.

The singleton daemon owns `~/.config/routekit/router.yaml`. It never discovers
the project file by working directory. To inspect a project policy through
daemon-backed commands, first replace the canonical document explicitly:

```sh
routekit config import --from .routekit/router.yaml
routekit providers status
routekit models list
```

Import validates and atomically replaces the complete document; it does not
merge project and global configuration. `routekit doctor` validates the
effective daemon configuration and live catalog.

Use models from different vendors or families when you want decorrelated routing
options. RouteKit rejects unknown or unnamespaced model IDs instead of falling
back to the router default.

Amazon Bedrock models and inference profiles are discovered live in the
configured AWS account and region and use `bedrock/<native-id>` catalog IDs.
Availability and access vary by account, region, Marketplace/model-access state,
and IAM policy; cross-region inference profiles can invoke destination-region
models. Complete the [AWS Bedrock setup and evidence runbook](aws-bedrock-setup.md)
before treating a catalog entry as live-qualified.

Subscription providers use the same catalog. RouteKit unions discovery results
from all enrolled accounts, records per-model eligibility, and selects only
among healthy accounts that advertise the requested model.

## Native client pickers

Canonical RouteKit IDs remain namespaced in configuration and APIs. Claude Code
accepts a unique bare native ID for direct use, while its installed picker uses
a reversible custom-model entry derived from the canonical route:

- `claude --model gpt-5.6-sol` resolves when exactly one policy-allowed route
  owns that native ID.
- Claude's `/model` picker lists
  `anthropic.routekit.codex/gpt-5.6-sol` for that canonical RouteKit route.
- Codex lists `codex/gpt-5.6-sol` as `gpt-5.6-sol`.

If more than one distinct provider route owns a native ID, Claude rejects the
bare spelling and names the canonical alternatives; it never applies provider
precedence. The request then uses RouteKit's server-owned account pool over the
provider-native protocol. Bare IDs are not accepted by the global OpenAI,
Cursor, or configuration surfaces.

## Inspecting routes

```sh
routekit models list
routekit models list --provider openai
routekit models info openai/gpt-5.5
routekit models info --json codex/gpt-5.6-sol
```

`models info` reports effective and native model IDs, provider, account class,
billing mode, default status, capabilities, and reasoning metadata without
printing credentials.
