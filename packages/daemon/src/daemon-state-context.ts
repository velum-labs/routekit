import { Context, Layer } from "effect";

import type { DaemonRuntimeState } from "./daemon-runtime-state.js";

export type DaemonStateService = Omit<DaemonRuntimeState, "awaitMutations"> & {
  readonly awaitMutations: ReturnType<DaemonRuntimeState["awaitMutations"]>;
};

export class DaemonState extends Context.Service<DaemonState, DaemonStateService>()(
  "@velum-labs/routekit-daemon/DaemonState"
) {
  static layer(state: DaemonRuntimeState) {
    return Layer.succeed(
      DaemonState,
      DaemonState.of({
        get config() {
          return state.config;
        },
        set config(config) {
          state.config = config;
        },
        get document() {
          return state.document;
        },
        set document(document) {
          state.document = document;
        },
        get revisions() {
          return state.revisions;
        },
        set revisions(revisions) {
          state.revisions = revisions;
        },
        get lifecycle() {
          return state.lifecycle;
        },
        get draining() {
          return state.draining;
        },
        get closed() {
          return state.closed;
        },
        beginShutdown: state.beginShutdown.bind(state),
        beginRetire: state.beginRetire.bind(state),
        markDraining: state.markDraining.bind(state),
        markClosed: state.markClosed.bind(state),
        pause: state.pause.bind(state),
        resume: state.resume.bind(state),
        awaitMutations: state.awaitMutations(),
        serializeEffect: state.serializeEffect.bind(state),
        snapshot: state.snapshot.bind(state)
      })
    );
  }
}
