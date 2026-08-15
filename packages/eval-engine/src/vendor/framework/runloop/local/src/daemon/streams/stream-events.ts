import type { Stream } from "effect";

import type { OriDaemonShape } from "../core/service.ts";

type RuntimeStreamEvent =
  ReturnType<OriDaemonShape["invoke"]> extends Stream.Stream<
    infer Event,
    unknown
  >
    ? Event
    : never;
type AgentRuntimeEvent = Extract<
  RuntimeStreamEvent,
  { readonly type: "runtime.event" }
>["event"];

export const makeRuntimeStreamEvents = (
  event: AgentRuntimeEvent
): readonly RuntimeStreamEvent[] => [
  {
    event,
    type: "runtime.event",
  },
];
