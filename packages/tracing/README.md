# `@velum-labs/routekit-tracing`

Brand-neutral OpenTelemetry runtime, propagation, listeners, and export redaction.

This package provides trace carriers, environment/header propagation, readable
span and event helpers, in-process listeners, OTLP exporter policy, and tracing
provider lifecycle utilities. It is generic infrastructure, not RouteKit
product telemetry.

```ts
import {
  carrierFromHeaders,
  initTracing,
  newSessionCarrier,
  toExportableSpan,
  withBaggage
} from "@velum-labs/routekit-tracing";
```

Export policy keeps loopback OTLP endpoints available for local development
while allowing hosts to redact attributes before spans or log records leave the
process.

## Boundaries

- Anonymous product telemetry consent and event schemas live in `@velum-labs/routekit-telemetry-core`.
- Daemon-specific tracing setup belongs to `@velum-labs/routekit-daemon`.
- Gateway and account packages should emit neutral spans/events, not configure exporters directly.

