# @velum-labs/routekit-accounts

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
