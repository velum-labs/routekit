# @velum-labs/routekit-eval-service

## 1.0.8

### Patch Changes

- @velum-labs/routekit-eval-contracts@1.0.8
- @velum-labs/routekit-eval-engine@1.0.8
- @velum-labs/routekit-eval-store@1.0.8
- @velum-labs/routekit-registry@1.0.8

## 1.0.7

### Patch Changes

- @velum-labs/routekit-eval-contracts@1.0.7
- @velum-labs/routekit-eval-engine@1.0.7
- @velum-labs/routekit-eval-store@1.0.7
- @velum-labs/routekit-registry@1.0.7

## 1.0.6

### Patch Changes

- @velum-labs/routekit-eval-contracts@1.0.6
- @velum-labs/routekit-eval-engine@1.0.6
- @velum-labs/routekit-eval-store@1.0.6
- @velum-labs/routekit-registry@1.0.6

## 1.0.5

### Patch Changes

- @velum-labs/routekit-eval-contracts@1.0.5
- @velum-labs/routekit-eval-engine@1.0.5
- @velum-labs/routekit-eval-store@1.0.5
- @velum-labs/routekit-registry@1.0.5

## 1.0.4

### Patch Changes

- @velum-labs/routekit-eval-contracts@1.0.4
- @velum-labs/routekit-eval-engine@1.0.4
- @velum-labs/routekit-eval-store@1.0.4
- @velum-labs/routekit-registry@1.0.4

## 1.0.3

### Patch Changes

- @velum-labs/routekit-eval-contracts@1.0.3
- @velum-labs/routekit-eval-engine@1.0.3
- @velum-labs/routekit-eval-store@1.0.3
- @velum-labs/routekit-registry@1.0.3

## 1.0.2

### Patch Changes

- @velum-labs/routekit-eval-contracts@1.0.2
- @velum-labs/routekit-eval-engine@1.0.2
- @velum-labs/routekit-eval-store@1.0.2
- @velum-labs/routekit-registry@1.0.2

## 1.0.1

### Patch Changes

- @velum-labs/routekit-eval-contracts@1.0.1
- @velum-labs/routekit-eval-engine@1.0.1
- @velum-labs/routekit-eval-store@1.0.1
- @velum-labs/routekit-registry@1.0.1

## 1.0.0

### Minor Changes

- 0e67bb3: Introduce the sole compositional eval-routing protocol, repository-scoped review artifacts and immutable plans, bounded eval sessions, atomic routing activation, and the public `routekit eval` workflow.
- 3e3effd: Add compositional eval routing as RouteKit's sole automatic-routing protocol.
  A model-blind classifier decomposes each request across a reviewed routing
  basis, while deterministic code combines that decomposition with hard request
  requirements, complete model-by-dimension evidence, and the user's quality,
  cost, latency, balanced, or Pareto objective.

  Expose the complete durable workflow through `routekit eval`: repository setup,
  one-question-at-a-time onboarding, workload-dimension and evaluation proposals,
  digest-bound review approvals, validation, immutable planning and estimates,
  scoped qualification runs, structured results, and atomic routing activation.
  Normal billed work uses RouteKit's configured local or remote target; explicit
  external gateways may qualify evidence but cannot activate it.

  Require complete manifest-bound comparison evidence, stable case identities,
  strict normalized request decompositions, conservative quality measurements,
  explicit unknown pricing, sanitized provenance, and fail-closed routing. Add
  scoped eval sessions with explicit model and output limits, atomic project and
  activation artifacts, and interruption-safe cleanup and reporting.

### Patch Changes

- 7a3a4aa: Make Effect the RouteKit application runtime: live layers now acquire daemon,
  gateway, telemetry, token, eval-session, and eval execution lifetimes instead
  of succeeding prebuilt coordinator bags. The daemon worker owns one
  ManagedRuntime, the cluster primary is an Effect supervision tree with
  Ref-owned generation publication, and standalone gateway façades dispose their
  own runtimes.

  Compose eval-service directly with the native EvalEngine and a streaming,
  interruptible Ori execution port. Keep vendored sources untouched, prevent
  application packages from launching a second Ori host, and preserve existing
  control.v2, HTTP/SSE, CLI, persisted, and published package contracts.

- Updated dependencies [79fe1c7]
- Updated dependencies [0e67bb3]
- Updated dependencies [abd64a0]
- Updated dependencies [3e3effd]
  - @velum-labs/routekit-registry@1.0.0
  - @velum-labs/routekit-eval-contracts@1.0.0
  - @velum-labs/routekit-eval-store@1.0.0
  - @velum-labs/routekit-eval-engine@1.0.0
