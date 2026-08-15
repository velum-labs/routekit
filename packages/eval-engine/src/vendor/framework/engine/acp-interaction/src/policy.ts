import { Context, Effect, Layer } from "effect";

import type { SessionId } from "../../../contracts/internal/src/ids.ts";
import type { InteractionKind } from "../../interaction/src/model.ts";

/**
 * The scope the bridge asks the policy about before it presents an interactive
 * request. It carries only the safe routing identity — never the operation
 * detail, form fields, or any provider payload.
 */
export interface InteractionSurfaceScope {
  readonly kind: InteractionKind;
  readonly sessionId: SessionId;
  readonly toolCallId?: string | undefined;
}

export interface InteractionSurfacePolicyShape {
  /**
   * Whether a surface can currently present an interaction for this scope. When
   * it resolves `false`, the bridge returns the deterministic safe fallback
   * (a permission `cancelled` outcome, an elicitation `decline`) instead of
   * registering and blocking the agent forever. It MUST NOT be used to
   * auto-approve: there is no availability answer that grants a permission.
   */
  readonly isAvailable: (
    scope: InteractionSurfaceScope
  ) => Effect.Effect<boolean>;
}

/**
 * The injected surface-availability port (RFC 0003 Interactive Request
 * Lifecycle, "Surfaces"). A runloop/TUI (S6) supplies a layer that reports a
 * mounted surface; until then the default {@link
 * InteractionSurfacePolicy.layerDeny} reports none, so every request settles
 * with its safe deterministic fallback rather than hanging or approving.
 */
export class InteractionSurfacePolicy extends Context.Service<
  InteractionSurfacePolicy,
  InteractionSurfacePolicyShape
>()("ori/engine/acp-interaction/InteractionSurfacePolicy") {
  /**
   * Default, security-first policy: no surface is ever available, so the bridge
   * always takes the deterministic fallback. This is the safe boot default —
   * never auto-approve because no surface is wired.
   */
  static readonly layerDeny: Layer.Layer<InteractionSurfacePolicy> =
    Layer.succeed(InteractionSurfacePolicy)(
      InteractionSurfacePolicy.of({ isAvailable: () => Effect.succeed(false) })
    );

  /** Build a policy from a caller-supplied availability check (S6 wiring). */
  static readonly layer = (
    isAvailable: (scope: InteractionSurfaceScope) => Effect.Effect<boolean>
  ): Layer.Layer<InteractionSurfacePolicy> =>
    Layer.succeed(InteractionSurfacePolicy)(
      InteractionSurfacePolicy.of({ isAvailable })
    );

  /**
   * Test/dev seam: always report a surface. Real availability is a runloop/TUI
   * decision (S6); this only says "present it" so the bridge registers and
   * awaits a programmatic responder.
   */
  static readonly layerAlways: Layer.Layer<InteractionSurfacePolicy> =
    Layer.succeed(InteractionSurfacePolicy)(
      InteractionSurfacePolicy.of({ isAvailable: () => Effect.succeed(true) })
    );
}
