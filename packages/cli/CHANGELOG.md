# @velum-labs/routekit

## 0.16.2

### Patch Changes

- Updated dependencies [46f79fa]
  - @velum-labs/routekit-accounts@0.16.2
  - @velum-labs/routekit-daemon@0.16.2
  - @velum-labs/routekit-router@0.16.2
  - @velum-labs/routekit-cli-core@0.16.2
  - @velum-labs/routekit-cli-ui@0.16.2
  - @velum-labs/routekit-config@0.16.2
  - @velum-labs/routekit-contracts@0.16.2
  - @velum-labs/routekit-control@0.16.2
  - @velum-labs/routekit-gateway@0.16.2
  - @velum-labs/routekit-registry@0.16.2
  - @velum-labs/routekit-runtime@0.16.2
  - @velum-labs/routekit-telemetry-core@0.16.2
  - @velum-labs/routekit-tool-registry@0.16.2
  - @velum-labs/routekit-tools@0.16.2

## 0.16.1

### Patch Changes

- c27cd5a: Default the leaderboard to the longest available durable window so daemon
  restarts no longer make persisted usage appear to be lost.
- Updated dependencies [c27cd5a]
  - @velum-labs/routekit-daemon@0.16.1
  - @velum-labs/routekit-accounts@0.16.1
  - @velum-labs/routekit-cli-core@0.16.1
  - @velum-labs/routekit-cli-ui@0.16.1
  - @velum-labs/routekit-config@0.16.1
  - @velum-labs/routekit-contracts@0.16.1
  - @velum-labs/routekit-control@0.16.1
  - @velum-labs/routekit-gateway@0.16.1
  - @velum-labs/routekit-registry@0.16.1
  - @velum-labs/routekit-router@0.16.1
  - @velum-labs/routekit-runtime@0.16.1
  - @velum-labs/routekit-telemetry-core@0.16.1
  - @velum-labs/routekit-tool-registry@0.16.1
  - @velum-labs/routekit-tools@0.16.1

## 0.16.0

### Minor Changes

- 8185e03: Keep direct OpenAI API requests to `/v1/responses` on the native Responses
  endpoint so reasoning, function tools, streaming, and response items remain
  lossless.

### Patch Changes

- Updated dependencies [8185e03]
  - @velum-labs/routekit-gateway@0.16.0
  - @velum-labs/routekit-daemon@0.16.0
  - @velum-labs/routekit-accounts@0.16.0
  - @velum-labs/routekit-config@0.16.0
  - @velum-labs/routekit-router@0.16.0
  - @velum-labs/routekit-cli-core@0.16.0
  - @velum-labs/routekit-cli-ui@0.16.0
  - @velum-labs/routekit-contracts@0.16.0
  - @velum-labs/routekit-control@0.16.0
  - @velum-labs/routekit-registry@0.16.0
  - @velum-labs/routekit-runtime@0.16.0
  - @velum-labs/routekit-telemetry-core@0.16.0
  - @velum-labs/routekit-tool-registry@0.16.0
  - @velum-labs/routekit-tools@0.16.0

## 0.15.1

### Patch Changes

- Updated dependencies [b8023ac]
  - @velum-labs/routekit-gateway@0.15.1
  - @velum-labs/routekit-accounts@0.15.1
  - @velum-labs/routekit-config@0.15.1
  - @velum-labs/routekit-daemon@0.15.1
  - @velum-labs/routekit-router@0.15.1
  - @velum-labs/routekit-cli-core@0.15.1
  - @velum-labs/routekit-cli-ui@0.15.1
  - @velum-labs/routekit-contracts@0.15.1
  - @velum-labs/routekit-control@0.15.1
  - @velum-labs/routekit-registry@0.15.1
  - @velum-labs/routekit-runtime@0.15.1
  - @velum-labs/routekit-telemetry-core@0.15.1
  - @velum-labs/routekit-tool-registry@0.15.1
  - @velum-labs/routekit-tools@0.15.1

## 0.15.0

### Minor Changes

- 5cd0e8c: improvements

### Patch Changes

