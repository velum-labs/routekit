# @velum-labs/routekit-gateway

## 0.18.2

### Patch Changes

- 55bf691: Add zero-downtime daemon worker restarts and upgrades behind a stable cluster
  host, including shared listener handoff, rollback-safe generation commits,
  worker/host status metadata, managed sidecar ownership, retirement draining,
  and rolling lifecycle telemetry.
- Updated dependencies [55bf691]
  - @velum-labs/routekit-runtime@0.18.2
  - @velum-labs/routekit-contracts@0.18.2
  - @velum-labs/routekit-registry@0.18.2
  - @velum-labs/routekit-tracing@0.18.2

## 0.18.1

### Patch Changes

- eb319e5: Discover Bedrock Opus 5 reasoning controls, translate selections to Bedrock
  Converse requests, and route profile-required foundation requests through an
  active inference profile.
- 88235cb: Keep OpenRouter metadata deadlines alive until pending requests settle so
  timeouts reliably reject instead of leaving unresolved model selection work.
  - @velum-labs/routekit-contracts@0.18.1
  - @velum-labs/routekit-registry@0.18.1
  - @velum-labs/routekit-runtime@0.18.1
  - @velum-labs/routekit-tracing@0.18.1

## 0.18.0

### Patch Changes

- 161c5c8: Fix ENG-737 by emitting OpenAI-compatible `tsc_` item IDs for translated
  `tool_search_call` responses so their history remains valid after a model switch.
- 0c1f18e: Repair legacy `ttc_` tool-search item IDs when replaying existing conversation
  history to native OpenAI Responses destinations.
  - @velum-labs/routekit-contracts@0.18.0
  - @velum-labs/routekit-registry@0.18.0
  - @velum-labs/routekit-runtime@0.18.0
  - @velum-labs/routekit-tracing@0.18.0

## 0.17.4

### Patch Changes

- d42282c: Add a persisted credential-authentication state machine for managed
  subscriptions. Coalesce refresh and probation, reroute pre-commit failures to
  healthy accounts, distinguish credential-, model-, and request-scoped denials,
  surface upstream authentication readiness, and map permanent rejection versus
  temporary recovery to actionable gateway errors.
- 065aeea: Allow Codex conversations to switch between Claude, chat-based providers, and
  native Responses providers without failing on incompatible encrypted reasoning.
  RouteKit now preserves opaque reasoning only for its originating provider and
  native model while keeping the portable conversation and tool history intact.
- Updated dependencies [d42282c]
  - @velum-labs/routekit-contracts@0.17.4
  - @velum-labs/routekit-registry@0.17.4
  - @velum-labs/routekit-runtime@0.17.4
  - @velum-labs/routekit-tracing@0.17.4

## 0.17.3

### Patch Changes

- @velum-labs/routekit-contracts@0.17.3
- @velum-labs/routekit-registry@0.17.3
- @velum-labs/routekit-runtime@0.17.3
- @velum-labs/routekit-tracing@0.17.3

## 0.17.2

### Patch Changes

- 854dd1c: Use Claude Code's native custom-model picker and effort selector instead of
  advertising synthetic `claude-*` and effort-qualified RouteKit models. Claude
  can now route an unambiguous bare provider-native model id.
  - @velum-labs/routekit-contracts@0.17.2
  - @velum-labs/routekit-registry@0.17.2
  - @velum-labs/routekit-runtime@0.17.2
  - @velum-labs/routekit-tracing@0.17.2

## 0.17.1

### Patch Changes

- @velum-labs/routekit-contracts@0.17.1
- @velum-labs/routekit-registry@0.17.1
- @velum-labs/routekit-runtime@0.17.1
- @velum-labs/routekit-tracing@0.17.1

## 0.17.0

### Patch Changes

- @velum-labs/routekit-contracts@0.17.0
- @velum-labs/routekit-registry@0.17.0
- @velum-labs/routekit-runtime@0.17.0
- @velum-labs/routekit-tracing@0.17.0

