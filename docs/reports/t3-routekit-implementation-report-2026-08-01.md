# T3 + RouteKit implementation report

**Date:** 2026-08-01
**Scope:** RouteKit/T3 environment integration, verification, screenshot-failure remediation, and cleanup on the Mac and `velum-mini`.

## Executive summary

The setup works for remote T3-managed Codex and Claude harnesses on `velum-mini`, using their normal user homes and configurations rather than ephemeral `HOME` directories or separate harness installations.

- **Codex in T3 works normally through RouteKit.**
- **Claude in T3 works through RouteKit when given a canonical RouteKit model ID.**
- T3's friendly built-in Claude selections, such as `claude-opus-5`, are not compatible with RouteKit's unambiguous native-Claude IDs. This cannot be solved cleanly without a T3 feature/change.

At the time of the environment validation, no RouteKit or T3 source code had
been modified and the checkout was clean. The reproducible deployment tooling
added afterward is documented in the addendum below.

## Architecture

```text
Mac T3 Code desktop
  |
  +-- SSH local tunnel: 127.0.0.1:<dynamic-port> -> velum-mini:127.0.0.1:3773
       |
       +-- T3 server on velum-mini
            +-- Codex app-server
            |    +-- normal ~/.codex RouteKit configuration
            +-- Claude Code CLI
                 +-- normal ~/.claude RouteKit configuration
                      |
                      +-- RouteKit gateway: 127.0.0.1:8080
                           +-- authenticated provider/account selected by RouteKit
```

The T3 server is loopback-only on the mini (`127.0.0.1:3773`) and is reached through the desktop-managed SSH tunnel. It is not exposed publicly.

### Versions verified

| Component | Version |
|---|---:|
| RouteKit | `0.17.2` |
| Codex | `0.146.0` |
| Claude Code | `2.1.220` |
| T3 Code server | `0.0.31` |

RouteKit's current live doctor result on the mini is **20 OK, 0 warnings, 0 failures**, with six ready providers and 525 discovered routes.

## Configuration installed

### Codex

On both the Mac and mini:

- RouteKit's managed block was installed in `~/.codex/config.toml`.
- It defines the `routekit` model provider.
- RouteKit generated a single `routekit` Codex profile and model catalog.
- This is additive: normal Codex configuration remains intact.

On the mini, T3 starts Codex with the RouteKit provider and generated catalog. It therefore uses the mini's ordinary Codex configuration, tools, MCP configuration, skills, and login state.

### Claude Code

On both the Mac and mini:

- RouteKit configuration is in ordinary `~/.claude/settings.json`.
- Claude Code still reads user, project, and local settings.
- The default model was set to the canonical native RouteKit Claude Code route:

  ```text
  anthropic.routekit.claude-code/claude-opus-5
  ```

- The picker contains 525 canonical RouteKit IDs: one per RouteKit route, not thousands of duplicate `claude-*` aliases.

### T3 environment

- A saved SSH environment for `velum-mini` was added to the Mac T3 desktop app.
- T3 desktop manages the SSH tunnel and uses the mini's T3 server.
- T3's own persistent state is under `~/.t3`; this is T3 state/cache/database, not an isolated Codex or Claude installation.
- T3 launches normal harnesses from the normal mini user home. It does not set a per-thread temporary `HOME`.

This was the deliberate design: RouteKit routes requests; T3 owns remote sessions and optional worktrees; Codex/Claude retain their existing setup.

## Tests actually performed

These were real integration tests, including billed provider calls.

| Test | Result |
|---|---|
| T3 -> Codex -> RouteKit -> `openai/gpt-5.5` | Passed; exact response `T3_CODEX_ROUTEKIT_OK` |
| T3 -> Claude -> RouteKit direct Anthropic route | Passed; exact response `T3_CLAUDE_ROUTEKIT_OK` |
| T3 new-worktree flow -> native Claude Code RouteKit route `anthropic.routekit.claude-code/claude-opus-5` | Passed; exact response `T3_CLAUDE_OPUS_WORKTREE_OK` |
| RouteKit live credential/model discovery | Passed: 20 OK / 0 warnings / 0 failures |
| Desktop reconnect and SSH tunnel | Passed |

