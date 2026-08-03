# @velum-labs/routekit

## 0.18.0

### Minor Changes

- 182d6ef: Make self-update provenance-aware across the public installer, npm, pnpm, Yarn
  Classic, Bun, and Volta. Add installer receipts, manager-native ownership
  proof, pnpm 11 support, owner-aware version resolution, concurrency locking,
  bounded/redacted diagnostics, strict post-update verification, and safe
  guidance for externally managed, local, linked, ephemeral, or unknown installs.
- 2a3279a: Add provider-aware deterministic config initialization and an interactive,
  multi-route `routekit setup` wizard with API preflight, subscription enrollment,
  live model selection, and safe resume behavior.

### Patch Changes

- 0e5f726: Fix ENG-731 by allowing self-update to safely update the active RouteKit installation when lower-priority installs are also on PATH. Fix ENG-717 by resolving `latest` before local or remote idempotency checks.
- 6a4e53b: Pin the exact qualified Codex CLI and Claude Code builds in one checked
  compatibility contract, and withdraw Cursor Desktop from the public launch
  surface after Cursor 3.12.30 rejected RouteKit model names during manual
  qualification.
- Updated dependencies [161c5c8]
- Updated dependencies [0c1f18e]
  - @velum-labs/routekit-gateway@0.18.0
  - @velum-labs/routekit-tool-registry@0.18.0
  - @velum-labs/routekit-accounts@0.18.0
  - @velum-labs/routekit-config@0.18.0
  - @velum-labs/routekit-daemon@0.18.0
  - @velum-labs/routekit-router@0.18.0
  - @velum-labs/routekit-cli-core@0.18.0
  - @velum-labs/routekit-cli-ui@0.18.0
  - @velum-labs/routekit-contracts@0.18.0
  - @velum-labs/routekit-control@0.18.0
  - @velum-labs/routekit-registry@0.18.0
  - @velum-labs/routekit-runtime@0.18.0
  - @velum-labs/routekit-telemetry-core@0.18.0
  - @velum-labs/routekit-tools@0.18.0

## 0.17.4

### Patch Changes

- 62fed4c: Select implicit Codex startup models from discovered text-output and tool capabilities, preferring provider-authored priority and advertised recency within a billing-safe fallback scope. Ambiguous direct OpenAI models use live OpenRouter capability and recency enrichment.
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
- Updated dependencies [065aeea]
  - @velum-labs/routekit-accounts@0.17.4
  - @velum-labs/routekit-contracts@0.17.4
  - @velum-labs/routekit-gateway@0.17.4
  - @velum-labs/routekit-daemon@0.17.4
  - @velum-labs/routekit-router@0.17.4
  - @velum-labs/routekit-control@0.17.4
  - @velum-labs/routekit-tools@0.17.4
  - @velum-labs/routekit-config@0.17.4
  - @velum-labs/routekit-tool-registry@0.17.4
  - @velum-labs/routekit-cli-core@0.17.4
  - @velum-labs/routekit-cli-ui@0.17.4
  - @velum-labs/routekit-registry@0.17.4
  - @velum-labs/routekit-runtime@0.17.4
  - @velum-labs/routekit-telemetry-core@0.17.4

## 0.17.3

### Patch Changes

- 328e7f0: Add credentialless Codex and Claude integration installs for safely managed
  external launch environments, and add reproducible T3 deployment scripts that
  preserve existing RouteKit and native-client configuration.
  - @velum-labs/routekit-accounts@0.17.3
  - @velum-labs/routekit-cli-core@0.17.3
  - @velum-labs/routekit-cli-ui@0.17.3
  - @velum-labs/routekit-config@0.17.3
  - @velum-labs/routekit-contracts@0.17.3
  - @velum-labs/routekit-control@0.17.3
  - @velum-labs/routekit-daemon@0.17.3
  - @velum-labs/routekit-gateway@0.17.3
  - @velum-labs/routekit-registry@0.17.3
  - @velum-labs/routekit-router@0.17.3
  - @velum-labs/routekit-runtime@0.17.3
  - @velum-labs/routekit-telemetry-core@0.17.3
  - @velum-labs/routekit-tool-registry@0.17.3
  - @velum-labs/routekit-tools@0.17.3

## 0.17.2

### Patch Changes

- 854dd1c: Use Claude Code's native custom-model picker and effort selector instead of
  advertising synthetic `claude-*` and effort-qualified RouteKit models. Claude
  can now route an unambiguous bare provider-native model id.
