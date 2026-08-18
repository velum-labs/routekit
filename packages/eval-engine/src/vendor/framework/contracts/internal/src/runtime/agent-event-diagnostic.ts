import { Schema } from "effect";

import { HarnessName } from "../ids.ts";

import {
  AgentEventSafeText,
  MAX_AGENT_EVENT_TEXT_LENGTH,
} from "./schema-primitives.ts";

const MAX_DIAGNOSTIC_TEXT_LENGTH = MAX_AGENT_EVENT_TEXT_LENGTH;
const DiagnosticText = AgentEventSafeText;

const UnknownNativeEventDiagnostic = Schema.TaggedStruct(
  "UnknownNativeEventDiagnostic",
  {
    harness: HarnessName,
    nativeEvent: DiagnosticText,
  }
).annotate({ identifier: "UnknownNativeEventDiagnostic" });

const MalformedNativeEventDiagnostic = Schema.TaggedStruct(
  "MalformedNativeEventDiagnostic",
  {
    detail: DiagnosticText,
    harness: HarnessName,
    nativeEvent: DiagnosticText,
  }
).annotate({ identifier: "MalformedNativeEventDiagnostic" });

const AgentEventDiagnostic = Schema.Union([
  UnknownNativeEventDiagnostic,
  MalformedNativeEventDiagnostic,
])
  .annotate({ identifier: "AgentEventDiagnostic" })
  .pipe(Schema.toTaggedUnion("_tag"));

export {
  AgentEventDiagnostic,
  DiagnosticText,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  MalformedNativeEventDiagnostic,
  UnknownNativeEventDiagnostic,
};
export type AgentEventDiagnostic = typeof AgentEventDiagnostic.Type;
export type MalformedNativeEventDiagnostic =
  typeof MalformedNativeEventDiagnostic.Type;
export type UnknownNativeEventDiagnostic =
  typeof UnknownNativeEventDiagnostic.Type;
