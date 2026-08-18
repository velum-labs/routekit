import { Schema } from "effect";

import { HookFlavor } from "../../../author/src/hooks-handles.ts";

const FeatureHookSummarySchema = Schema.Struct({
  flavor: HookFlavor,
  name: Schema.String,
});

const FeatureIntrospectionSchema = Schema.Struct({
  featureId: Schema.String,
  hasExports: Schema.Boolean,
  hooks: Schema.Array(FeatureHookSummarySchema),
  routes: Schema.Array(Schema.String),
  subscriptions: Schema.Array(Schema.String),
});

const FeaturesIntrospectionResponseSchema = Schema.Struct({
  features: Schema.Array(FeatureIntrospectionSchema),
});

type FeatureHookSummary = typeof FeatureHookSummarySchema.Type;
type FeatureIntrospection = typeof FeatureIntrospectionSchema.Type;
type FeaturesIntrospectionResponse =
  typeof FeaturesIntrospectionResponseSchema.Type;

export {
  FeatureHookSummarySchema,
  FeatureIntrospectionSchema,
  FeaturesIntrospectionResponseSchema,
};
export type {
  FeatureHookSummary,
  FeatureIntrospection,
  FeaturesIntrospectionResponse,
};
