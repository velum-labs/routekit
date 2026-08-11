# `@velum-labs/routekit-testkit`

Private RouteKit test tooling for package tests and the E2E matrix.

This package is never published. It provides provider-simulator helpers, door
profiles, subprocess utilities, SSE parsing, and wrappers for real coding-agent
CLI runs.

```ts
import {
  DOOR_PROFILES,
  parseSse,
  reservePort,
  startProviderSim,
  waitForHttpReady
} from "@velum-labs/routekit-testkit";
```

The E2E matrix uses the package's typed Node HTTP simulator. It runs in-process
on an ephemeral loopback port, supports OpenAI Chat, Anthropic Messages, OpenAI
Responses, and Google GenAI JSON/SSE surfaces, and records every request in a
queryable journal. It requires no external executable, Python environment,
sibling checkout, network access, or provider key.

## Boundaries

- Keep production helpers in the package that owns the behavior under test.
- Keep testkit exports deterministic and local-only; tests must not require real provider keys.
- See `../../docs/testing.md` for matrix setup and optional-environment behavior.
