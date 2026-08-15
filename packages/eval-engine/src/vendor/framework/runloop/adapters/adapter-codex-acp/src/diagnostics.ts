import { HarnessName } from "../../../../contracts/internal/src/ids.ts";
import {
  DiagnosticText,
  MalformedNativeEventDiagnostic,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  UnknownNativeEventDiagnostic,
} from "../../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

const CODEX_HARNESS = "codex";

const diagnosticText = (value: string): typeof DiagnosticText.Type =>
  DiagnosticText.make(value.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH));

/** Builds the "native event we could not recognize" diagnostic, applying the
 * shared harness default and safe-text truncation every call site needs. */
const unknownNativeEventDiagnostic = (
  nativeEvent: string,
  harness: string = CODEX_HARNESS
): UnknownNativeEventDiagnostic =>
  UnknownNativeEventDiagnostic.make({
    harness: HarnessName.make(harness),
    nativeEvent: diagnosticText(nativeEvent),
  });

/** Builds the "recognized native event that failed to decode" diagnostic. */
const malformedNativeEventDiagnostic = (
  nativeEvent: string,
  detail: string,
  harness: string = CODEX_HARNESS
): MalformedNativeEventDiagnostic =>
  MalformedNativeEventDiagnostic.make({
    detail: diagnosticText(detail),
    harness: HarnessName.make(harness),
    nativeEvent: diagnosticText(nativeEvent),
  });

export { malformedNativeEventDiagnostic, unknownNativeEventDiagnostic };
