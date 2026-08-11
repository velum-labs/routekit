# @velum-labs/routekit-tracing

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `a4ae207fced468216bc34b40dcaab3165c8ccba145115331b708f123973715ae`

## Root declarations

```ts
export type { AttributePolicy } from "./exportable.js";
export type { AttributeSource, ReadableEvent, ReadableSpan } from "./readable.js";
export type { EventListener, SpanListener } from "./listener.js";
export type { InitTracingOptions } from "./provider.js";
export type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
export type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
export type { TraceCarrier } from "./carrier.js";
export { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
export { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
export { addEventListener, addSpanListener, hasEventListeners, hasSpanListeners, listenerLogRecordProcessor, listenerSpanProcessor, removeEventListener, removeSpanListener } from "./listener.js";
export { attrBool, attrJson, attrNum, attrStr, eventNameOf, eventSpanId, eventTimeMs, eventTraceId, spanEndMs, spanId, spanTraceId } from "./readable.js";
export { baggageOf, carrierFromEnv, carrierFromHeaders, carrierOf, contextOf, envOf, headersOf, newSessionCarrier, newSpanId, newTraceId, sessionCarrier, traceIdOf, withBaggage } from "./carrier.js";
export { flushTracing, initTracing, isEventExportConfigured, isTraceExportConfigured, isTracingActive, resetTracingForTest, shutdownTracing, tracingServiceName } from "./provider.js";
export { isLoopbackOtlpEndpoint, PolicyLogExporter, PolicySpanExporter, toExportableEvent, toExportableSpan } from "./exportable.js";
```
