// Aggregates the harness runtime plumbing so builtins and external feature
// projects import the SAME surface (`routekit-eval/process`) instead of reaching into
// framework-internal packages. Named (not wildcard) re-exports keep the
// explicit public surface and avoid the `no-barrel-file` lint.
export type {
  HarnessProcessBinaryRequirement,
  HarnessProcessResult,
  StreamJsonlProcessInput,
} from "./process-stream.ts";

export {
  mergeAnthropicCustomHeaders,
  normalizeEnvValue,
  parseBooleanEnv,
  parseTimeoutMs,
} from "./harness-env.ts";
export {
  formatOutputSchemaInstruction,
  withOutputSchemaInstruction,
} from "./output-schema.ts";
export { stderrTail } from "./process-stderr-tail.ts";
export {
  detectMissingHarnessProcessBinary,
  streamJsonlProcess,
} from "./process-stream.ts";
