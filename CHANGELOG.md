# Changelog

## Unreleased

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
