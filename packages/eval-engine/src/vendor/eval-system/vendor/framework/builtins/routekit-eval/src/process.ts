// Mirrors the generated SDK's `routekit-eval/process` module so builtins import the same
// surface an external feature project does. Named re-exports keep the explicit
// surface and avoid the `no-barrel-file` lint.
export type {
  HarnessProcessBinaryRequirement,
  HarnessProcessResult,
  StreamJsonlProcessInput,
} from "../../../contracts/author/src/process-aggregate.ts";

export {
  detectMissingHarnessProcessBinary,
  formatOutputSchemaInstruction,
  mergeAnthropicCustomHeaders,
  normalizeEnvValue,
  parseBooleanEnv,
  parseTimeoutMs,
  stderrTail,
  streamJsonlProcess,
  withOutputSchemaInstruction,
} from "../../../contracts/author/src/process-aggregate.ts";
