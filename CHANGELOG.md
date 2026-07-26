# Changelog

## Unreleased

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
