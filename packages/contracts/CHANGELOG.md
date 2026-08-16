# @velum-labs/routekit-contracts

## 0.18.4

## 0.18.3

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
