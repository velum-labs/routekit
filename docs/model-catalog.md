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
source prefix before upstream egress:

```text
openai/gpt-5.5
anthropic/claude-sonnet-4-5
codex/gpt-5.5
openrouter/moonshotai/kimi-k2-thinking
```

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

Canonical RouteKit IDs remain namespaced everywhere. A matching native client
gets a door-local display alias so its own subscription models look normal:

- Claude Code lists `claude-code/claude-sonnet-4-6` as
  `claude-sonnet-4-6`.
- Codex lists `codex/gpt-5.5` as `gpt-5.5`.

Models owned by other providers stay source-qualified in either picker. Both a
bare picker alias and the corresponding namespaced ID resolve to the same
canonical catalog entry. The request then uses RouteKit's server-owned account
pool over the provider-native protocol. Bare IDs are not accepted by the
global OpenAI, Cursor, or configuration surfaces.

## Inspecting routes

```sh
routekit models list
routekit models list --provider openai
routekit models info openai/gpt-5.5
routekit models info --json codex/gpt-5.5
```

`models info` reports effective and native model IDs, provider, account class,
billing mode, default status, capabilities, and reasoning metadata without
printing credentials.