### What the tests prove

- T3 can start both remote harnesses.
- Both harnesses use RouteKit.
- RouteKit can select a live provider/account and execute requests.
- The T3 MCP wiring survives the RouteKit integration.
- T3's worktree bootstrap works when a valid Git remote/base exists.

### What they do not prove

- Every one of the 525 routes/models has been billed and tested.
- Provider quota, account expiry, external outages, and changing model availability will never fail later.
- Future T3/RouteKit upgrades will preserve this behavior without revalidation.

## Screenshot failure analysis

There were two independent issues.

### Git `fetch origin` failure

The isolated verification project had no `origin`, while T3 was configured to create a new worktree from `origin/main`.

A **local bare Git remote** was created only for that synthetic verification workspace:

```text
~/.t3/verification-origin.git
```

The workspace's `origin` now points to it. `git fetch origin` and the T3 worktree bootstrap were verified afterward.

This is a **test fixture**, not a general product fix. Any real project configured as “New worktree / From origin/main” still needs a valid `origin/main`.

### T3's built-in Claude picker ID

T3 exposes built-in model IDs such as:

```text
claude-opus-5
```

RouteKit deliberately requires an unambiguous native Claude picker ID:

```text
anthropic.routekit.claude-code/claude-opus-5
```

The bare `claude-opus-5` name is ambiguous across configured Anthropic, Bedrock, OpenRouter, and Claude Code routes. RouteKit should not silently select one.

T3 does not currently support mapping its display label “Claude Opus 5” to a distinct backend model ID. When T3 passes the bare model ID, Claude Code falls back incorrectly to the first allowed model—in this configuration an embedding model—and fails.

The affected draft was updated through T3's authenticated RPC to use:

```text
anthropic.routekit.claude-code/claude-opus-5
```

Its message was not sent automatically.

### Consequence

For Claude in T3, select the canonical RouteKit Claude entry, not T3's friendly built-in Claude entry.

A durable product fix requires T3 to support one of:

1. Display-name to backend-model-ID mapping.
2. Replacing/hiding built-in Claude models.
3. Configurable model aliases.

T3 was not forked or patched to fake this.

## Design decisions and trade-offs

### One canonical Claude model per route

**Decision:** retain 525 canonical `anthropic.routekit.<provider>/<model>` IDs.

**Why:** avoids aliases and ambiguous model routing, while removing prior duplicate `claude-*` families.

**Cost:** the Claude picker remains large and canonical names are less friendly than provider-native labels.

**Rejected workaround:** reordering the list so T3's bad fallback lands on a chat model. That would hide T3's bug while silently routing to an unintended model/provider.

### Normal homes instead of ephemeral homes

**Decision:** T3 launches the ordinary mini user’s Codex and Claude environments.

**Benefit:** existing settings, MCPs, skills, auth, and tools work.

**Cost:** these are real user environments. RouteKit routes model requests; it does not sandbox filesystem actions or session behavior.

T3's Claude process is configured with full-access/bypass-permission behavior. That is a T3 behavior, not a RouteKit modification. Tests were confined to an isolated workspace and explicitly told the model not to modify files.

### SSH tunnel instead of public T3 exposure

**Decision:** T3 remains loopback-only on the mini and is accessed through SSH.

**Benefit:** no public T3 server exposure.

**Cost:** availability depends on the desktop app, SSH alias, tunnel, and network/Tailscale reachability. The forwarded local port is dynamic.

## One-off or non-reproducible pieces

These are not normal product features.

1. **Synthetic Git origin**
   - `~/.t3/verification-origin.git` exists only to exercise T3 worktree behavior.
   - It is not a substitute for a real GitHub/GitLab remote.

2. **Direct T3 RPC draft repair**
   - The model selection was repaired using T3's shipped authenticated WebSocket RPC.
   - T3's SQLite database was only read, never directly edited.
   - A temporary pairing credential had a five-minute lifetime and was removed afterward.
   - This was a one-off repair and is version-sensitive to T3's internal client API.

