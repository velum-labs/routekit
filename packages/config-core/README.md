# `@velum-labs/routekit-config-core`

Small, reusable configuration primitives for JSON-backed tools.

This package provides layered value resolution, JSON read/write helpers,
validated parsing, legacy-to-current config migration, and edit/validate
utilities. It is intentionally schema-neutral: callers supply their own parser,
serializer, clone function, and error type.

```ts
import {
  editConfig,
  loadMigratingConfig,
  readValidatedJson,
  resolveLayer,
  writeJsonAtomic
} from "@velum-labs/routekit-config-core";
```

`writeJsonAtomic()` creates parent directories and writes through
`@velum-labs/routekit-runtime`'s atomic file helper. `loadMigratingConfig()`
keeps readable legacy config usable even when a migration write cannot be
completed.

## Boundaries

- RouteKit router YAML discovery and model validation live in `@velum-labs/routekit-config`.
- Runtime file, lock, process, and URL helpers live in `@velum-labs/routekit-runtime`.
- Product-specific config schemas belong to the package that owns that product surface.

