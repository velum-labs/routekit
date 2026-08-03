# `@velum-labs/routekit-router`

Reusable RouteKit router composition for embedded and standalone gateways.

This package opens subscription account sets, wires account-backed provider
sources into `@velum-labs/routekit-gateway`, applies bind/auth policy from
`@velum-labs/routekit-runtime`, and returns a running gateway with model,
status, usage, and reset-credit helpers.

```ts
import { startRouter } from "@velum-labs/routekit-router";

const router = await startRouter({
  config,
  authToken: token
});
```

`startRouter()` defaults to `127.0.0.1`, requires an auth token before binding
non-loopback addresses, and rejects configured subscription providers that have
no enrolled account unless the caller supplies an explicit source override.

## Boundaries

- Wire adapters, provider catalogs, and HTTP serving live in `@velum-labs/routekit-gateway`.
- Subscription credentials, quotas, relays, and usage snapshots live in `@velum-labs/routekit-accounts`.
- Singleton daemon control, generations, and OS supervision live in `@velum-labs/routekit-daemon`.

