# Continuing the RouteKit → Effect migration

This branch migrates RouteKit internals onto Effect behind unchanged Promise
façades, `control.v2`, HTTP/SSE, CLI output, and persisted formats.

## What is implemented

- Effect `4.0.0-rc.108` and `@effect/platform-node` are pinned in the pnpm
  catalog.
- `@velum-labs/routekit-runtime/effect` is a published subpath with a Node
  `ManagedRuntime`, AbortSignal interruption, leaf adapters, capacity leases,
  and single-flight helpers.
- `@velum-labs/routekit-accounts/effect` covers activity, auth recovery,
  rate-limit state, scoped account-set construction, composite request leases,
  the web-stream lease-lifetime bridge, and provider discovery.
- `@velum-labs/routekit-router/effect` starts a router generation in a child
  scope.
- `@velum-labs/routekit-daemon/effect` covers runtime-state mutation
  serialization, ordinary shutdown, the sidecar supervisor, generation
  transactions, and host rolling replacement.
- `@velum-labs/routekit-control/effect` adapts Effect handlers to unchanged
  `control.v2` Promise handlers.
- `@velum-labs/routekit-gateway/effect` owns gateway listener lifetime before
  streaming.
- `@velum-labs/routekit-harness-core/effect` owns turn and session leases.
- `eval` and `policy` CLI commands run through Effect programs first; the
  Commander root is unchanged.
- Eval packages: `@velum-labs/routekit-eval-contracts`,
  `@velum-labs/routekit-eval-core`, `@velum-labs/routekit-eval-store`, and
  `apps/eval-worker`.

## Verify

```bash
pnpm install
pnpm check
pnpm build
pnpm test
```

## Conventions

1. Keep wire/domain contracts and public Promise/`AbortSignal` façades plain.
2. Do not expose `Effect`, `Layer`, `Scope`, `Cause`, `Stream`, or unstable
   Effect module types through the root package declarations.
3. Construct one runtime per daemon, embedded application, or CLI invocation.
   Reuse it for requests and generations.
4. Preserve RouteKit-specific semantics rather than replacing them with
   generic Effect abstractions.
5. Do not change persisted formats, `control.v2`, HTTP/SSE behavior, CLI
   output, or exit codes in the same migration slice.
6. Effect owns lifetime, interruption, and coordination — not selection,
   retry, or failover policy.

## Wave status

- Wave 1 runtime leaf adapters: done
- Wave 2 accounts coordination: done
- Wave 3 account-set and provider lifecycle: done
- Wave 4 router and daemon: done
- Wave 5 generation transactions and host workers: done
- Wave 6 control, gateway, harness, and CLI: done
- Eval integration packages: done
