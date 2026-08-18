import { Effect, Layer } from "effect";

import type { PiSessionStateError } from "./errors.ts";
import type { PiSessionRegistry } from "./session-registry.ts";
import type {
  SelectedAdapterContribution,
  SelectedAdapterOptions,
} from "../../../../engine/selected-adapter/src/inventory.ts";

import { makePiSessionState } from "./session-registry.ts";
import {
  SelectedAdapter,
  SelectedAdapterError,
} from "../../../../engine/selected-adapter/src/inventory.ts";

const stateFailure = (error: PiSessionStateError): SelectedAdapterError =>
  new SelectedAdapterError({
    detail: error.detail,
    reason: "malformed-input",
  });

/**
 * Gives Pi's contribution the durable adapter state RFC 0003 requires: the
 * coordinator stores what `captureState` returns opaquely in the ownership
 * record and hands it back to `restoreState` before resuming a rebuilt
 * resource, so a session survives the process that created it.
 *
 * This wraps the outermost contribution because the registry belongs to the
 * contribution rather than to any one adapter instance: peer replacement under
 * a clamped cap builds a new adapter and its service does not carry these
 * methods, so attaching them any deeper would leave nothing to persist.
 */
const withPiSessionState = (
  base: SelectedAdapterContribution,
  sessions: PiSessionRegistry
): SelectedAdapterContribution => {
  const state = makePiSessionState(sessions);
  return {
    layer: (
      options: SelectedAdapterOptions
    ): Layer.Layer<SelectedAdapter, SelectedAdapterError> =>
      Layer.effect(SelectedAdapter)(
        Effect.gen(function* () {
          const adapter = yield* SelectedAdapter;
          return SelectedAdapter.of({
            ...adapter,
            captureState: state.capture,
            restoreState: (input) =>
              state.restore(input).pipe(Effect.mapError(stateFailure)),
          });
        })
      ).pipe(Layer.provide(base.layer(options))),
    name: base.name,
  };
};

export { withPiSessionState };
