# Architecture glossary

These are the ownership terms used by code, reviews, dependency rules, and
agent instructions.

| Term | Meaning | Canonical files |
| --- | --- | --- |
| **service** | An Effect-owned capability with one lifecycle owner. Services use one shallow `src/services/<service>/service.ts` directory. | [`packages/daemon/src/services/eval-session/service.ts`](../../packages/daemon/src/services/eval-session/service.ts), [`packages/gateway/src/services/gateway/service.ts`](../../packages/gateway/src/services/gateway/service.ts) |
| **store** | Durable or in-memory state access. A store does not become a service unless it owns a capability lifecycle. | [`packages/eval-store/src/store.ts`](../../packages/eval-store/src/store.ts), [`packages/eval-store/src/routing-activation.ts`](../../packages/eval-store/src/routing-activation.ts) |
| **protocol** | Canonical schemas and wire values shared across a boundary. `control.v2` is the current control protocol. | [`packages/control/src/protocol.ts`](../../packages/control/src/protocol.ts), [`packages/eval-contracts/src/index.ts`](../../packages/eval-contracts/src/index.ts) |
| **adapter** | Translation between a protocol or platform API and a service. An adapter does not own domain state. | [`packages/control/src/effect/handlers.ts`](../../packages/control/src/effect/handlers.ts), [`packages/gateway/src/adapters/responses.ts`](../../packages/gateway/src/adapters/responses.ts) |
| **façade** | A thin published root or named subpath that re-exports its owned public surface. Internal code imports precise files or named Runtime subpaths instead. | [`packages/runtime/src/index.ts`](../../packages/runtime/src/index.ts), [`packages/runtime/src/filesystem-api.ts`](../../packages/runtime/src/filesystem-api.ts) |
| **eval-engine** | The offline evaluation implementation. ENG-814 does not change it, and production code reaches it only through eval-service. | [`packages/eval-engine/README.md`](../../packages/eval-engine/README.md), [dependency rule](../../.dependency-cruiser.mjs) |
| **eval-service** | The Effect composition that validates manifests, estimates and runs comparisons, builds evidence, and publishes activation through eval-store. | [`packages/eval-service/src/service.ts`](../../packages/eval-service/src/service.ts), [`packages/eval-service/src/production-runner.ts`](../../packages/eval-service/src/production-runner.ts) |
| **activation** | The published compositional routing value named `PublishedRoutingActivation`. Publication is atomic after all required comparisons succeed. | [`packages/eval-contracts/src/index.ts`](../../packages/eval-contracts/src/index.ts), [`packages/gateway/src/routing/compositional.ts`](../../packages/gateway/src/routing/compositional.ts) |
| **profile (deleted)** | The retired v1 routing-profile protocol. `RoutingProfile`, `CompiledRoutingPolicy`, `PublishedRoutingSnapshot`, and `ROUTING_SNAPSHOT_VERSION` must not compile or return. | [`scripts/check-repo.mjs`](../../scripts/check-repo.mjs) |
| **auto** | Gateway compositional routing selected by `model: "auto"`. It uses the classifier, eval-policy, and the current activation. | [`packages/gateway/src/routing/classifier.ts`](../../packages/gateway/src/routing/classifier.ts), [`packages/gateway/src/routing/eval-policy.ts`](../../packages/gateway/src/routing/eval-policy.ts) |
