import { Option } from "effect";

import type { AgentRuntimeEvent } from "../../../../contracts/author/src/agent-event.ts";
import type {
  AgentRun,
  ScheduleInvokeInput,
} from "../../../../contracts/author/src/schedule.ts";

import { makeAgentRun } from "../agent/run.ts";

export type AgentInvokeStream = (
  input: ScheduleInvokeInput
) => AsyncIterable<AgentRuntimeEvent>;

export const makeAuthorInvoke =
  (input: {
    readonly invoke: AgentInvokeStream;
    readonly onEvent?: ((event: AgentRuntimeEvent) => void) | undefined;
  }): (<A = unknown>(invoke: ScheduleInvokeInput<A>) => AgentRun<A>) =>
  <A = unknown>(invokeInput: ScheduleInvokeInput<A>): AgentRun<A> =>
    makeAgentRun<A>({
      onEvent: input.onEvent,
      output: Option.fromNullishOr(invokeInput.output),
      prompt: invokeInput.prompt,
      source: (prompt) =>
        input.invoke({
          ...invokeInput,
          prompt,
        }),
    });