- Updated dependencies [5cd0e8c]
- Updated dependencies [d81a841]
  - @velum-labs/routekit-accounts@0.15.0
  - @velum-labs/routekit-cli-core@0.15.0
  - @velum-labs/routekit-cli-ui@0.15.0
  - @velum-labs/routekit-config@0.15.0
  - @velum-labs/routekit-contracts@0.15.0
  - @velum-labs/routekit-control@0.15.0
  - @velum-labs/routekit-daemon@0.15.0
  - @velum-labs/routekit-gateway@0.15.0
  - @velum-labs/routekit-registry@0.15.0
  - @velum-labs/routekit-router@0.15.0
  - @velum-labs/routekit-runtime@0.15.0
  - @velum-labs/routekit-telemetry-core@0.15.0
  - @velum-labs/routekit-tool-registry@0.15.0
  - @velum-labs/routekit-tools@0.15.0

## Unreleased

### Notes

- The retained internal Google provider backend remains outside RouteKit's public
  support contract. It is not first-launch onboarding and is not L06-qualified.

## 0.14.0 - 2026-07-27

### Added

- `routekit remote add --join <join-credential>` enrolls the SSH account as a
  peer of the shared daemon (over SSH, credential on stdin) before the usual
  remote enrollment, so a second user can set up laptop access in one command.
  Pass `-` to read the credential from stdin. `routekit peer add -` accepts the
  same stdin form.

### Changed

- `routekit remote add --json` now emits `{ remote, peer? }` instead of a bare
  remote object, matching `remote install` and `peer add`.
- `tokens.issue` returns `joinCredential` (was `joinToken`) for control-plane
  tokens. "Token" means a bare secret; "credential" means the self-describing
  `rk1_` blob.

### Breaking

- `remote add` no longer falls back to the shared owner token via
  `daemon auth show` on older remotes. Enrollment requires a remote that
  supports `tokens.issue` and always issues a named, revocable data token.
- `token issue --json` consumers must read `joinCredential` instead of
  `joinToken`.
- `remote add --json` consumers must read the nested `remote` object.

## 0.13.0 - 2026-07-27

### Changed

- `routekit peer add` now takes a single self-describing join credential
  (`rk1_…`) instead of `--token` plus `--owner-home` / `--public-record`.
  `routekit token issue --plane control` prints a paste-ready
  `routekit peer add rk1_…` line. The `peer default-path` subcommand is gone.
  `peer add` verifies the credential against the shared daemon before storing
  it, so a stale or revoked one fails at enrollment instead of on the next
  command.

## 0.12.0 - 2026-07-27

### Added

- Multi-user shared daemon access. Separate OS accounts can now share one
  RouteKit daemon with per-user, revocable credentials and caller attribution.
- `routekit token issue|list|revoke`: named data-plane and control-plane tokens.
  Plaintext is shown once; the owner token cannot be revoked.
- `routekit peer add|show|remove|default-path`: point an account at another
  user's shared daemon through a stored control token and public record path.
- `routekit calls` shows the calling principal (token label and id).

### Changed

- `routekit remote add` issues a named, revocable data-plane token per enrolling
  client over the control relay, falling back to the shared owner token only on
  remotes that predate `tokens.issue`.
- `status` and `daemon status` follow a peer pointer instead of reporting a
  stopped daemon, and peer handshake failures are now distinguished between
  authorization, permission, and unreachable-daemon causes.

### Fixed

- The interactive update check no longer re-hardens `$ROUTEKIT_HOME` to `0700`,
  which had been locking peer accounts out of the shared state home minutes
  after enrolling.
- The release workflow's metadata check now expects the `contents: write`
  permission it actually needs to attach `install.sh` to a release.

## 0.11.0 - 2026-07-26

### Added

- `routekit remote install <host>`: provision a bare SSH host into an enrollable
  RouteKit gateway (probe, npm install, canonical config, daemon start) and, with
  `--url`, enroll it through the same path as `remote add`.

### Changed

- Extracted RouteKit from the handoffkit monorepo into this standalone repository.
  All `@velum-labs/routekit*` packages are now owned and published from here.

### Removed

- Proxy-based Cursor support. Cursor is supported only through its own
  bring-your-own-key setting (Cursor Settings -> Models -> Override OpenAI Base
  URL) pointed at the gateway's `/v1/cursor` door. The `@velum-labs/cursorkit`
  bridge, the `routekit cursor --ide` flag, and the `route-cursor-agent` route
  are gone.

## 0.10.1

- Last version published from `velum-labs/handoffkit` before the extraction.
