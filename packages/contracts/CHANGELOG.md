# @velum-labs/routekit-contracts

## 1.0.17

## 1.0.16

## 1.0.15

## 1.0.14

## 1.0.13

## 1.0.12

## 1.0.11

## 1.0.10

## 1.0.9

## 1.0.8

## 1.0.7

## 1.0.6

## 1.0.5

## 1.0.4

## 1.0.3

## 1.0.2

## 1.0.1

## 1.0.0

### Major Changes

- 79fe1c7: Remove retired compatibility surfaces and introduce explicit resource ownership,
  transactional router generations and remote enrollment, and cancellation-safe
  harness sessions. Move router configuration ownership into config-core, add
  validated provider boundary codecs and streaming, decompose routing and HTTP
  endpoints into explicit ports, make daemon/CLI application services declarative,
  and enforce intentional package APIs in CI.

### Minor Changes

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

## 0.18.2

## 0.18.1

## 0.18.0

## 0.17.4

### Patch Changes

- d42282c: Add a persisted credential-authentication state machine for managed
  subscriptions. Coalesce refresh and probation, reroute pre-commit failures to
  healthy accounts, distinguish credential-, model-, and request-scoped denials,
  surface upstream authentication readiness, and map permanent rejection versus
  temporary recovery to actionable gateway errors.

## 0.17.3

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.9

## 0.16.8

## 0.16.7

## 0.16.6

## 0.16.5

### Patch Changes

- 448e004: Add shared reasoning-effort model variants for Claude Code and Cursor, and
  route validated `--effort` selections through every current launcher.

  Claude Code discovery now advertises `<base>:<effort>` picker entries from
  provider-discovered capabilities, normalizes them to the unsuffixed base model,
  and applies request-scoped adaptive thinking plus `output_config.effort` on
  both native relay and translated routes. Unsupported qualified ids fail before
  any provider call. Direct `routekit claude --effort` and `routekit cursor
--effort` no longer drop a validated selection.

## 0.16.4

## 0.16.3

## 0.16.2

## 0.16.1

## 0.16.0

## 0.15.1

## 0.15.0

### Minor Changes

- 5cd0e8c: improvements
