# @velum-labs/routekit-accounts

## 1.0.19

### Patch Changes

- 3235153: Keep credential-load and per-account model-discovery failures visible in daemon
  logs while allowing unavailable or empty Codex and Claude subscription catalogs
  to coexist with healthy configured providers.
  - @velum-labs/routekit-contracts@1.0.19
  - @velum-labs/routekit-registry@1.0.19
  - @velum-labs/routekit-runtime@1.0.19

## 1.0.18

### Patch Changes

- @velum-labs/routekit-contracts@1.0.18
- @velum-labs/routekit-registry@1.0.18
- @velum-labs/routekit-runtime@1.0.18

## 1.0.17

### Patch Changes

- @velum-labs/routekit-contracts@1.0.17
- @velum-labs/routekit-registry@1.0.17
- @velum-labs/routekit-runtime@1.0.17

## 1.0.16

### Patch Changes

- @velum-labs/routekit-contracts@1.0.16
- @velum-labs/routekit-registry@1.0.16
- @velum-labs/routekit-runtime@1.0.16

## 1.0.15

### Patch Changes

- @velum-labs/routekit-contracts@1.0.15
- @velum-labs/routekit-registry@1.0.15
- @velum-labs/routekit-runtime@1.0.15

## 1.0.14

### Patch Changes

- @velum-labs/routekit-contracts@1.0.14
- @velum-labs/routekit-registry@1.0.14
- @velum-labs/routekit-runtime@1.0.14

## 1.0.13

### Patch Changes

- @velum-labs/routekit-contracts@1.0.13
- @velum-labs/routekit-registry@1.0.13
- @velum-labs/routekit-runtime@1.0.13

## 1.0.12

### Patch Changes

- @velum-labs/routekit-contracts@1.0.12
- @velum-labs/routekit-registry@1.0.12
- @velum-labs/routekit-runtime@1.0.12

## 1.0.11

### Patch Changes

- Updated dependencies [a148a71]
  - @velum-labs/routekit-runtime@1.0.11
  - @velum-labs/routekit-contracts@1.0.11
  - @velum-labs/routekit-registry@1.0.11

## 1.0.10

### Patch Changes

- Updated dependencies [0a83607]
  - @velum-labs/routekit-runtime@1.0.10
  - @velum-labs/routekit-contracts@1.0.10
  - @velum-labs/routekit-registry@1.0.10

## 1.0.9

### Patch Changes

- @velum-labs/routekit-contracts@1.0.9
- @velum-labs/routekit-registry@1.0.9
- @velum-labs/routekit-runtime@1.0.9

## 1.0.8

### Patch Changes

- @velum-labs/routekit-contracts@1.0.8
- @velum-labs/routekit-registry@1.0.8
- @velum-labs/routekit-runtime@1.0.8

## 1.0.7

### Patch Changes

- @velum-labs/routekit-contracts@1.0.7
- @velum-labs/routekit-registry@1.0.7
- @velum-labs/routekit-runtime@1.0.7

## 1.0.6

### Patch Changes

- @velum-labs/routekit-contracts@1.0.6
- @velum-labs/routekit-registry@1.0.6
- @velum-labs/routekit-runtime@1.0.6

## 1.0.5

### Patch Changes

- @velum-labs/routekit-contracts@1.0.5
- @velum-labs/routekit-registry@1.0.5
- @velum-labs/routekit-runtime@1.0.5

## 1.0.4

### Patch Changes

- @velum-labs/routekit-contracts@1.0.4
- @velum-labs/routekit-registry@1.0.4
- @velum-labs/routekit-runtime@1.0.4

## 1.0.3

### Patch Changes

- @velum-labs/routekit-contracts@1.0.3
- @velum-labs/routekit-registry@1.0.3
- @velum-labs/routekit-runtime@1.0.3

## 1.0.2

### Patch Changes

- @velum-labs/routekit-contracts@1.0.2
- @velum-labs/routekit-registry@1.0.2
- @velum-labs/routekit-runtime@1.0.2

## 1.0.1

### Patch Changes

- @velum-labs/routekit-contracts@1.0.1
- @velum-labs/routekit-registry@1.0.1
- @velum-labs/routekit-runtime@1.0.1

