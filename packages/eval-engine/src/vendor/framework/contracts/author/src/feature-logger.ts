// Features MUST use the injected `logger` for diagnostics and MUST NOT use
// `console.*` or write directly to the standard output/error streams (RFC 0011):
// the host bridges these calls to the framework-wide logger without corrupting
// any TUI.

/** Structured key/value context attached to a single feature log call. */
export type FeatureLogFields = Readonly<Record<string, unknown>>;

/**
 * Diagnostic logger handed to a feature through its handler context. Calls are
 * fire-and-forget (they return `void`, never a Promise or Effect) so a feature
 * never has to await logging. `child` derives a sub-scoped logger that inherits
 * and merges fields — useful for tagging a unit of work.
 */
export interface FeatureLogger {
  readonly trace: (message: string, fields?: FeatureLogFields) => void;
  readonly debug: (message: string, fields?: FeatureLogFields) => void;
  readonly info: (message: string, fields?: FeatureLogFields) => void;
  readonly warn: (message: string, fields?: FeatureLogFields) => void;
  readonly error: (
    message: string,
    error?: unknown,
    fields?: FeatureLogFields
  ) => void;
  readonly child: (scope: string, fields?: FeatureLogFields) => FeatureLogger;
}
