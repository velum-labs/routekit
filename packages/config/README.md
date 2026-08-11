# @velum-labs/routekit-config

`packages/config` publishes `@velum-labs/routekit-config`: reusable RouteKit
router-config loading, provider validation, live-model selection, and atomic
writes.

## Resolution

`loadRouterConfig()` loads the canonical
`~/.config/routekit/router.yaml`, or one explicit complete document when an
embedding supplies `configPath`. Configuration rejects inline credentials;
providers obtain credential and optional base-URL environment-variable names
from `@velum-labs/routekit-registry`.

```ts
import {
  assertModelsAvailable,
  configuredProviderIds,
  loadRouterConfig,
  resolveModelId,
  writeRouterConfig
} from "@velum-labs/routekit-config";

const loaded = loadRouterConfig();
const providers = configuredProviderIds(loaded.config);
const liveModels = ["openai/gpt-5.5"];
const model = resolveModelId(loaded.config, liveModels);
assertModelsAvailable([model], liveModels);
```

`configuredProviderIds()` preserves declaration order. `missingModelIds()` and
`assertModelsAvailable()` compare configured model requirements with a
discovered live catalog. `resolveModelId()` validates an
explicit namespaced model, or selects the configured default/first live model
only when none was requested. Explicit unknown models are rejected; they never
fall through to the default. `writeRouterConfig()` and `updateRouterConfig()`
validate before atomically writing mode-0600 YAML.

## Docs

- Configuration reference: [../../docs/configuration.md](../../docs/configuration.md)
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
