# @velum-labs/routekit-gateway

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
