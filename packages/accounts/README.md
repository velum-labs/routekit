# @velum-labs/routekit-accounts

Provider-neutral subscription account pooling, credential sources, quota
tracking, relays, and account connectors. Only the first-launch set below is
public RouteKit support.

Account selection uses RouteKit provider policy, including sticky,
round-robin, capacity-weighted, health, quota, and cooldown behavior. Discovery
runs against every healthy account; the provider publishes the union of models
and tracks which accounts are eligible for each model.

The first-launch RouteKit subscription kinds are `claude-code` and `codex`.
They run the official provider login in isolated temporary state
(`captureLoginCredential`) before enrolling. Any number of named accounts may
join a provider; the first enrollment enables that provider in the effective
router config. The RouteKit tool command is still `routekit claude`; tool names
and subscription kinds are separate contracts.

Other registry entries and exported connector APIs are internal, unqualified,
and non-contractual; they are not RouteKit onboarding or support.

```ts
import { startGateway } from "@velum-labs/routekit-gateway";
import { startSubscriptionProxy } from "@velum-labs/routekit-accounts";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

const proxy = await runRouteKitEffect(
  startSubscriptionProxy({
    accounts: { "claude-code": { source: { kind: "directory", path: "~/.routekit/subscriptions/claude-code" } } },
    gatewayFactory: startGateway
  })
);
```

Retained connector state remains private under `ROUTEKIT_HOME`; credential
values are never printed.
