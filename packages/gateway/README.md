# @velum-labs/routekit-gateway

Product-neutral model routing and provider egress for RouteKit.

The package owns the `Backend` interface, HTTP gateway, OpenAI Chat,
Responses, Anthropic Messages and Cursor adapters, SSE handling, ACP support,
normalized call provenance, model catalogs, provider sources, and
provider-native egress. Canonical router configuration belongs to
`@velum-labs/routekit-config-core`.

At startup `RoutingBackend` authenticates every explicitly configured provider,
performs live model discovery, and publishes source-qualified
`provider/model` IDs. Dispatch removes the source prefix before provider-native
egress. An unavailable provider fails startup rather than silently shrinking
the catalog.

```ts
import {
  RoutingBackend,
  startGateway
} from "@velum-labs/routekit-gateway";
import { parseRouterConfig } from "@velum-labs/routekit-config-core";
```

API-key providers use registry-defined credentials and URLs. Multi-account
subscription providers and relays are in `@velum-labs/routekit-accounts`; they expose the
same source interface with per-model account eligibility and quota-aware
selection. RouteKit hosts wire this package into the singleton daemon gateway.
