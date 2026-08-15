import type { DiagnosticLevel } from "../../../../utils/core/src/provider-selection-support.ts";

export interface BootDiagnostic {
  readonly cause?: unknown;
  readonly code: string;
  readonly contributionName?: string | undefined;
  readonly entryKey?: string | undefined;
  readonly featureId?: string | undefined;
  readonly file?: string | undefined;
  readonly level: DiagnosticLevel;
  readonly message: string;
}