## 0.16.9

### Patch Changes

- @velum-labs/routekit-contracts@0.16.9
- @velum-labs/routekit-registry@0.16.9
- @velum-labs/routekit-runtime@0.16.9
- @velum-labs/routekit-tracing@0.16.9

## 0.16.8

### Patch Changes

- @velum-labs/routekit-contracts@0.16.8
- @velum-labs/routekit-registry@0.16.8
- @velum-labs/routekit-runtime@0.16.8
- @velum-labs/routekit-tracing@0.16.8

## 0.16.7

### Patch Changes

- eabcc38: Retry managed Codex subscription requests when forced upstream SSE reports a terminal quota failure before output, while preserving structured stream errors and holding account capacity through body completion.
  - @velum-labs/routekit-contracts@0.16.7
  - @velum-labs/routekit-registry@0.16.7
  - @velum-labs/routekit-runtime@0.16.7
  - @velum-labs/routekit-tracing@0.16.7

## 0.16.6

### Patch Changes

- @velum-labs/routekit-contracts@0.16.6
- @velum-labs/routekit-registry@0.16.6
- @velum-labs/routekit-runtime@0.16.6
- @velum-labs/routekit-tracing@0.16.6

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

- Updated dependencies [448e004]
  - @velum-labs/routekit-contracts@0.16.5
  - @velum-labs/routekit-registry@0.16.5
  - @velum-labs/routekit-runtime@0.16.5
  - @velum-labs/routekit-tracing@0.16.5

## 0.16.4

### Patch Changes

- 485132e: Normalize overlong OpenAI Responses tool call IDs during provider egress.
  - @velum-labs/routekit-contracts@0.16.4
  - @velum-labs/routekit-registry@0.16.4
  - @velum-labs/routekit-runtime@0.16.4
  - @velum-labs/routekit-tracing@0.16.4

## 0.16.3

### Patch Changes

- @velum-labs/routekit-contracts@0.16.3
- @velum-labs/routekit-registry@0.16.3
- @velum-labs/routekit-runtime@0.16.3
- @velum-labs/routekit-tracing@0.16.3

## 0.16.2

### Patch Changes

- @velum-labs/routekit-contracts@0.16.2
- @velum-labs/routekit-registry@0.16.2
- @velum-labs/routekit-runtime@0.16.2
- @velum-labs/routekit-tracing@0.16.2

## 0.16.1

### Patch Changes

- @velum-labs/routekit-contracts@0.16.1
- @velum-labs/routekit-registry@0.16.1
- @velum-labs/routekit-runtime@0.16.1
- @velum-labs/routekit-tracing@0.16.1

## 0.16.0

### Minor Changes

- 8185e03: Keep direct OpenAI API requests to `/v1/responses` on the native Responses
  endpoint so reasoning, function tools, streaming, and response items remain
  lossless.

### Patch Changes

- @velum-labs/routekit-contracts@0.16.0
- @velum-labs/routekit-registry@0.16.0
- @velum-labs/routekit-runtime@0.16.0
- @velum-labs/routekit-tracing@0.16.0

## 0.15.1

### Patch Changes

- b8023ac: Prevent streamd gateway responses from retaining close listeners during backpressure.
  - @velum-labs/routekit-contracts@0.15.1
  - @velum-labs/routekit-registry@0.15.1
  - @velum-labs/routekit-runtime@0.15.1
  - @velum-labs/routekit-tracing@0.15.1

## 0.15.0

### Minor Changes

- 5cd0e8c: improvements
- d81a841: Add strict model catalog allowlist and denylist policy with live-catalog enforcement and field-level SDK config layering.

### Patch Changes

- Updated dependencies [5cd0e8c]
  - @velum-labs/routekit-contracts@0.15.0
  - @velum-labs/routekit-registry@0.15.0
  - @velum-labs/routekit-runtime@0.15.0
  - @velum-labs/routekit-tracing@0.15.0
