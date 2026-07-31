# @velum-labs/routekit-gateway

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
