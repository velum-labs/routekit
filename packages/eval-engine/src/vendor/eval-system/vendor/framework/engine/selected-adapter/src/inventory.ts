import type { Stream } from "effect";

import { Context, Effect, Layer, Schema } from "effect";

import type { AgentParameters } from "../../../contracts/author/src/index.ts";
import type {
  AgentRuntimeEvent,
  ElicitationResolvedAction,
  PermissionOptionKind,
} from "../../../contracts/author/src/agent-event.ts";
import type { HarnessName } from "../../../contracts/internal/src/ids.ts";
import type { AgentAdapterEvent } from "../../../contracts/internal/src/runtime/agent-adapter-event.ts";

import { AgentFailureSchema } from "../../../contracts/internal/src/author-schemas/agent-runtime-event.ts";
import { HarnessName as HarnessNameSchema } from "../../../contracts/internal/src/ids.ts";

class SelectedAdapterError extends Schema.TaggedErrorClass<SelectedAdapterError>()(
  "SelectedAdapterError",
  {
    detail: Schema.String,
    safeFailure: Schema.optionalKey(AgentFailureSchema),
    reason: Schema.Literals([
      "malformed-input",
      "invalid-state",
      "peer-exit",
      "connection",
    ]),
  }
) {}

class MissingSelectedAdapterError extends Schema.TaggedErrorClass<MissingSelectedAdapterError>()(
  "MissingSelectedAdapterError",
  { harness: HarnessNameSchema }
) {}

class MissingSessionOwnershipError extends Schema.TaggedErrorClass<MissingSessionOwnershipError>()(
  "MissingSessionOwnershipError",
  { sessionId: Schema.String }
) {}

/**
 * A session resolved to a record owned by a different selected agent. Separate
 * from missing ownership because the remedy differs: the session exists and is
 * resumable, just not by the agent that asked. Resolution raises it before
 * acquiring a resource, so a mismatch never spawns a process.
 */
class SessionOwnershipMismatchError extends Schema.TaggedErrorClass<SessionOwnershipMismatchError>()(
  "SessionOwnershipMismatchError",
  {
    owner: HarnessNameSchema,
    requested: HarnessNameSchema,
    sessionId: Schema.String,
  }
) {}

class DuplicateSelectedAdapterError extends Schema.TaggedErrorClass<DuplicateSelectedAdapterError>()(
  "DuplicateSelectedAdapterError",
  { harness: HarnessNameSchema }
) {}

type SelectedAdapterEvent =
  | AgentAdapterEvent
  | { readonly event: AgentRuntimeEvent; readonly type: "runtime-event" };

type SelectedAdapterInteractionResponse =
  | {
      readonly correlationId: string;
      readonly kind: "permission";
      readonly response:
        | { readonly outcome: "cancelled" }
        | {
            readonly optionKind: PermissionOptionKind;
            readonly outcome: "selected";
          };
    }
  | {
      readonly correlationId: string;
      readonly kind: "elicitation";
      readonly response:
        | {
            readonly action: "accept";
            readonly content?: Readonly<
              Record<string, boolean | number | string | readonly string[]>
            >;
          }
        | {
            readonly action: Exclude<ElicitationResolvedAction, "accept">;
          };
    };

interface SelectedAdapterShape {
  readonly cancel: Effect.Effect<void, SelectedAdapterError>;
  /**
   * Adapter-private durable state for a session, read after creation and stored
   * opaquely in the ownership record. An adapter that can rebuild a session from
   * the ACP session ID alone implements neither this nor {@link restoreState};
   * Pi cannot, because `session/load` resolves through its own map from ACP
   * session ID to session file.
   */
  readonly captureState?:
    | ((
        sessionId: string
      ) => Effect.Effect<string | undefined, SelectedAdapterError>)
    | undefined;
  readonly createSession: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, SelectedAdapterError>;
  readonly initialize: Effect.Effect<void, SelectedAdapterError>;
  readonly loadSession: (
    sessionId: string
  ) => Effect.Effect<void, SelectedAdapterError>;
  readonly resumeSession: (
    sessionId: string
  ) => Effect.Effect<void, SelectedAdapterError>;
  readonly prompt: (input: {
    readonly interactionSurface?: boolean | undefined;
    readonly prompt: string;
    readonly sessionId: string;
  }) => Stream.Stream<SelectedAdapterEvent, SelectedAdapterError>;
  readonly respondInteraction?:
    | ((
        input: SelectedAdapterInteractionResponse
      ) => Effect.Effect<void, SelectedAdapterError>)
    | undefined;
  /**
   * Re-seeds the adapter's private mapping before a rebuilt resource resumes a
   * session. State the adapter can no longer resolve fails the load through the
   * adapter's own typed error rather than falling back to creation.
   */
  readonly restoreState?:
    | ((input: {
        readonly sessionId: string;
        readonly state: string;
      }) => Effect.Effect<void, SelectedAdapterError>)
    | undefined;
}

