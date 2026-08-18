import type { LayerMap } from "effect";

import { Effect, Option, Ref } from "effect";

import type { HarnessName } from "../../../contracts/internal/src/ids.ts";
import type { SessionOwnershipRecord } from "../../../contracts/internal/src/runtime/session-ownership.ts";

import { SessionId } from "../../../contracts/internal/src/ids.ts";

import type {
  SelectedAdapterContribution,
  SelectedAdapterOptions,
  SelectedAdapterPrepare,
  SelectedAdapter,
  SelectedAdapterError,
} from "./inventory.ts";
import type { SessionOwnershipStoreShape } from "./ownership-store.ts";

import {
  MissingSessionOwnershipError,
  SessionOwnershipMismatchError,
} from "./inventory.ts";

const MAX_RETAINED_SESSIONS = 64;

const freshLaunchId = (): string => globalThis.crypto.randomUUID();

interface AdapterResourceKey {
  readonly contribution: SelectedAdapterContribution;
  readonly options: SelectedAdapterOptions;
  readonly resourceId: string;
}

type AdapterResources = LayerMap.LayerMap<
  AdapterResourceKey,
  SelectedAdapter,
  SelectedAdapterError
>;

/**
 * Live resources keyed by session, in front of the durable store. Derived state:
 * losing it costs a rebuild, never a session.
 */
type SessionCache = Ref.Ref<ReadonlyMap<string, AdapterResourceKey>>;

/**
 * The parts of an invocation that decide which resource serves it. Narrower than
 * the invocation itself so resolution cannot reach the prompt or the cancel
 * signal, neither of which may influence which session a caller resumes.
 */
interface ResolutionRequest {
  readonly contextWindow?: number | undefined;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly extraSkillDirs?: readonly string[] | undefined;
  readonly harness: HarnessName;
  readonly interactionSurface?: boolean | undefined;
  readonly model?: string | null | undefined;
  readonly parameters?: SelectedAdapterOptions["parameters"];
  readonly prepare?: SelectedAdapterPrepare | undefined;
  readonly systemPrompt?: string | undefined;
}

const optionsFor = (input: {
  readonly cwd: string;
  readonly extraSkillDirs?: readonly string[] | undefined;
  readonly request: ResolutionRequest;
}): SelectedAdapterOptions => ({
  contextWindow: input.request.contextWindow,
  cwd: input.cwd,
  env: {
    ...input.request.env,
    ORI_OPENROUTER_SESSION_ID:
      input.request.env?.ORI_OPENROUTER_SESSION_ID ?? freshLaunchId(),
  },
  extraSkillDirs: input.extraSkillDirs,
  interactionSurface: input.request.interactionSurface,
  model: input.request.model,
  parameters: input.request.parameters,
  prepare: input.request.prepare,
  systemPrompt: input.request.systemPrompt,
});

const rememberSession = Effect.fn("SelectedAdapterCoordinator.rememberSession")(
  function* (params: {
    readonly cache: SessionCache;
    readonly key: AdapterResourceKey;
    readonly resources: AdapterResources;
    readonly sessionId: string;
  }) {
    const evicted = yield* Ref.modify(params.cache, (current) => {
      const next = new Map(current);
      next.delete(params.sessionId);
      next.set(params.sessionId, params.key);
      const overflow: AdapterResourceKey[] = [];
      while (next.size > MAX_RETAINED_SESSIONS) {
        const oldest = next.keys().next();
        if (oldest.done === true) {
          break;
        }
        const oldestKey = next.get(oldest.value);
        next.delete(oldest.value);
        if (oldestKey !== undefined) {
          overflow.push(oldestKey);
        }
      }
      return [overflow, next] as const;
    });
    yield* Effect.forEach(evicted, (key) => params.resources.invalidate(key), {
      discard: true,
    });
  }
);

/**
 * The record written when a session is created. `adapterState` is whatever the
 * owning adapter handed back at creation, stored without inspection.
 */
const ownershipRecordFor = Effect.fn(
  "SelectedAdapterCoordinator.ownershipRecordFor"
)(function* (input: {
  readonly adapterState?: string | undefined;
  readonly key: AdapterResourceKey;
  readonly sessionId: string;
}) {
  const now = new Date(
    yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  ).toISOString();
  const record: SessionOwnershipRecord = {
    ...(input.adapterState === undefined
      ? {}
      : { adapterState: input.adapterState }),
    agent: input.key.contribution.name,
    createdAt: now,
    sessionId: SessionId.make(input.sessionId),
    setup: {
      additionalDirectories: input.key.options.extraSkillDirs ?? [],
      cwd: input.key.options.cwd,
    },
    updatedAt: now,
  };
  return record;
});

const makeFreshResourceKey = Effect.fn(
  "SelectedAdapterCoordinator.makeFreshResourceKey"
)(function* (input: {
  readonly contribution: SelectedAdapterContribution;
  readonly request: ResolutionRequest;
  readonly resources: AdapterResources;
  readonly resourceSequence: Ref.Ref<number>;
}) {
  const key: AdapterResourceKey = {
    contribution: input.contribution,
    options: optionsFor({
      cwd: input.request.cwd,
      extraSkillDirs: input.request.extraSkillDirs,
      request: input.request,
    }),
    resourceId: String(
      yield* Ref.updateAndGet(input.resourceSequence, (n) => n + 1)
    ),
  };
  return {
    context: yield* input.resources.contextEffect(key),
    key,
  };
});

