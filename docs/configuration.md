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

Project `.routekit/router.yaml` discovery remains part of the embeddable
`@velum-labs/routekit-config` / `@velum-labs/routekit-router` SDK contract.
`--config` and `ROUTEKIT_CONFIG` are recovery/foreground SDK paths, not
daemon-backed command scope selectors. `config import` validates and atomically
replaces the complete canonical document; it does not merge project and global
files. A sparse project overlay that relies on inherited SDK-global fields must
be expanded into a complete router document before import.

## Scaffold

```sh
routekit config init
```

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
The neutral registry may retain additional implementations for internal
compatibility, but registry presence is non-contractual and does not make a
provider part of RouteKit's public launch surface.

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
defaultModel: codex/gpt-5.5
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

## Precedence

RouteKit rejects inline API keys, authorization headers, and tokens. Its SDK
loads configuration with this precedence:

```text
explicit config path > ROUTEKIT_CONFIG > project .routekit/router.yaml > global config
```

Project and global files are layered when no explicit path is selected.
Omitting a model selects `defaultModel` (or the first live model). Supplying an
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
| `~/.routekit/env/daemon.env` | Provider environment for supervised installs (mode `0600`). |

## Migrating legacy router files

```sh
routekit config migrate
```

Run against an explicit `--config` path when recovering a legacy project file.
Known providers and account policies become provider entries; custom aliases,
pools, custom URLs, and custom credential variables are reported when they
cannot be represented. After migration, import the complete document into the
singleton when ready:

```sh
routekit config import --from <migrated-router.yaml>
```
