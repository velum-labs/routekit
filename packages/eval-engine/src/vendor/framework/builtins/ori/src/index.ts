// oxlint-disable no-barrel-file -- the `ori` SDK alias is, by design (RFC 0002), a pure re-export of the author contract surface; a barrel is the intended shape.
// RFC 0002 (Harness Authoring Surface): the in-repo `ori` SDK alias. Builtins
// import this package exactly as an external feature project imports the
// generated `.ori/sdk`, so the built-in harnesses stay exemplary user-space
// features rather than privileged internal code.
export * from "../../../contracts/author/src/index.ts";
// HarnessProtocolError and the agent-event projection live at the author tier
// but are NOT in the author index barrel, so they are re-exported explicitly
// here (mirroring how the generated SDK's merged `index` carries them). The
// projection's pure functions ship through the type-merged `ori` entry per
// RFC 0002.
export { HarnessProtocolError } from "../../../contracts/author/src/harness-protocol-error.ts";
export type { ProjectedAgentEvent } from "../../../contracts/author/src/agent-event-projection.ts";
export {
  ProjectedEventKind,
  ProjectedEventRole,
  projectAgentRuntimeEvent,
} from "../../../contracts/author/src/agent-event-projection.ts";