const replaceResourceKey = Effect.fn(
  "SelectedAdapterCoordinator.replaceResourceKey"
)(function* (input: {
  readonly cache: SessionCache;
  readonly knownKey: AdapterResourceKey;
  readonly model: string;
  readonly resources: AdapterResources;
  readonly resourceSequence: Ref.Ref<number>;
  readonly sessionId: string;
}) {
  const key: AdapterResourceKey = {
    ...input.knownKey,
    options: {
      ...input.knownKey.options,
      model: input.model,
    },
    resourceId: String(
      yield* Ref.updateAndGet(input.resourceSequence, (n) => n + 1)
    ),
  };
  const context = yield* input.resources.contextEffect(key);
  yield* Effect.logDebug(
    `Replacing selected adapter resource for session ${input.sessionId}: model ${input.knownKey.options.model ?? "unset"} -> ${input.model}`
  );
  yield* rememberSession({
    cache: input.cache,
    key,
    resources: input.resources,
    sessionId: input.sessionId,
  });
  yield* input.resources.invalidate(input.knownKey);
  return {
    context,
    key,
  };
});

/**
 * Rebuilds a resource from a durable record. The snapshot wins over the
 * invocation for `cwd` and additional directories: those describe the session
 * that exists, and letting a later turn widen them would load the transcript
 * into an environment it never ran in.
 *
 * The rebuilt resource is deliberately not cached here. Caching belongs after
 * the session opens, because a cached entry short-circuits the store on the
 * next attempt, and the cache-hit branch never re-seeds adapter state: a
 * restore that failed once would then fail more vaguely on every retry.
 */
const rebuildFromRecord = Effect.fn(
  "SelectedAdapterCoordinator.rebuildFromRecord"
)(function* (input: {
  readonly contribution: SelectedAdapterContribution;
  readonly record: SessionOwnershipRecord;
  readonly request: ResolutionRequest;
  readonly resources: AdapterResources;
  readonly resourceSequence: Ref.Ref<number>;
}) {
  const key: AdapterResourceKey = {
    contribution: input.contribution,
    options: optionsFor({
      cwd: input.record.setup.cwd,
      extraSkillDirs: input.record.setup.additionalDirectories,
      request: input.request,
    }),
    resourceId: String(
      yield* Ref.updateAndGet(input.resourceSequence, (n) => n + 1)
    ),
  };
  const context = yield* input.resources.contextEffect(key);
  return {
    context,
    key,
  };
});

/**
 * The live-resource branch. The cache is keyed by session ID alone and carries
 * no identity of its own, so the mismatch check cannot be skipped just because a
 * resource is already leased for that ID.
 */
const resolveCachedResource = Effect.fn(
  "SelectedAdapterCoordinator.resolveCachedResource"
)(function* (input: {
  readonly cache: SessionCache;
  readonly cached: AdapterResourceKey;
  readonly request: ResolutionRequest;
  readonly resources: AdapterResources;
  readonly resourceSequence: Ref.Ref<number>;
  readonly sessionId: string;
}) {
  const { cached } = input;
  if (cached.contribution.name !== input.request.harness) {
    return yield* new SessionOwnershipMismatchError({
      owner: cached.contribution.name,
      requested: input.request.harness,
      sessionId: input.sessionId,
    });
  }
  const requested = input.request.model;
  if (
    requested === null ||
    requested === undefined ||
    cached.options.model === requested
  ) {
    return {
      adapterState: undefined,
      context: yield* input.resources.contextEffect(cached),
      key: cached,
    };
  }
  return {
    adapterState: undefined,
    ...(yield* replaceResourceKey({
      cache: input.cache,
      knownKey: cached,
      model: requested,
      resources: input.resources,
      resourceSequence: input.resourceSequence,
      sessionId: input.sessionId,
    })),
  };
});

/**
 * The only path from a supplied session ID to a live resource. The cache answers
 * first; a miss falls through to the durable store and rebuilds. No branch of
 * this function creates a session.
 */
const resolveOwnedResource = Effect.fn(
  "SelectedAdapterCoordinator.resolveOwnedResource"
)(function* (input: {
  readonly cache: SessionCache;
  readonly contribution: SelectedAdapterContribution;
  readonly request: ResolutionRequest;
  readonly resources: AdapterResources;
  readonly resourceSequence: Ref.Ref<number>;
  readonly sessionId: string;
  readonly store: SessionOwnershipStoreShape;
}) {
  const cached = (yield* Ref.get(input.cache)).get(input.sessionId);
  if (cached !== undefined) {
    return yield* resolveCachedResource({
      ...input,
      cached,
    });
  }

  const stored = yield* input.store.read(input.sessionId);
  if (Option.isNone(stored)) {
    return yield* new MissingSessionOwnershipError({
      sessionId: input.sessionId,
    });
  }
  const record = stored.value;
  if (record.agent !== input.request.harness) {
    return yield* new SessionOwnershipMismatchError({
      owner: record.agent,
      requested: input.request.harness,
      sessionId: input.sessionId,
    });
  }
  return {
    adapterState: record.adapterState,
    ...(yield* rebuildFromRecord({
      contribution: input.contribution,
      record,
      request: input.request,
      resources: input.resources,
      resourceSequence: input.resourceSequence,
    })),
  };
});

export {
  makeFreshResourceKey,
  MAX_RETAINED_SESSIONS,
  ownershipRecordFor,
  rememberSession,
  resolveOwnedResource,
};
export type {
  AdapterResourceKey,
  AdapterResources,
  ResolutionRequest,
  SessionCache,
};