- Updated dependencies [854dd1c]
  - @velum-labs/routekit-gateway@0.17.2
  - @velum-labs/routekit-accounts@0.17.2
  - @velum-labs/routekit-config@0.17.2
  - @velum-labs/routekit-daemon@0.17.2
  - @velum-labs/routekit-router@0.17.2
  - @velum-labs/routekit-tool-registry@0.17.2
  - @velum-labs/routekit-cli-core@0.17.2
  - @velum-labs/routekit-cli-ui@0.17.2
  - @velum-labs/routekit-contracts@0.17.2
  - @velum-labs/routekit-control@0.17.2
  - @velum-labs/routekit-registry@0.17.2
  - @velum-labs/routekit-runtime@0.17.2
  - @velum-labs/routekit-telemetry-core@0.17.2
  - @velum-labs/routekit-tools@0.17.2

## 0.17.1

### Patch Changes

- 576be2a: Install one RouteKit-backed Codex profile with its full model picker instead of generating a profile for every discovered model. Preserve Claude Code's gateway model-discovery picker and verify both native client integrations end to end.
  - @velum-labs/routekit-tool-registry@0.17.1
  - @velum-labs/routekit-accounts@0.17.1
  - @velum-labs/routekit-cli-core@0.17.1
  - @velum-labs/routekit-cli-ui@0.17.1
  - @velum-labs/routekit-config@0.17.1
  - @velum-labs/routekit-contracts@0.17.1
  - @velum-labs/routekit-control@0.17.1
  - @velum-labs/routekit-daemon@0.17.1
  - @velum-labs/routekit-gateway@0.17.1
  - @velum-labs/routekit-registry@0.17.1
  - @velum-labs/routekit-router@0.17.1
  - @velum-labs/routekit-runtime@0.17.1
  - @velum-labs/routekit-telemetry-core@0.17.1
  - @velum-labs/routekit-tools@0.17.1

## 0.17.0

### Minor Changes

- 0d4ad23: Install RouteKit additively into real Codex and Claude Code homes with dedicated,
  rotatable gateway tokens. Native clients now own their own history and session
  lifecycle; RouteKit no longer provides native session tracking or resume commands.

### Patch Changes

- Updated dependencies [0d4ad23]
  - @velum-labs/routekit-tools@0.17.0
  - @velum-labs/routekit-tool-registry@0.17.0
  - @velum-labs/routekit-accounts@0.17.0
  - @velum-labs/routekit-cli-core@0.17.0
  - @velum-labs/routekit-cli-ui@0.17.0
  - @velum-labs/routekit-config@0.17.0
  - @velum-labs/routekit-contracts@0.17.0
  - @velum-labs/routekit-control@0.17.0
  - @velum-labs/routekit-daemon@0.17.0
  - @velum-labs/routekit-gateway@0.17.0
  - @velum-labs/routekit-registry@0.17.0
  - @velum-labs/routekit-router@0.17.0
  - @velum-labs/routekit-runtime@0.17.0
  - @velum-labs/routekit-telemetry-core@0.17.0

## 0.16.9

### Patch Changes

- Updated dependencies [d2d787f]
  - @velum-labs/routekit-accounts@0.16.9
  - @velum-labs/routekit-daemon@0.16.9
  - @velum-labs/routekit-router@0.16.9
  - @velum-labs/routekit-cli-core@0.16.9
  - @velum-labs/routekit-cli-ui@0.16.9
  - @velum-labs/routekit-config@0.16.9
  - @velum-labs/routekit-contracts@0.16.9
  - @velum-labs/routekit-control@0.16.9
  - @velum-labs/routekit-gateway@0.16.9
  - @velum-labs/routekit-registry@0.16.9
  - @velum-labs/routekit-runtime@0.16.9
  - @velum-labs/routekit-telemetry-core@0.16.9
  - @velum-labs/routekit-tool-registry@0.16.9
  - @velum-labs/routekit-tools@0.16.9

## 0.16.8

### Patch Changes

- ce6ba94: Bundle the PostHog project token so explicitly opted-in product telemetry works without additional environment configuration.
- Updated dependencies [ce6ba94]
  - @velum-labs/routekit-daemon@0.16.8
  - @velum-labs/routekit-accounts@0.16.8
  - @velum-labs/routekit-cli-core@0.16.8
  - @velum-labs/routekit-cli-ui@0.16.8
  - @velum-labs/routekit-config@0.16.8
  - @velum-labs/routekit-contracts@0.16.8
  - @velum-labs/routekit-control@0.16.8
  - @velum-labs/routekit-gateway@0.16.8
  - @velum-labs/routekit-registry@0.16.8
  - @velum-labs/routekit-router@0.16.8
  - @velum-labs/routekit-runtime@0.16.8
  - @velum-labs/routekit-telemetry-core@0.16.8
  - @velum-labs/routekit-tool-registry@0.16.8
  - @velum-labs/routekit-tools@0.16.8

## 0.16.7

### Patch Changes

