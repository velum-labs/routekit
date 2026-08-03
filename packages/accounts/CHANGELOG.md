# @velum-labs/routekit-accounts

## 0.18.2

### Patch Changes

- Updated dependencies [55bf691]
  - @velum-labs/routekit-gateway@0.18.2
  - @velum-labs/routekit-runtime@0.18.2
  - @velum-labs/routekit-contracts@0.18.2
  - @velum-labs/routekit-registry@0.18.2

## 0.18.1

### Patch Changes

- Updated dependencies [eb319e5]
- Updated dependencies [88235cb]
  - @velum-labs/routekit-gateway@0.18.1
  - @velum-labs/routekit-contracts@0.18.1
  - @velum-labs/routekit-registry@0.18.1
  - @velum-labs/routekit-runtime@0.18.1

## 0.18.0

### Patch Changes

- Updated dependencies [161c5c8]
- Updated dependencies [0c1f18e]
  - @velum-labs/routekit-gateway@0.18.0
  - @velum-labs/routekit-contracts@0.18.0
  - @velum-labs/routekit-registry@0.18.0
  - @velum-labs/routekit-runtime@0.18.0

## 0.17.4

### Patch Changes

- d42282c: Add a persisted credential-authentication state machine for managed
  subscriptions. Coalesce refresh and probation, reroute pre-commit failures to
  healthy accounts, distinguish credential-, model-, and request-scoped denials,
  surface upstream authentication readiness, and map permanent rejection versus
  temporary recovery to actionable gateway errors.
- Updated dependencies [d42282c]
- Updated dependencies [065aeea]
  - @velum-labs/routekit-contracts@0.17.4
  - @velum-labs/routekit-gateway@0.17.4
  - @velum-labs/routekit-registry@0.17.4
  - @velum-labs/routekit-runtime@0.17.4

## 0.17.3

### Patch Changes

- @velum-labs/routekit-contracts@0.17.3
- @velum-labs/routekit-gateway@0.17.3
- @velum-labs/routekit-registry@0.17.3
- @velum-labs/routekit-runtime@0.17.3

## 0.17.2

### Patch Changes

- Updated dependencies [854dd1c]
  - @velum-labs/routekit-gateway@0.17.2
  - @velum-labs/routekit-contracts@0.17.2
  - @velum-labs/routekit-registry@0.17.2
  - @velum-labs/routekit-runtime@0.17.2

## 0.17.1

### Patch Changes

- @velum-labs/routekit-contracts@0.17.1
- @velum-labs/routekit-gateway@0.17.1
- @velum-labs/routekit-registry@0.17.1
- @velum-labs/routekit-runtime@0.17.1

## 0.17.0

### Patch Changes

- @velum-labs/routekit-contracts@0.17.0
- @velum-labs/routekit-gateway@0.17.0
- @velum-labs/routekit-registry@0.17.0
- @velum-labs/routekit-runtime@0.17.0

## 0.16.9

### Patch Changes

- d2d787f: Parse Claude OAuth usage utilization values as percentages so the subscription pool
  can avoid accounts that are above its quota-switch threshold.
  - @velum-labs/routekit-contracts@0.16.9
  - @velum-labs/routekit-gateway@0.16.9
  - @velum-labs/routekit-registry@0.16.9
  - @velum-labs/routekit-runtime@0.16.9

## 0.16.8

### Patch Changes

- @velum-labs/routekit-contracts@0.16.8
- @velum-labs/routekit-gateway@0.16.8
- @velum-labs/routekit-registry@0.16.8
- @velum-labs/routekit-runtime@0.16.8

## 0.16.7

### Patch Changes

- c001649: Treat Codex `used_percent` values as percentages even when the value is `1`, repair ambiguous persisted snapshots, discover the actual Codex response-header families, and surface rejected out-of-range quota observations instead of falsely exhausting healthy subscription accounts.
- eabcc38: Retry managed Codex subscription requests when forced upstream SSE reports a terminal quota failure before output, while preserving structured stream errors and holding account capacity through body completion.
- Updated dependencies [eabcc38]
  - @velum-labs/routekit-gateway@0.16.7
  - @velum-labs/routekit-contracts@0.16.7
  - @velum-labs/routekit-registry@0.16.7
  - @velum-labs/routekit-runtime@0.16.7

## 0.16.6

### Patch Changes

- @velum-labs/routekit-contracts@0.16.6
- @velum-labs/routekit-gateway@0.16.6
- @velum-labs/routekit-registry@0.16.6
- @velum-labs/routekit-runtime@0.16.6

## 0.16.5

### Patch Changes

- Updated dependencies [448e004]
  - @velum-labs/routekit-contracts@0.16.5
  - @velum-labs/routekit-gateway@0.16.5
  - @velum-labs/routekit-registry@0.16.5
  - @velum-labs/routekit-runtime@0.16.5

## 0.16.4

### Patch Changes

- Updated dependencies [485132e]
  - @velum-labs/routekit-gateway@0.16.4
  - @velum-labs/routekit-contracts@0.16.4
  - @velum-labs/routekit-registry@0.16.4
  - @velum-labs/routekit-runtime@0.16.4

## 0.16.3

### Patch Changes

- @velum-labs/routekit-contracts@0.16.3
- @velum-labs/routekit-gateway@0.16.3
- @velum-labs/routekit-registry@0.16.3
- @velum-labs/routekit-runtime@0.16.3

## 0.16.2

### Patch Changes

- 46f79fa: Clear stale subscription quota cooldowns when an authoritative usage snapshot shows the exhausted window has recovered, so a healthy account is no longer held out of the pool until its old cooldown expires. Reconciliation is race-safe (a probe cannot clear a newer cooldown), preserves cooldowns on partial or failed probes and still-exhausted snapshots, works for both Codex and Claude pools, and requires no reset credit or credential refresh. Account diagnostics now expose structured readiness reasons that distinguish credential failure, catalog/model mismatch, quota pressure, and active cooldown.
  - @velum-labs/routekit-contracts@0.16.2
  - @velum-labs/routekit-gateway@0.16.2
  - @velum-labs/routekit-registry@0.16.2
  - @velum-labs/routekit-runtime@0.16.2

## 0.16.1

### Patch Changes

- @velum-labs/routekit-contracts@0.16.1
- @velum-labs/routekit-gateway@0.16.1
- @velum-labs/routekit-registry@0.16.1
- @velum-labs/routekit-runtime@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [8185e03]
  - @velum-labs/routekit-gateway@0.16.0
  - @velum-labs/routekit-contracts@0.16.0
  - @velum-labs/routekit-registry@0.16.0
  - @velum-labs/routekit-runtime@0.16.0

## 0.15.1

### Patch Changes

- Updated dependencies [b8023ac]
  - @velum-labs/routekit-gateway@0.15.1
  - @velum-labs/routekit-contracts@0.15.1
  - @velum-labs/routekit-registry@0.15.1
  - @velum-labs/routekit-runtime@0.15.1

## 0.15.0

### Minor Changes

- 5cd0e8c: improvements

### Patch Changes

- Updated dependencies [5cd0e8c]
- Updated dependencies [d81a841]
  - @velum-labs/routekit-contracts@0.15.0
  - @velum-labs/routekit-gateway@0.15.0
  - @velum-labs/routekit-registry@0.15.0
  - @velum-labs/routekit-runtime@0.15.0
