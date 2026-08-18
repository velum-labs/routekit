import { Layer } from "effect";

import type { HookContributionsInput } from "./registry.ts";

import {
  HookRegistry,
  wireHookContributions,
} from "./registry.ts";

/**
 * The live {@link HookRegistry} adapter: plans one feature boot's provider
 * controllers and validated subscriptions from its APIs, consumers, dependency
 * graph, and boot order. This is a factory rather than a bare `const` layer
 * because the wiring input (including the per-boot `contextFor`, which closes
 * over that boot's registries and runtime context) is a runtime binding built
 * inside the boot chain, not a `Config` value known at the composition root.
 *
 * The wiring is a pure synchronous computation ({@link wireHookContributions}),
 * so this is `Layer.sync` — no requirements, no scope, deferred until the layer
 * is built. {@link HookRegistry.layerTest} provides an inert stand-in for tests
 * that need the tag but no real wiring.
 */
export const HookRegistryLive = (
  input: HookContributionsInput
): Layer.Layer<HookRegistry> =>
  Layer.sync(HookRegistry)(() => wireHookContributions(input));
