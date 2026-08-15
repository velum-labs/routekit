import { Effect, Layer } from "effect";

import type { ClaudeSessionStateError } from "./errors.ts";
import type { ClaudeSessionRegistry } from "./session-registry.ts";
import type {
  SelectedAdapterContribution,
  SelectedAdapterOptions,
} from "../../../../engine/selected-adapter/src/inventory.ts";

import { makeClaudeSessionState } from "./session-registry.ts";
import {
  SelectedAdapter,
  SelectedAdapterError,
} from "../../../../engine/selected-adapter/src/inventory.ts";

const stateFailure = (error: ClaudeSessionStateError): SelectedAdapterError =>
  new SelectedAdapterError({
    detail: error.detail,
    reason: "malformed-input",
  });

/**
 * Gives Claude's contribution the durable adapter state RFC 0003 requires.
 * Claude needs no opaque native payload: its ACP session id is the `--resume`
 * target, so the stored state is that id, and restoring it re-seeds the
 * known-session registry the ROUTEKIT_EVAL-405 guard checks. Without it a resource
 * rebuilt from an ownership record refuses a session it demonstrably owns.
 *
 * This wraps the outermost contribution because the registry belongs to the
 * contribution rather than to any one peer: every rebuild spawns a new process
 * with a new handler, so attaching the hooks any deeper (or to the shared ACP
 * contribution, which knows nothing of Claude's registry) would leave nothing
 * to persist and nothing to re-seed.
 */
const withClaudeSessionState = (
  base: SelectedAdapterContribution,
  sessions: ClaudeSessionRegistry
): SelectedAdapterContribution => {
  const state = makeClaudeSessionState(sessions);
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

export { withClaudeSessionState };
