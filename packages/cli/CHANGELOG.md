# @velum-labs/routekit

## 1.0.0

### Major Changes

- 79fe1c7: Remove retired compatibility surfaces and introduce explicit resource ownership,
  transactional router generations and remote enrollment, and cancellation-safe
  harness sessions. Move router configuration ownership into config-core, add
  validated provider boundary codecs and streaming, decompose routing and HTTP
  endpoints into explicit ports, make daemon/CLI application services declarative,
  and enforce intentional package APIs in CI.
- abe8938: Make control clients depend on an explicit control transport, including a
  native SSH relay transport instead of adapting SSH through a synthetic
  `fetch`. Keep configuration-core limited to schemas and policy by removing its
  Node filesystem/runtime dependency.

### Minor Changes

- 0e67bb3: Introduce the sole compositional eval-routing protocol, repository-scoped review artifacts and immutable plans, bounded eval sessions, atomic routing activation, and the public `routekit eval` workflow.
- 3e3effd: Add compositional eval routing as RouteKit's sole automatic-routing protocol.
  A model-blind classifier decomposes each request across a reviewed routing
  basis, while deterministic code combines that decomposition with hard request
  requirements, complete model-by-dimension evidence, and the user's quality,
  cost, latency, balanced, or Pareto objective.

  Expose the complete durable workflow through `routekit eval`: repository setup,
  one-question-at-a-time onboarding, workload-dimension and evaluation proposals,
  digest-bound review approvals, validation, immutable planning and estimates,
  scoped qualification runs, structured results, and atomic routing activation.
  Normal billed work uses RouteKit's configured local or remote target; explicit
  external gateways may qualify evidence but cannot activate it.

  Require complete manifest-bound comparison evidence, stable case identities,
  strict normalized request decompositions, conservative quality measurements,
  explicit unknown pricing, sanitized provenance, and fail-closed routing. Add
  scoped eval sessions with explicit model and output limits, atomic project and
  activation artifacts, and interruption-safe cleanup and reporting.

- 59c83e0: Accept tightly mapped, short-lived ES256 workload credentials alongside durable RouteKit data tokens. Daemons can load a nonsecret public-key authorization policy while brokered credentials remain memory-only.

### Patch Changes

- 8bbe0f4: Tie command_completed paths to the CLI command tree so a new command cannot silently miss telemetry and stale allowlist entries cannot linger.
- 3a969f1: Replace Commander command metadata and registration types with the Effect 4 CLI command tree, run each CLI invocation on one managed Effect runtime, and preserve dynamic completion and launcher argument passthrough at the process boundary.
- 7a3a4aa: Make Effect the RouteKit application runtime: live layers now acquire daemon,
  gateway, telemetry, token, eval-session, and eval execution lifetimes instead
  of succeeding prebuilt coordinator bags. The daemon worker owns one
  ManagedRuntime, the cluster primary is an Effect supervision tree with
  Ref-owned generation publication, and standalone gateway façades dispose their
  own runtimes.

  Compose eval-service directly with the native EvalEngine and a streaming,
  interruptible Ori execution port. Keep vendored sources untouched, prevent
  application packages from launching a second Ori host, and preserve existing
  control.v2, HTTP/SSE, CLI, persisted, and published package contracts.