3. **Temporary audit/test tooling**
   - Temporary TypeScript tooling and a T3 source audit checkout were moved to Trash, not committed or installed into RouteKit.

4. **Test-thread residue**
   - Three clean test worktrees and their test branches were removed.
   - T3 had kept three idle Claude subprocesses associated only with those removed test worktrees; precisely those test subprocesses were terminated.
   - T3 retains three historical test-thread records in its own projection database: two stopped failed attempts and one archived success. They are harmless but stale metadata pointing to removed test worktrees.
   - This is not as clean as it should be. The threads should have been deleted through T3's supported command before their worktrees were removed.

No user project repository, user source code, RouteKit source, provider credentials, or provider tokens were deleted or rotated.

## Security observations

- RouteKit gateway traffic requires a bearer token.
- The mini gateway binds to `127.0.0.1:8080`.
- Mac direct Codex integration uses the mini's HTTPS/Tailscale RouteKit endpoint.
- No secret values are included here.
- No tokens were rotated.

T3 includes MCP authentication material when launching child harness processes. On a single-user mini this is contained to that account/root, but it means T3's process-level security model matters. This is T3 behavior, not added by RouteKit.

## Current readiness

### Ready to use

- Mac native Codex -> RouteKit.
- Mac native Claude Code -> RouteKit.
- T3 remote Codex on mini -> RouteKit.
- T3 remote Claude on mini -> RouteKit, **when selecting canonical RouteKit Claude IDs**.
- Existing Codex/Claude configuration, MCPs, and skills on the mini remain available to T3 harnesses.

### Not seamless yet

- T3's built-in Claude picker labels cannot safely represent RouteKit's canonical Claude routes.
- T3 projects using `origin/main` worktree bootstrapping need a valid Git remote.
- The isolated verification project retains stale T3 test-thread metadata.

## Final state

The original integration was functional and verified with real requests, subject
to the stated T3 Claude picker limitation and normal external-provider
operational risks. The repository subsequently gained the safe, reproducible
deployment tooling described below.

## Addendum: reproducible deployment and hardening

The repository now provides the following operator scripts:

```sh
pnpm t3:deploy -- --ssh velum-mini --routekit local
pnpm t3:deploy -- --ssh host --routekit-remote existing-name
pnpm t3:destroy -- --ssh velum-mini
```

They use normal `~/.codex` and `~/.claude` homes, an isolated deployment-owned
T3 base directory at `~/.routekit/t3/<id>/data`, a per-user loopback
LaunchAgent, two deployment-only RouteKit data tokens, and nonce-derived
Keychain accounts. They never call RouteKit config/provider/account/remote
mutation, stop a daemon, or uninstall a native integration. Destroy only
revokes tokens and deletes a Keychain entry, wrapper, and LaunchAgent after
exact ownership/hash verification; it keeps all existing RouteKit and native
client configuration, T3 projects/sessions/logs, and the global T3 package.

Safety checks now fail before writing a manifest, installing T3, issuing a
token, or invoking a native installer when they find a symlinked client config,
a changed native registry, an untracked integration block, or partial RouteKit
ownership files. The only allowed RouteKit operations are health/catalog reads,
credentialless `codex|claude install --no-token`, and nonce-proven deployment
token issue/list/revoke operations. The scripts require the RouteKit release
that includes `--no-token`; the currently installed `0.17.2` on the mini does
not yet include it, so only the non-mutating dry run was repeated after this
implementation.

Validation after the hardening implementation:

- `pnpm build`, `pnpm test`, and `pnpm check` passed.
- The deployment script tests include a simulated partial Codex integration and
  prove it leaves the client file and deployment state untouched.
- `pnpm t3:deploy -- --ssh velum-mini --routekit local --dry-run` and
  `pnpm t3:destroy -- --ssh velum-mini --dry-run` passed against the real mini.
- No billed request was made during this hardening pass.
