# Continuing the RouteKit → Effect migration

This branch contains the first compatibility-safe Effect slice. It does **not**
convert RouteKit's daemon, router, gateway, accounts, or CLI yet.

## What is implemented

- Effect `4.0.0-rc.108` and `@effect/platform-node` are pinned in the pnpm
  catalog.
- `@velum-labs/routekit-runtime/effect` is a new published subpath.
- A Node-backed `ManagedRuntime` boundary:
  - `makeRouteKitRuntime`
  - `runRouteKitEffect`
  - `runRouteKitEffectExit`
- `withAbortSignal`, which interrupts only the caller's Effect run.
- Promise-boundary error helpers:
  - `throwRouteKitExit`
  - `routeKitError`
- `EffectDocumentStore`, an Effect façade over the existing versioned,
  atomic document store.
- `superviseSpawnEffect`, an Effect façade over RouteKit's existing detached
  process-group supervisor.
- Wave 1 runtime leaf adapters:
  - `EffectResourceScope` (LIFO, transfer, borrowed vs owned, shutdown budget)
  - `registerCleanupEffect` / `runCleanupsEffect` over the process-wide registry
  - `writeFileAtomicEffect`, `tryAcquireFileLockEffect`, and
    `ensureRunOutputDirEffect` on Effect `FileSystem` / `Path`
  - `makeSingleFlight` (`SynchronizedRef` + `Deferred`)
  - test-clock convention: fork, provide `TestClock.layer()`, `adjust`, then join
- Runtime tests covering runtime disposal, exits, cancellation, resource-scope
  parity, cleanup, atomic files, missing-vs-corrupt documents, single-flight,
  and test-clock sleeps.
- Wave 2 accounts and coordination:
  - `EffectAccountActivityCoordinator` (debounced persist, scoped attempt leases)
  - `EffectAccountAuthCoordinator` (owner/waiter; recovery survives waiter cancel)
  - `EffectRateLimitTracker` (process-wide shared cooldown state)
  - `EffectCapacityPool` scoped leases with exactly-once release

## Verify the current slice

The VM has Node `22.22.2` and pnpm `11.15.1` available:

```bash
pnpm install
pnpm --filter @velum-labs/routekit-runtime build
pnpm --filter @velum-labs/routekit-runtime test
```

The full repository gates are:

```bash
pnpm check
pnpm build
pnpm test
pnpm verify
```

If pnpm reports an ignored build script, keep the workspace
`allowBuilds.msgpackr-extract: false` entry (the repository intentionally uses
`ignore-scripts=true`).

## Conventions for the next slices

1. Keep wire/domain contracts and public Promise/`AbortSignal` façades plain.
2. Do not expose `Effect`, `Layer`, `Scope`, `Cause`, `Stream`, or unstable
   Effect module types through the root package declarations.
3. Construct one runtime per daemon, embedded application, or CLI invocation.
   Reuse it for requests and generations.
4. Preserve RouteKit-specific semantics rather than replacing them with
   generic Effect abstractions:
   - process-group termination (including grandchildren);
   - durable crash-recovery journals;
   - streaming lease lifetime and exactly-once release;
   - shared auth recovery surviving caller cancellation;
   - rate-limit state shared across overlapping generations;
   - pre-publication rollback versus post-publication retirement.
5. Do not change persisted formats, `control.v2`, HTTP/SSE behavior, CLI
   output, or exit codes in the same migration slice.

## Recommended next implementation order

### Wave 1: runtime leaf adapters (done)

- Parity tests and an Effect implementation for `ResourceScope` and
  process-wide cleanup.
- Effect filesystem/path ports that keep atomic-write and corrupt-versus-missing
  behavior.
- Reusable `SynchronizedRef`/`Deferred` single-flight helpers.
- Effect test-clock conventions for timer-heavy code.

### Wave 2: accounts and coordination (done)

- Activity coordinator and debounced persistence.
- Auth-health owner/waiter state machine.
- Daemon-scoped rate-limit registry.
- Capacity-pool leases.

Keep the existing selection and retry/failover algorithms; Effect should own
resource lifetime, interruption, and coordination, not redefine policy.

### Wave 3: account-set and provider lifecycle

- Scoped account-set construction and probe fibers.
- Composite request leases.
- Web-stream lease-lifetime bridge.
- Provider client lifecycle/discovery adapters.

### Wave 4: router and daemon

- Effect-native router-generation constructor in a child scope.
- Daemon runtime-state mutation coordinator.
- Ordinary daemon root scope and shutdown.
- Sidecar supervisor.

### Wave 5: generation transactions and host workers

Model generation replacement as an explicit prepare/validate/persist/commit/
retire transaction. Do not replace it with `ScopedRef` alone. Migrate host
rolling replacement only after direct failure-injection tests exist.

### Wave 6: control, gateway, harness, and CLI

- Effect control handlers behind unchanged `control.v2`.
- Provider egress and gateway ownership before streaming.
- Harness process/session internals.
- New `eval` and `policy` commands through Effect CLI first.
- Migrate the Commander root last, after CLI parity tests.

## Eval integration boundary

Do not copy the standalone eval repository wholesale. Extract:

```text
packages/eval-contracts   # plain versioned run/result/evidence contracts
packages/eval-core         # Effect execution and aggregation
packages/eval-store        # immutable raw runs and published snapshots
apps/eval-worker           # isolated worker process and JSONL protocol
```

Candidate and judge calls should use a dedicated RouteKit token, explicit
model IDs, attribution metadata, and a policy-bypass flag so evaluation cannot
recursively invoke the auto-router. The online request path must never run
evaluations or read mutable evaluation history.

## Before changing the Effect version

The selected pin is the Effect v4 release candidate `4.0.0-rc.108`, while the
standalone checkout currently uses an older beta line. Normalize the complete
Effect/platform graph first, reject duplicate Effect cores in CI, and then
qualify the standalone offline suite. Treat Effect v4 RC APIs as unstable
until the project standardizes on a final release.

