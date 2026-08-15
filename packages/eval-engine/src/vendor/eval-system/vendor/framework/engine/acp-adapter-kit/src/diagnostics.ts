import type { HarnessName } from "../../../contracts/internal/src/ids.ts";

import { HarnessName as HarnessNameSchema } from "../../../contracts/internal/src/ids.ts";
import {
  DiagnosticText,
  MalformedNativeEventDiagnostic,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  UnknownNativeEventDiagnostic,
} from "../../../contracts/internal/src/runtime/agent-event-diagnostic.ts";

const diagnosticText = (value: string): typeof DiagnosticText.Type =>
  DiagnosticText.make(value.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH));

export interface NativeEventDiagnostics {
  /** Builds the "recognized native event that failed to decode" diagnostic. */
  readonly malformedNativeEventDiagnostic: (
    nativeEvent: string,
    detail: string,
    harness?: string
  ) => MalformedNativeEventDiagnostic;
  /** Builds the "native event we could not recognize" diagnostic, applying the
   * shared harness default and safe-text truncation every call site needs. */
  readonly unknownNativeEventDiagnostic: (
    nativeEvent: string,
    harness?: string
  ) => UnknownNativeEventDiagnostic;
}

/**
 * Every ACP provider adapter reports the same two native-event diagnostics and
 * differs only in which harness name they default to, so the builders are bound
 * once per adapter here rather than restated per adapter package. Call sites may
 * still override the harness per event (the projectors do, for events that name
 * their own harness), which is why the harness stays an optional argument.
 */
export const makeNativeEventDiagnostics = (
  defaultHarness: HarnessName
): NativeEventDiagnostics => ({
  malformedNativeEventDiagnostic: (
    nativeEvent: string,
    detail: string,
    harness: string = defaultHarness
  ): MalformedNativeEventDiagnostic =>
    MalformedNativeEventDiagnostic.make({
      detail: diagnosticText(detail),
      harness: HarnessNameSchema.make(harness),
      nativeEvent: diagnosticText(nativeEvent),
    }),
  unknownNativeEventDiagnostic: (
    nativeEvent: string,
    harness: string = defaultHarness
  ): UnknownNativeEventDiagnostic =>
    UnknownNativeEventDiagnostic.make({
      harness: HarnessNameSchema.make(harness),
      nativeEvent: diagnosticText(nativeEvent),
    }),
});
