# Continuing the RouteKit → Effect migration

This branch migrates RouteKit internals onto Effect. Product wire stays
`control.v2`, HTTP/SSE, CLI output, and persisted formats. Internal Promise
façades are not preserved: Effect is the implementation, and process boundaries
run a single `ManagedRuntime`.

## What is implemented

- Effect `4.0.0-rc.108` and `@effect/platform-node` are pinned in the pnpm
  catalog.
- `tooling/tsgo` isolates `@effect/tsgo` and TypeScript 7 from the TypeScript 6
  compiler used by package builds. `tsconfig.base.json` loads the Effect plugin,
  and `pnpm check` runs tsgo diagnostics. After `pnpm install`, run
  `pnpm tsgo:patch` because prepare hooks are disabled. Enable the TypeScript 7
  extension and workspace `js/ts.experimental.useTsgo`. Install
  `effectful-tech.effect-vscode` for fiber/context debugging.
- `@velum-labs/routekit-runtime/effect` owns one Node `ManagedRuntime` (Node
  services + Fetch `HttpClient`), AbortSignal interruption, tagged
  `RouteKitFailure`, leaf adapters, capacity leases, and single-flight helpers.
- Daemon bootstrap and the CLI invocation each construct one runtime and reuse
  it. Control handlers run through that runtime. Router generations start as
  Effect programs. Host rolling replacement is an Effect transaction.
- Eval contracts are Effect Schema. Eval store and eval egress are Effect
  programs (`FileSystem` / `HttpClient`). The gateway honors
  `x-routekit-eval-policy-bypass` and rejects auto-router model ids on that path.

## Verify

```bash
pnpm install
pnpm check
pnpm build
pnpm test
```

## Conventions

1. Keep `control.v2`, HTTP/SSE, CLI output, and persisted formats unchanged.
2. Construct one runtime per daemon, embedded host, or CLI invocation. Reuse it
   for requests and generations. Do not construct-and-dispose a runtime per call.
3. Preserve RouteKit-specific semantics rather than replacing them with generic
   Effect abstractions (process-group kill, durable journals, streaming lease
   lifetime, auth recovery surviving caller cancel, pre-publication rollback).
4. Effect owns lifetime, interruption, and coordination — not selection, retry,
   or failover policy.
5. Do not import `effect/testing` from production. Do not add Effect 3 packages
   (`@effect/cli`, `@effect/experimental`) that would duplicate Effect cores.
6. Prefer `Data.TaggedError`, Effect Schema at JSON boundaries, and
   `@effect/platform` `HttpClient` / `FileSystem` inside Effect programs.
   Node `http.Server` inbound listeners and Promise-level HTTP tests keep
   `fetch`; `globalFetchInEffect` is the enforced diagnostic.
