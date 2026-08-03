# `@velum-labs/routekit-cli-core`

Brand-neutral CLI primitives shared by RouteKit command packages.

This package owns command context, global flags, structured CLI errors, option
parsers, completion generation, package-version helpers, interactive pickers,
and test helpers. It depends on Commander and `@velum-labs/routekit-cli-ui`,
but it does not own RouteKit product commands, daemon state, provider logic, or
terminal copy.

```ts
import {
  CliError,
  attachGlobalFlags,
  contextFor,
  parsePort,
  readPackageVersion
} from "@velum-labs/routekit-cli-core";
```

Use `@velum-labs/routekit-cli-core/testing` for process-level CLI tests:

```ts
import { runCliForTest, withEnvironment } from "@velum-labs/routekit-cli-core/testing";
```

## Boundaries

- Command implementations live in product packages such as `@velum-labs/routekit`.
- Renderer components live in `@velum-labs/routekit-cli-ui`.
- Service lifecycle and filesystem primitives live in `@velum-labs/routekit-runtime`.

