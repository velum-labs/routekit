import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { AgentEventBus } from "../../../../engine/events/src/event-bus.ts";
import {
  DEFAULT_JOURNAL_MAX_EVENTS,
  makeRuntimeEventJournalLayer,
} from "../../../../engine/events/src/event-journal.ts";

const JOURNAL_MAX_EVENTS_ENV = "ROUTEKIT_EVAL_JOURNAL_MAX_EVENTS";

export const resolveJournalMaxEvents = (env: NodeJS.ProcessEnv): number => {
  const parsed = Number(env[JOURNAL_MAX_EVENTS_ENV] ?? "");
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_JOURNAL_MAX_EVENTS;
};

export const runtimeEventJournalLayer = makeRuntimeEventJournalLayer({
  maxEvents: resolveJournalMaxEvents(globalThis.process.env),
}).pipe(Layer.provide(Layer.mergeAll(AgentEventBus.layer, nodeServicesLayer)));