class SelectedAdapter extends Context.Service<
  SelectedAdapter,
  SelectedAdapterShape
>()("routekit-eval/selected-adapter/SelectedAdapter") {}

interface SelectedAdapterLaunch {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly dispose?: (() => Promise<void>) | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface SelectedAdapterPrepareOptions {
  readonly contextWindow?: number | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly extraSkillDirs?: readonly string[] | undefined;
  readonly parameters?: AgentParameters | undefined;
  readonly model?: string | null | undefined;
  readonly systemPrompt?: string | undefined;
}

type SelectedAdapterPrepare = (
  options: SelectedAdapterPrepareOptions
) => Promise<SelectedAdapterLaunch>;

interface SelectedAdapterOptions {
  readonly contextWindow?: number | undefined;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly extraSkillDirs?: readonly string[] | undefined;
  readonly parameters?: AgentParameters | undefined;
  readonly interactionSurface?: boolean | undefined;
  readonly model?: string | null | undefined;
  readonly prepare?: SelectedAdapterPrepare | undefined;
  readonly systemPrompt?: string | undefined;
}

interface SelectedAdapterContribution {
  readonly layer: (
    options: SelectedAdapterOptions
  ) => Layer.Layer<SelectedAdapter, SelectedAdapterError>;
  readonly name: HarnessName;
}

interface AdapterInventoryShape {
  readonly entries: readonly SelectedAdapterContribution[];
  readonly select: (
    harness: HarnessName
  ) => Effect.Effect<SelectedAdapterContribution, MissingSelectedAdapterError>;
}

class AdapterInventory extends Context.Service<
  AdapterInventory,
  AdapterInventoryShape
>()("routekit-eval/selected-adapter/AdapterInventory") {}

const layerAdapterInventory = (
  contributions: readonly SelectedAdapterContribution[]
): Layer.Layer<AdapterInventory, DuplicateSelectedAdapterError> =>
  Layer.effect(
    AdapterInventory,
    Effect.gen(function* () {
      const entries = Object.freeze([...contributions]);
      const byName = new Map<HarnessName, SelectedAdapterContribution>();
      for (const contribution of entries) {
        if (byName.has(contribution.name)) {
          return yield* new DuplicateSelectedAdapterError({
            harness: contribution.name,
          });
        }
        byName.set(contribution.name, contribution);
      }
      return AdapterInventory.of({
        entries,
        select: (harness) => {
          const contribution = byName.get(harness);
          return contribution === undefined
            ? Effect.fail(new MissingSelectedAdapterError({ harness }))
            : Effect.succeed(contribution);
        },
      });
    })
  );

export {
  AdapterInventory,
  DuplicateSelectedAdapterError,
  layerAdapterInventory,
  MissingSelectedAdapterError,
  MissingSessionOwnershipError,
  SelectedAdapter,
  SelectedAdapterError,
  SessionOwnershipMismatchError,
};
export type {
  AdapterInventoryShape,
  SelectedAdapterContribution,
  SelectedAdapterLaunch,
  SelectedAdapterOptions,
  SelectedAdapterEvent,
  SelectedAdapterInteractionResponse,
  SelectedAdapterPrepare,
  SelectedAdapterPrepareOptions,
  SelectedAdapterShape,
};
