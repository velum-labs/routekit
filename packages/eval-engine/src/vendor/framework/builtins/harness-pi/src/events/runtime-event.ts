import type { AgentRuntimeEvent } from "../../../ori/src/index.ts";

import type { PiRawPayload } from "./raw-event.ts";

export const runtimeEvent = <Event extends AgentRuntimeEvent>(
  type: Event["type"],
  payload: Event["payload"],
  raw: PiRawPayload
): Event => {
  const event = {
    payload,
    raw: {
      payload: raw,
      source: "pi",
    },
    type,
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return event as Event;
};