## 1.0.0

### Major Changes

- 79fe1c7: Remove retired compatibility surfaces and introduce explicit resource ownership,
  transactional router generations and remote enrollment, and cancellation-safe
  harness sessions. Move router configuration ownership into config-core, add
  validated provider boundary codecs and streaming, decompose routing and HTTP
  endpoints into explicit ports, make daemon/CLI application services declarative,
  and enforce intentional package APIs in CI.

### Minor Changes

- 836fbeb: Make subscription proxy gateway construction an explicit injected port so account pooling and relays no longer depend on the gateway implementation package at runtime.

### Patch Changes

- f122b9a: Move Anthropic and Codex rate-limit parsers out of the shared provider module so each adapter owns its wire translation and shared.ts keeps the port plus generic helpers.
- abd64a0: Migrate RouteKit internals onto Effect with a process-lifetime ManagedRuntime (`RouteKitLive`), tagged failures, FileSystem-backed document persistence, Effect `CapacityPool` leases, HttpClient egress, HttpRouter+NodeHttpServer inbound (drain/SSE/NDJSON wire unchanged), Effect account coordinators, account-set construction/probe/discover/close, subscription providers, proxy client, native Effect `control.v2` handlers (Promise only at the NDJSON wire), Effect reset-credit and auth-recovery programs, CLI catalog/health probes, cliproxy sidecar reachability, control-client health/call/stream as Effect (Promise only at Commander/host/NDJSON iterator edges), remaining CLI install/relay/handshake plus daemon shared-gateway probes as Effect, switching-proxy, endpoint/runtime health probes, ACP registry fetch/install, gateway web-search execution (one Effect per server-tool step on the HttpClient captured when the gateway HTTP app is built), OpenRouter metadata (single-flight Effect, not a nested runtime), provider HTTP transports on the inbound fiber, subscription execute/relays, daemon lifecycle/generations/sidecar/host-worker cores, daemon account enroll/remove/rename/sync plus subscription SSE inspect, subscription usage collection, local usage sources, `startSubscriptionProxy`, gateway-generation usage, relay close, CLI use-cases (accounts login/activate, config import, native install/uninstall, setup, remote enroll/remove/provision), remote enrollment/recovery transaction machines, provider model discovery plus `RoutingBackend.create`, host generation stages as Effect programs, and account-set/activity/auth-health/relay/executor Promise edges on captured fiber context via `runRouteKitEffectWith` instead of a nested ManagedRuntime. `Backend.chat`/`models`/`embeddings` (and `BackendResponsesPort.execute`) are `BackendRequest` Effects requiring `RouteKitPlatform`. Inbound `GatewayEndpoint.handle`/`executeOperation` stay on that captured fiber (`serveEndpoint` provides the platform). Server-tool `runStep` is Effect; `composeServerToolStream` runs `runRouteKitEffect*` only at ReadableStream start. Anthropic/Codex subscription relays are Effects. Account-set usage probes use `Deferred` plus a detached probe fiber (interrupted on close); activity persist debounce is a detached fiber woken from `beginAttempt`; gateway `usage` and `RelayLifecycle.close` are Effects (Node bind/close still Promise); daemon generation `persist` and `replaceRouter` are Effects so enroll/mutation no longer `runRouteKitEffectWith` inside persist hooks; post-handoff subscription stream observe work is queued onto a detached fiber instead of `runRouteKitEffectWith`; CLI `launchTool`/`resolveCodexLaunchSelection` are Effects (`runCliEffect` at Commander, spawn still Promise); `routekitClient`/`connectDaemon` are lazy Effect values. Promise remains at Commander, NDJSON, Node bind, Fetch body reads, SSE stream controllers, and `[Symbol.asyncDispose]`. `cliTry`/`controlTry`/`gatewayTry` tag failures as `RouteKitFailure`; `routeKitError` still unwraps wrap-only `RouteKitFailure` so Error subclasses map on the wire. OpenRouter metadata refresh uses Effect timeout (not unref'd `AbortSignal.timeout`) so hanging fetches still settle. CLI `routekitClient`/`ensureDaemon`/`connectDaemon` are Effect programs (`runCliEffect` only at Commander) and fail with tagged `RouteKitFailure` so Effect tsgo `globalErrorInEffectFailure` stays at 0 errors. `runRouteKitEffect`/`runCliEffect` do not constrain `R` to `RouteKitPlatform` so programs that `yield*` HttpClient (Effect 4 `Request<"Requires", _>`) typecheck at the process edge. Drop wrap-only Effect façades and unused `runBackendRequest`. Schema eval contracts and Effect language-service diagnostics (`globalErrorInEffectFailure`, `globalErrorInEffectCatch`, and `tryCatchInEffectGen` as error; `globalFetch` stays off for tests and the live Fetch adapter, with `globalFetchInEffect` already error). Product wire (control.v2, HTTP/SSE, CLI output, persisted formats) stays unchanged. Domain coordinators are wrapped behind Effect 4 `Context.Service` keys (`AccountActivity`, `AccountAuth`, `DaemonEnv`/`DaemonState`/`Sidecar`/`Generations`/`ActiveGateway`/`Tokens`/`Telemetry`/`DataPlane`/`AccountRecovery`/`CallAttributions`/`Leaderboard`/`DaemonPolicy`/`DaemonHost`, CLI `DaemonClient` via `CliLive`) composed as `daemonLive` so control handlers `yield*` services; CLI Commander actions run one program via `runCliClient` or one `runCliEffect` per action. Service-facing coordinator types expose only public operations (with direct Effect semantics for zero-argument work), so Effect diagnostics are 0 errors, 0 warnings, and 0 messages. Telemetry mutations use `serializeEffect`; Promise `serializeMutation` is gone. `EffectResourceScope.own` prefers an Effect-returning `close()`; Promise finalizers are only the Node listen/close adapter. Gateway-generation and subscription-proxy `close` use `runRouteKitEffect` (no `runPromiseWith`). Activity/auth/account-set `[Symbol.asyncDispose]` uses `runRouteKitEffect`. `DaemonEnv` carries generation/startedAt/hosted; `ActiveGateway` holds the live router, switching proxy, data URL, and control server. Generation replace scopes an unpublished candidate with `Effect.addFinalizer` and adopts it after `swapTarget`. `waitForServiceReadyEffect` and `waitForProcessExitEffect` are the readiness/exit pollers; the Promise wrappers are process-edge adapters. CLI service install/uninstall/status, config init/edit, daemon exec, and `usage --watch` are one Commander program each (`watchUsageEffect` ticks on the same fiber). Inbound `serveEndpoint` provides the `RouteKitPlatform` captured when the gateway HTTP app is built (HttpClient included), so relays and provider backends no longer store or `provideCapturedPlatform`. Daemon bootstrap is one Effect program (`runRouteKitEffect` once; Node listen via `tryPromise`; Promise only on returned close/retire/reload). `runCapturedPlatform` is a test helper, not a public export.

  Provider resources, backend ownership, gateway drain/close, router close, subscription-proxy close, relay teardown, and Node HTTP handler teardown are Effect values. `startGatewayEffect` is the internal constructor; the Promise `startGateway` function is only the standalone Node host adapter. Captured request platform contexts omit the construction scope so a router generation can publish a handler beyond its prepare scope without retaining or closing that scope.

  The switching proxy and control listener now expose Effect construction, idle waits, retirement, drain, and close; daemon bootstrap consumes those Effects directly. Endpoint pipeline stages, Anthropic catalog merging, account acquisition revalidation, and auth-recovery waiters are Effect-native, with `Deferred` replacing Promise coordination. Promise adapters remain only where Node, Commander, Fetch/Web Streams, AsyncDisposable, cluster IPC, or standalone public hosts require them.

- Updated dependencies [79fe1c7]
- Updated dependencies [abd64a0]
- Updated dependencies [abe8938]
- Updated dependencies [661a99e]
- Updated dependencies [3e3effd]
  - @velum-labs/routekit-contracts@1.0.0
  - @velum-labs/routekit-registry@1.0.0
  - @velum-labs/routekit-runtime@1.0.0

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
