// RFC 0002 (Harness Authoring Surface): mirrors the generated SDK's
// `routekit-eval/enums` module: builtins import enum values from here exactly as an
// external feature project does. The generated `enums.ts.txt` collects these
// six const objects from the merged author contract sources; this hand-written
// alias sources them directly from their owning author modules. Each name is
// both a `const` value and a `ValueOf<>` type alias, so a single re-export
// carries both meanings.
export { AgentRuntimeEventTag } from "../../../contracts/author/src/agent-event.ts";
export { AgentSessionItemStatus } from "../../../contracts/author/src/agent-session/index.ts";
export { HarnessType, HookType } from "../../../contracts/author/src/agent-harness.ts";
export { Capability } from "../../../contracts/author/src/feature-manifest.ts";
