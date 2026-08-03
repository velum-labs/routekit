# `@velum-labs/routekit-telemetry-core`

Parameterized telemetry consent, redaction, and anonymous event plumbing.

This package owns opt-in consent files, environment overrides, `DO_NOT_TRACK`
handling, category toggles, install identity reset, schema inventory, event
payload validation, redaction policy, and bounded shutdown helpers. It does not
send events itself; product hosts provide the destination and transport.

```ts
import {
  buildTelemetryEvent,
  telemetryStatusMetadata,
  anonymousEventProperties,
  createConsentManager,
  durationBucket
} from "@velum-labs/routekit-telemetry-core";
```

Telemetry is off by default unless a host enables it through a persisted
consent file or explicit environment variable. Disabled telemetry must avoid
stable identity creation and discard queued events.

## Boundaries

- RouteKit daemon telemetry transport lives in `@velum-labs/routekit-daemon`.
- OpenTelemetry tracing and span export policy live in `@velum-labs/routekit-tracing`.
- Product telemetry inventory is documented in `../../docs/telemetry-inventory.md`.