- abd64a0: Migrate RouteKit internals onto Effect with a process-lifetime ManagedRuntime (`RouteKitLive`), tagged failures, FileSystem-backed document persistence, Effect `CapacityPool` leases, HttpClient egress, HttpRouter+NodeHttpServer inbound (drain/SSE/NDJSON wire unchanged), Effect account coordinators, account-set construction/probe/discover/close, subscription providers, proxy client, native Effect `control.v2` handlers (Promise only at the NDJSON wire), Effect reset-credit and auth-recovery programs, CLI catalog/health probes, cliproxy sidecar reachability, control-client health/call/stream as Effect (Promise only at Commander/host/NDJSON iterator edges), remaining CLI install/relay/handshake plus daemon shared-gateway probes as Effect, switching-proxy, endpoint/runtime health probes, ACP registry fetch/install, gateway web-search execution (one Effect per server-tool step on the HttpClient captured when the gateway HTTP app is built), OpenRouter metadata (single-flight Effect, not a nested runtime), provider HTTP transports on the inbound fiber, subscription execute/relays, daemon lifecycle/generations/sidecar/host-worker cores, daemon account enroll/remove/rename/sync plus subscription SSE inspect, subscription usage collection, local usage sources, `startSubscriptionProxy`, gateway-generation usage, relay close, CLI use-cases (accounts login/activate, config import, native install/uninstall, setup, remote enroll/remove/provision), remote enrollment/recovery transaction machines, provider model discovery plus `RoutingBackend.create`, host generation stages as Effect programs, and account-set/activity/auth-health/relay/executor Promise edges on captured fiber context via `runRouteKitEffectWith` instead of a nested ManagedRuntime. `Backend.chat`/`models`/`embeddings` (and `BackendResponsesPort.execute`) are `BackendRequest` Effects requiring `RouteKitPlatform`. Inbound `GatewayEndpoint.handle`/`executeOperation` stay on that captured fiber (`serveEndpoint` provides the platform). Server-tool `runStep` is Effect; `composeServerToolStream` runs `runRouteKitEffect*` only at ReadableStream start. Anthropic/Codex subscription relays are Effects. Account-set usage probes use `Deferred` plus a detached probe fiber (interrupted on close); activity persist debounce is a detached fiber woken from `beginAttempt`; gateway `usage` and `RelayLifecycle.close` are Effects (Node bind/close still Promise); daemon generation `persist` and `replaceRouter` are Effects so enroll/mutation no longer `runRouteKitEffectWith` inside persist hooks; post-handoff subscription stream observe work is queued onto a detached fiber instead of `runRouteKitEffectWith`; CLI `launchTool`/`resolveCodexLaunchSelection` are Effects (`runCliEffect` at Commander, spawn still Promise); `routekitClient`/`connectDaemon` are lazy Effect values. Promise remains at Commander, NDJSON, Node bind, Fetch body reads, SSE stream controllers, and `[Symbol.asyncDispose]`. `cliTry`/`controlTry`/`gatewayTry` tag failures as `RouteKitFailure`; `routeKitError` still unwraps wrap-only `RouteKitFailure` so Error subclasses map on the wire. OpenRouter metadata refresh uses Effect timeout (not unref'd `AbortSignal.timeout`) so hanging fetches still settle. CLI `routekitClient`/`ensureDaemon`/`connectDaemon` are Effect programs (`runCliEffect` only at Commander) and fail with tagged `RouteKitFailure` so Effect tsgo `globalErrorInEffectFailure` stays at 0 errors. `runRouteKitEffect`/`runCliEffect` do not constrain `R` to `RouteKitPlatform` so programs that `yield*` HttpClient (Effect 4 `Request<"Requires", _>`) typecheck at the process edge. Drop wrap-only Effect façades and unused `runBackendRequest`. Schema eval contracts and Effect language-service diagnostics (`globalErrorInEffectFailure`, `globalErrorInEffectCatch`, and `tryCatchInEffectGen` as error; `globalFetch` stays off for tests and the live Fetch adapter, with `globalFetchInEffect` already error). Product wire (control.v2, HTTP/SSE, CLI output, persisted formats) stays unchanged. Domain coordinators are wrapped behind Effect 4 `Context.Service` keys (`AccountActivity`, `AccountAuth`, `DaemonEnv`/`DaemonState`/`Sidecar`/`Generations`/`ActiveGateway`/`Tokens`/`Telemetry`/`DataPlane`/`AccountRecovery`/`CallAttributions`/`Leaderboard`/`DaemonPolicy`/`DaemonHost`, CLI `DaemonClient` via `CliLive`) composed as `daemonLive` so control handlers `yield*` services; CLI Commander actions run one program via `runCliClient` or one `runCliEffect` per action. Service-facing coordinator types expose only public operations (with direct Effect semantics for zero-argument work), so Effect diagnostics are 0 errors, 0 warnings, and 0 messages. Telemetry mutations use `serializeEffect`; Promise `serializeMutation` is gone. `EffectResourceScope.own` prefers an Effect-returning `close()`; Promise finalizers are only the Node listen/close adapter. Gateway-generation and subscription-proxy `close` use `runRouteKitEffect` (no `runPromiseWith`). Activity/auth/account-set `[Symbol.asyncDispose]` uses `runRouteKitEffect`. `DaemonEnv` carries generation/startedAt/hosted; `ActiveGateway` holds the live router, switching proxy, data URL, and control server. Generation replace scopes an unpublished candidate with `Effect.addFinalizer` and adopts it after `swapTarget`. `waitForServiceReadyEffect` and `waitForProcessExitEffect` are the readiness/exit pollers; the Promise wrappers are process-edge adapters. CLI service install/uninstall/status, config init/edit, daemon exec, and `usage --watch` are one Commander program each (`watchUsageEffect` ticks on the same fiber). Inbound `serveEndpoint` provides the `RouteKitPlatform` captured when the gateway HTTP app is built (HttpClient included), so relays and provider backends no longer store or `provideCapturedPlatform`. Daemon bootstrap is one Effect program (`runRouteKitEffect` once; Node listen via `tryPromise`; Promise only on returned close/retire/reload). `runCapturedPlatform` is a test helper, not a public export.

  Provider resources, backend ownership, gateway drain/close, router close, subscription-proxy close, relay teardown, and Node HTTP handler teardown are Effect values. `startGatewayEffect` is the internal constructor; the Promise `startGateway` function is only the standalone Node host adapter. Captured request platform contexts omit the construction scope so a router generation can publish a handler beyond its prepare scope without retaining or closing that scope.

  The switching proxy and control listener now expose Effect construction, idle waits, retirement, drain, and close; daemon bootstrap consumes those Effects directly. Endpoint pipeline stages, Anthropic catalog merging, account acquisition revalidation, and auth-recovery waiters are Effect-native, with `Deferred` replacing Promise coordination. Promise adapters remain only where Node, Commander, Fetch/Web Streams, AsyncDisposable, cluster IPC, or standalone public hosts require them.

- 661a99e: Organize application capabilities under shallow, explicitly owned service modules, separate platform and protocol adapters from services, add focused Runtime import surfaces, move gateway-generation composition into the daemon with native Effect scope ownership, and remove the obsolete standalone router package.
- Updated dependencies [ce85644]
- Updated dependencies [f122b9a]
- Updated dependencies [cf49bbd]
- Updated dependencies [909aec9]
- Updated dependencies [17e297a]
- Updated dependencies [79fe1c7]
- Updated dependencies [8bbe0f4]
- Updated dependencies [d7678cf]
- Updated dependencies [0e67bb3]
- Updated dependencies [dffa147]
- Updated dependencies [bc5e40f]
- Updated dependencies [08bba7b]
- Updated dependencies [653530c]
- Updated dependencies [6e6d1f4]
- Updated dependencies [3a969f1]
- Updated dependencies [7a3a4aa]
- Updated dependencies [abd64a0]
- Updated dependencies [abe8938]
- Updated dependencies [661a99e]
- Updated dependencies [2d7c9de]
- Updated dependencies [fed39e1]
- Updated dependencies [d235d33]
- Updated dependencies [3e3effd]
- Updated dependencies [836fbeb]
- Updated dependencies [a16adf1]
- Updated dependencies [59c83e0]
- Updated dependencies [c8c6a06]
  - @velum-labs/routekit-daemon@1.0.0
  - @velum-labs/routekit-accounts@1.0.0
  - @velum-labs/routekit-gateway@1.0.0
  - @velum-labs/routekit-cli-core@1.0.0
  - @velum-labs/routekit-cli-ui@1.0.0
  - @velum-labs/routekit-config@1.0.0
  - @velum-labs/routekit-contracts@1.0.0
  - @velum-labs/routekit-control@1.0.0
  - @velum-labs/routekit-registry@1.0.0
  - @velum-labs/routekit-runtime@1.0.0
  - @velum-labs/routekit-telemetry-core@1.0.0
  - @velum-labs/routekit-tool-registry@1.0.0
  - @velum-labs/routekit-tools@1.0.0
  - @velum-labs/routekit-eval-contracts@1.0.0
  - @velum-labs/routekit-eval-core@1.0.0
  - @velum-labs/routekit-eval-service@1.0.0
  - @velum-labs/routekit-eval-setup@1.0.0
  - @velum-labs/routekit-eval-store@1.0.0

## 0.18.2

### Patch Changes

- 55bf691: Add zero-downtime daemon worker restarts and upgrades behind a stable cluster
  host, including shared listener handoff, rollback-safe generation commits,
  worker/host status metadata, managed sidecar ownership, retirement draining,
  and rolling lifecycle telemetry.
- Updated dependencies [55bf691]
  - @velum-labs/routekit-control@0.18.2
  - @velum-labs/routekit-daemon@0.18.2
  - @velum-labs/routekit-gateway@0.18.2
  - @velum-labs/routekit-runtime@0.18.2
  - @velum-labs/routekit-telemetry-core@0.18.2
  - @velum-labs/routekit-accounts@0.18.2
  - @velum-labs/routekit-config@0.18.2
  - @velum-labs/routekit-router@0.18.2
  - @velum-labs/routekit-tools@0.18.2
  - @velum-labs/routekit-tool-registry@0.18.2
  - @velum-labs/routekit-cli-core@0.18.2
  - @velum-labs/routekit-cli-ui@0.18.2
  - @velum-labs/routekit-contracts@0.18.2
  - @velum-labs/routekit-registry@0.18.2

## 0.18.1

### Patch Changes

- 7bbc138: Isolate supervised daemons from launchd and systemd provider variables. Direct
  provider credentials and resolved base URLs are captured explicitly, while
  native-client overrides and absent AWS credential-chain inputs are deleted
  before provider configuration loads. Existing supervised services can refresh
  the contract with `routekit daemon service install`.
- 26b0287: Make persistent Codex and Claude installs store dedicated gateway credentials in
  the OS Keychain or a private RouteKit secret file. Codex and Claude now retrieve
  their credentials on demand through native credential helpers, so terminal,
  IDE, and GUI launches work without copying tokens into shell startup files.
  Native install records now carry an install-contract version and RouteKit
  provenance so legacy records can be migrated safely as integrations evolve.
- Updated dependencies [eb319e5]
- Updated dependencies [88235cb]
  - @velum-labs/routekit-gateway@0.18.1
  - @velum-labs/routekit-accounts@0.18.1
  - @velum-labs/routekit-config@0.18.1
  - @velum-labs/routekit-daemon@0.18.1
  - @velum-labs/routekit-router@0.18.1
  - @velum-labs/routekit-cli-core@0.18.1
  - @velum-labs/routekit-cli-ui@0.18.1
  - @velum-labs/routekit-contracts@0.18.1
  - @velum-labs/routekit-control@0.18.1
  - @velum-labs/routekit-registry@0.18.1
  - @velum-labs/routekit-runtime@0.18.1
  - @velum-labs/routekit-telemetry-core@0.18.1
  - @velum-labs/routekit-tool-registry@0.18.1
  - @velum-labs/routekit-tools@0.18.1

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
