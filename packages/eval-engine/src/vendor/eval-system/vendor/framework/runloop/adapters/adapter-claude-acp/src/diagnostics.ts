import { HarnessName } from "../../../../contracts/internal/src/ids.ts";
import { makeNativeEventDiagnostics } from "../../../../engine/acp-adapter-kit/src/diagnostics.ts";

const { malformedNativeEventDiagnostic, unknownNativeEventDiagnostic } =
  makeNativeEventDiagnostics(HarnessName.make("claude"));

export { malformedNativeEventDiagnostic, unknownNativeEventDiagnostic };
