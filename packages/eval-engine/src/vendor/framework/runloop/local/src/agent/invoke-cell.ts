import { Context, Effect, Layer, MutableRef, Option } from "effect";

import type { AgentInvokeStream } from "../schedule/invoke.ts";

export interface AgentInvokeCellShape {
  /**
   * Publish the invoke a freshly built schedule runtime exposes. Last write
   * wins: the daemon publishes once when it establishes its runtime, and `ori
   * dev` publishes when it arms its own.
   */
  readonly publish: (invoke: AgentInvokeStream) => Effect.Effect<void>;
  /**
   * Read the published invoke, or `undefined` while none exists yet.
   *
   * Synchronous by necessity rather than by preference: the only reader is the
   * author-facing `invoke` inside a hook handler context, a plain callback with
   * no ambient Effect to yield a service from. The cell exists for that
   * ordering gap — hook contexts are built during feature boot, which finishes
   * before any schedule runtime is acquired.
   */
  readonly read: () => AgentInvokeStream | undefined;
}

/**
 * The one place a daemon's agent `invoke` is published and read.
 *
 * Scoped to the layer that builds it, so a process running two runtimes (every
 * test file that provides the runtime layer twice, and the CLI when it boots a
 * second daemon) gets two independent cells instead of one shared slot the
 * later runtime silently steals from the earlier one.
 */
export class AgentInvokeCell extends Context.Service<
  AgentInvokeCell,
  AgentInvokeCellShape
>()("ori/runtime/AgentInvokeCell") {
  static readonly layer = Layer.sync(AgentInvokeCell, () => {
    const cell = MutableRef.make(Option.none<AgentInvokeStream>());
    return AgentInvokeCell.of({
      publish: (invoke) =>
        Effect.sync(() => {
          MutableRef.set(cell, Option.some(invoke));
        }),
      read: () => Option.getOrUndefined(MutableRef.get(cell)),
    });
  });
}

/**
 * Resolve a published invoke or throw. Used by the author-facing hook `invoke`,
 * which is a plain synchronous callback with no failure channel: a hook that
 * fires before any schedule runtime exists has nothing to run the turn against,
 * and a silent no-op would swallow it.
 */
export const requireAgentInvoke = (
  read: () => AgentInvokeStream | undefined
): AgentInvokeStream => {
  const invoke = read();
  if (invoke === undefined) {
    throw new Error(
      "Hook handler invoke is unavailable until the schedule runtime is ready"
    );
  }
  return invoke;
};
