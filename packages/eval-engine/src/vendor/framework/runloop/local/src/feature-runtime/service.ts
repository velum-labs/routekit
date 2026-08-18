import type { Effect } from "effect";

import { Context } from "effect";

import type { RuntimeServerError } from "../../../../contracts/internal/src/errors.ts";
import type {
  FeatureBootResult,
  FeatureDefinition,
} from "../feature-boot/types.ts";

export interface FeatureRuntimeShape {
  readonly boot: (
    featuresRoot: string
  ) => Effect.Effect<FeatureBootResult, RuntimeServerError>;
  readonly inspect: (
    featuresRoot: string
  ) => Effect.Effect<FeatureBootResult, RuntimeServerError>;
  readonly inspectDefinition: (
    featuresRoot: string
  ) => Effect.Effect<FeatureDefinition, RuntimeServerError>;
  readonly prepareReload: (
    featuresRoot: string,
    options?: FeatureRuntimeReloadOptions
  ) => Effect.Effect<PreparedFeatureReload, RuntimeServerError>;
  readonly reload: (
    featuresRoot: string,
    options?: FeatureRuntimeReloadOptions
  ) => Effect.Effect<FeatureBootResult, RuntimeServerError>;
}

export interface FeatureRuntimeReloadOptions {
  readonly affectedFeatureIds?: readonly string[];
}

export interface PreparedFeatureReload {
  readonly boot: FeatureBootResult;
  readonly commit: Effect.Effect<void>;
}

export class FeatureRuntime extends Context.Service<
  FeatureRuntime,
  FeatureRuntimeShape
>()("ori/runtime/FeatureRuntime") {}
