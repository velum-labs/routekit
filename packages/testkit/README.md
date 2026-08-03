# `@velum-labs/routekit-testkit`

Private RouteKit test tooling for package tests and the E2E matrix.

This package is never published. It provides provider-simulator helpers, door
profiles, subprocess utilities, SSE parsing, optional Python simulator
detection, and wrappers for real coding-agent CLI runs.

```ts
import {
  DOOR_PROFILES,
  parseSse,
  reservePort,
  startProviderSim,
  waitForHttpReady
} from "@velum-labs/routekit-testkit";
```

The E2E matrix uses these helpers to run against a local OpenAI-compatible
simulator when `routekit-sim` is available. Suites self-skip when the simulator
or stack tooling is absent.

## Boundaries

- Keep production helpers in the package that owns the behavior under test.
- Keep testkit exports deterministic and local-only; tests must not require real provider keys.
- See `../../docs/testing.md` for matrix setup and skip behavior.

