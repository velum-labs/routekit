import { Effect } from "effect";

import type {
  FeatureIntrospection,
  FeaturesIntrospectionResponse,
} from "../../../../contracts/internal/src/runtime/feature-introspection.ts";

import { FeatureRuntime } from "../feature-runtime/service.ts";

const inspectFeatureBoot = Effect.fn("RuntimeHttp.featuresInspectBoot")(
  function* (featuresRoot: string | undefined) {
    if (featuresRoot === undefined) {
      return yield* Effect.succeedNone;
    }
    const featureRuntime = yield* FeatureRuntime;
    return yield* featureRuntime.inspect(featuresRoot).pipe(Effect.option);
  }
);

/**
 * `GET /api/features` body: every registered `api`/hook contribution as
 * `{ features: [{ featureId, routes, hasExports, hooks, subscriptions }] }`,
 * sorted by feature id — the "what is mounted where" debugging surface (RFC
 * 0002 api.md). Never fails; no features root (or a failed boot) yields an empty
 * list, matching the raw route. Reads the ambient {@link FeatureRuntime}.
 */
const featuresIntrospectionBody = Effect.fn(
  "RuntimeHttp.featuresIntrospectionBody"
)(function* (featuresRoot: string | undefined) {
  const boot = yield* inspectFeatureBoot(featuresRoot);
  const apiEntries = boot._tag === "None" ? [] : boot.value.apiRegistry.entries;
  const hookRegistry =
    boot._tag === "None" ? undefined : boot.value.hookRegistry;
  const featureIds = new Set([
    ...apiEntries.map((entry) => entry.featureId),
    ...(hookRegistry?.entries.map((hook) => hook.providerFeatureId) ?? []),
    ...(hookRegistry?.subscriptions.map(
      (subscription) => subscription.consumerFeatureId
    ) ?? []),
  ]);
  const features: readonly FeatureIntrospection[] =
    boot._tag === "None"
      ? []
      : [...featureIds]
          .map((featureId) => {
            const entry = apiEntries.find(
              (candidate) => candidate.featureId === featureId
            );
            return {
              featureId,
              hasExports: entry?.api.exports !== undefined,
              hooks: (hookRegistry?.entries ?? [])
                .filter((hook) => hook.providerFeatureId === featureId)
                .map((hook) => ({
                  flavor: hook.flavor,
                  name: hook.name.slice(featureId.length + 1),
                }))
                .toSorted((left, right) => left.name.localeCompare(right.name)),
              routes: Object.keys(entry?.api.routes ?? {}).toSorted(),
              subscriptions: (hookRegistry?.subscriptions ?? [])
                .filter(
                  (subscription) => subscription.consumerFeatureId === featureId
                )
                .map((subscription) => subscription.key)
                .toSorted(),
            };
          })
          .toSorted((left, right) =>
            left.featureId.localeCompare(right.featureId)
          );

  return { features } satisfies FeaturesIntrospectionResponse;
});

export { featuresIntrospectionBody };