- c001649: Treat Codex `used_percent` values as percentages even when the value is `1`, repair ambiguous persisted snapshots, discover the actual Codex response-header families, and surface rejected out-of-range quota observations instead of falsely exhausting healthy subscription accounts.
- Updated dependencies [c001649]
- Updated dependencies [eabcc38]
  - @velum-labs/routekit-accounts@0.16.7
  - @velum-labs/routekit-gateway@0.16.7
  - @velum-labs/routekit-daemon@0.16.7
  - @velum-labs/routekit-router@0.16.7
  - @velum-labs/routekit-config@0.16.7
  - @velum-labs/routekit-cli-core@0.16.7
  - @velum-labs/routekit-cli-ui@0.16.7
  - @velum-labs/routekit-contracts@0.16.7
  - @velum-labs/routekit-control@0.16.7
  - @velum-labs/routekit-registry@0.16.7
  - @velum-labs/routekit-runtime@0.16.7
  - @velum-labs/routekit-telemetry-core@0.16.7
  - @velum-labs/routekit-tool-registry@0.16.7
  - @velum-labs/routekit-tools@0.16.7

## 0.16.6

### Patch Changes

- cd7bc2e: Add explicit-opt-in PostHog product analytics with granular category controls and privacy-safe, bucketed gateway aggregation.
- Updated dependencies [cd7bc2e]
  - @velum-labs/routekit-telemetry-core@0.16.6
  - @velum-labs/routekit-control@0.16.6
  - @velum-labs/routekit-daemon@0.16.6
  - @velum-labs/routekit-accounts@0.16.6
  - @velum-labs/routekit-cli-core@0.16.6
  - @velum-labs/routekit-cli-ui@0.16.6
  - @velum-labs/routekit-config@0.16.6
  - @velum-labs/routekit-contracts@0.16.6
  - @velum-labs/routekit-gateway@0.16.6
  - @velum-labs/routekit-registry@0.16.6
  - @velum-labs/routekit-router@0.16.6
  - @velum-labs/routekit-runtime@0.16.6
  - @velum-labs/routekit-tool-registry@0.16.6
  - @velum-labs/routekit-tools@0.16.6

## 0.16.5

### Patch Changes

- 7d31749: Fix private installer destroying `~/.local/bin/routekit` when the npm prefix is already `~/.local`.
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
  - @velum-labs/routekit-gateway@0.16.5
  - @velum-labs/routekit-accounts@0.16.5
  - @velum-labs/routekit-control@0.16.5
  - @velum-labs/routekit-tools@0.16.5
  - @velum-labs/routekit-config@0.16.5
  - @velum-labs/routekit-daemon@0.16.5
  - @velum-labs/routekit-router@0.16.5
  - @velum-labs/routekit-tool-registry@0.16.5
  - @velum-labs/routekit-cli-core@0.16.5
  - @velum-labs/routekit-cli-ui@0.16.5
  - @velum-labs/routekit-registry@0.16.5
  - @velum-labs/routekit-runtime@0.16.5
  - @velum-labs/routekit-telemetry-core@0.16.5

## 0.16.4

### Patch Changes

- Updated dependencies [485132e]
  - @velum-labs/routekit-gateway@0.16.4
  - @velum-labs/routekit-accounts@0.16.4
  - @velum-labs/routekit-config@0.16.4
  - @velum-labs/routekit-daemon@0.16.4
  - @velum-labs/routekit-router@0.16.4
  - @velum-labs/routekit-cli-core@0.16.4
  - @velum-labs/routekit-cli-ui@0.16.4
  - @velum-labs/routekit-contracts@0.16.4
  - @velum-labs/routekit-control@0.16.4
  - @velum-labs/routekit-registry@0.16.4
  - @velum-labs/routekit-runtime@0.16.4
  - @velum-labs/routekit-telemetry-core@0.16.4
  - @velum-labs/routekit-tool-registry@0.16.4
  - @velum-labs/routekit-tools@0.16.4

## 0.16.3

### Patch Changes

- 4da943a: Make self-update invoke the package manager that owns the running CLI and verify the fresh PATH executable after installation.
  - @velum-labs/routekit-accounts@0.16.3
  - @velum-labs/routekit-cli-core@0.16.3
  - @velum-labs/routekit-cli-ui@0.16.3
  - @velum-labs/routekit-config@0.16.3
  - @velum-labs/routekit-contracts@0.16.3
  - @velum-labs/routekit-control@0.16.3
  - @velum-labs/routekit-daemon@0.16.3
  - @velum-labs/routekit-gateway@0.16.3
  - @velum-labs/routekit-registry@0.16.3
  - @velum-labs/routekit-router@0.16.3
  - @velum-labs/routekit-runtime@0.16.3
  - @velum-labs/routekit-telemetry-core@0.16.3
  - @velum-labs/routekit-tool-registry@0.16.3
  - @velum-labs/routekit-tools@0.16.3

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
