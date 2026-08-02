# @velum-labs/routekit-tool-codex

## 0.18.0

### Patch Changes

- @velum-labs/routekit-contracts@0.18.0
- @velum-labs/routekit-harness-core@0.18.0
- @velum-labs/routekit-registry@0.18.0
- @velum-labs/routekit-runtime@0.18.0
- @velum-labs/routekit-tools@0.18.0

## 0.17.4

### Patch Changes

- Updated dependencies [d42282c]
  - @velum-labs/routekit-contracts@0.17.4
  - @velum-labs/routekit-harness-core@0.17.4
  - @velum-labs/routekit-tools@0.17.4
  - @velum-labs/routekit-registry@0.17.4
  - @velum-labs/routekit-runtime@0.17.4

## 0.17.3

### Patch Changes

- @velum-labs/routekit-contracts@0.17.3
- @velum-labs/routekit-harness-core@0.17.3
- @velum-labs/routekit-registry@0.17.3
- @velum-labs/routekit-runtime@0.17.3
- @velum-labs/routekit-tools@0.17.3

## 0.17.2

### Patch Changes

- @velum-labs/routekit-contracts@0.17.2
- @velum-labs/routekit-harness-core@0.17.2
- @velum-labs/routekit-registry@0.17.2
- @velum-labs/routekit-runtime@0.17.2
- @velum-labs/routekit-tools@0.17.2

## 0.17.1

### Patch Changes

- 576be2a: Install one RouteKit-backed Codex profile with its full model picker instead of generating a profile for every discovered model. Preserve Claude Code's gateway model-discovery picker and verify both native client integrations end to end.
  - @velum-labs/routekit-contracts@0.17.1
  - @velum-labs/routekit-harness-core@0.17.1
  - @velum-labs/routekit-registry@0.17.1
  - @velum-labs/routekit-runtime@0.17.1
  - @velum-labs/routekit-tools@0.17.1

## 0.17.0

### Minor Changes

- 0d4ad23: Install RouteKit additively into real Codex and Claude Code homes with dedicated,
  rotatable gateway tokens. Native clients now own their own history and session
  lifecycle; RouteKit no longer provides native session tracking or resume commands.

### Patch Changes

- Updated dependencies [0d4ad23]
  - @velum-labs/routekit-tools@0.17.0
  - @velum-labs/routekit-contracts@0.17.0
  - @velum-labs/routekit-harness-core@0.17.0
  - @velum-labs/routekit-registry@0.17.0
  - @velum-labs/routekit-runtime@0.17.0

## 0.16.9

### Patch Changes

- @velum-labs/routekit-contracts@0.16.9
- @velum-labs/routekit-harness-core@0.16.9
- @velum-labs/routekit-registry@0.16.9
- @velum-labs/routekit-runtime@0.16.9
- @velum-labs/routekit-tools@0.16.9

## 0.16.8

### Patch Changes

- @velum-labs/routekit-contracts@0.16.8
- @velum-labs/routekit-harness-core@0.16.8
- @velum-labs/routekit-registry@0.16.8
- @velum-labs/routekit-runtime@0.16.8
- @velum-labs/routekit-tools@0.16.8

## 0.16.7

### Patch Changes

- @velum-labs/routekit-contracts@0.16.7
- @velum-labs/routekit-harness-core@0.16.7
- @velum-labs/routekit-registry@0.16.7
- @velum-labs/routekit-runtime@0.16.7
- @velum-labs/routekit-tools@0.16.7

## 0.16.6

### Patch Changes

- @velum-labs/routekit-contracts@0.16.6
- @velum-labs/routekit-harness-core@0.16.6
- @velum-labs/routekit-registry@0.16.6
- @velum-labs/routekit-runtime@0.16.6
- @velum-labs/routekit-tools@0.16.6

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
  - @velum-labs/routekit-harness-core@0.16.5
  - @velum-labs/routekit-tools@0.16.5
  - @velum-labs/routekit-registry@0.16.5
  - @velum-labs/routekit-runtime@0.16.5

## 0.16.4

### Patch Changes

- @velum-labs/routekit-contracts@0.16.4
- @velum-labs/routekit-harness-core@0.16.4
- @velum-labs/routekit-registry@0.16.4
- @velum-labs/routekit-runtime@0.16.4
- @velum-labs/routekit-tools@0.16.4

## 0.16.3

### Patch Changes

- @velum-labs/routekit-contracts@0.16.3
- @velum-labs/routekit-harness-core@0.16.3
- @velum-labs/routekit-registry@0.16.3
- @velum-labs/routekit-runtime@0.16.3
- @velum-labs/routekit-tools@0.16.3

## 0.16.2

### Patch Changes

- @velum-labs/routekit-harness-core@0.16.2
- @velum-labs/routekit-registry@0.16.2
- @velum-labs/routekit-runtime@0.16.2
- @velum-labs/routekit-tools@0.16.2

## 0.16.1

### Patch Changes

- @velum-labs/routekit-harness-core@0.16.1
- @velum-labs/routekit-registry@0.16.1
- @velum-labs/routekit-runtime@0.16.1
- @velum-labs/routekit-tools@0.16.1

## 0.16.0

### Patch Changes

- @velum-labs/routekit-harness-core@0.16.0
- @velum-labs/routekit-registry@0.16.0
- @velum-labs/routekit-runtime@0.16.0
- @velum-labs/routekit-tools@0.16.0

## 0.15.1

### Patch Changes

- @velum-labs/routekit-harness-core@0.15.1
- @velum-labs/routekit-registry@0.15.1
- @velum-labs/routekit-runtime@0.15.1
- @velum-labs/routekit-tools@0.15.1

## 0.15.0

### Minor Changes

- 5cd0e8c: improvements

### Patch Changes

- Updated dependencies [5cd0e8c]
  - @velum-labs/routekit-harness-core@0.15.0
  - @velum-labs/routekit-registry@0.15.0
  - @velum-labs/routekit-runtime@0.15.0
  - @velum-labs/routekit-tools@0.15.0
