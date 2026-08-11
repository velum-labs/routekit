# `@velum-labs/routekit-config-core`

Neutral ownership boundary for RouteKit configuration schemas and reusable
configuration primitives.

This package owns the canonical `RouterConfig` schema, defaults, validation,
and normalization, plus layered value resolution and JSON read/write helpers.

```ts
import {
  editConfig,
  parseRouterConfig,
  readValidatedJson,
  resolveLayer,
  writeJsonAtomic
} from "@velum-labs/routekit-config-core";

const config = parseRouterConfig({
  providers: { openai: {} },
  defaultModel: "openai/gpt-5.5"
});
```

`writeJsonAtomic()` creates parent directories and writes through
`@velum-labs/routekit-runtime`'s atomic file helper.

## Boundaries

- RouteKit router YAML discovery and atomic writes live in `@velum-labs/routekit-config`.
- Gateway and router implementations consume this package; configuration does
  not import either implementation layer.
- Runtime file, lock, process, and URL helpers live in `@velum-labs/routekit-runtime`.
- Product-specific config schemas belong to the package that owns that product surface.
