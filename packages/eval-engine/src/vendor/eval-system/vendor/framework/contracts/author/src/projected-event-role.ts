import type { ValueOf } from "../../../utils/core/src/types.ts";

/**
 * Semantic role of a projected agent event — who or what produced the line.
 * This is a pure classification: it carries no color, glyph, or any other
 * rendering meaning. A terminal surface maps a role to the color it paints and
 * the glyph it prefixes at render time, so the author contract stays free of any
 * theme concern.
 *
 * These are exactly the roles `projectAgentRuntimeEvent` can emit — no dead
 * members. Surface-generated lines that never come from the projection (a user's
 * own message, streamed reasoning, a system notice) are a surface concern and
 * live in that surface's own vocabulary, not here.
 */
export const ProjectedEventRole = {
  Assistant: "assistant",
  Error: "error",
  Session: "session",
  Success: "success",
  Tool: "tool",
  Warning: "warning",
} as const;
export type ProjectedEventRole = ValueOf<typeof ProjectedEventRole>;
