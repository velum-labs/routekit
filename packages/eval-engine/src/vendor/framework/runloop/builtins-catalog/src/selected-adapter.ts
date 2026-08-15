import { Effect, Layer } from "effect";

import type { LoggerShape } from "../../../contracts/internal/src/runtime/services.ts";
import type { SelectedAdapterCoordinator } from "../../../engine/selected-adapter/src/coordinator.ts";
import type { SelectedAdapterContribution } from "../../../engine/selected-adapter/src/inventory.ts";

import { Logger } from "../../../engine/runtime-io/src/logger.ts";
import { layerSelectedAdapterCoordinator } from "../../../engine/selected-adapter/src/coordinator.ts";
import { layerAdapterInventory } from "../../../engine/selected-adapter/src/inventory.ts";
import { makeClaudeSelectedAdapterContribution } from "./selected-adapter-contributions/claude.ts";
import { makeCodexSelectedAdapterContribution } from "./selected-adapter-contributions/codex.ts";
import { makePiSelectedAdapterContribution } from "./selected-adapter-contributions/pi.ts";
import { nodeServicesLayer } from "../../local/src/runtime/io-layer.ts";
import { layerSessionOwnershipStoreLive } from "../../local/src/selected-adapter/ownership-store-live.ts";

/**
 * The built-in selected-adapter (ACP coordinator-core, ORI-548) inventory.
 * Pi (ORI-429) and Claude (ORI-430) are production cutovers. This array is
 * the one place that changes, so cutovers land additively instead of editing
 * the catalog wiring below.
 */
const makeBuiltInSelectedAdapterContributions = (
  logger: LoggerShape
): readonly SelectedAdapterContribution[] => [
  makePiSelectedAdapterContribution(logger),
  makeClaudeSelectedAdapterContribution(logger),
  makeCodexSelectedAdapterContribution(logger),
];
const builtInSelectedAdapterNames = ["pi", "claude", "codex"] as const;

/**
 * Composed `SelectedAdapterCoordinator` Layer for the built-in inventory
 * above. Adapter resources are acquired lazily when the coordinator receives
 * an invocation.
 */
const builtInSelectedAdapterCoordinatorLayer: Layer.Layer<
  SelectedAdapterCoordinator,
  never,
  Logger
> = Layer.unwrap(
  Effect.gen(function* () {
    const logger = yield* Logger;
    return layerSelectedAdapterCoordinator.pipe(
      Layer.provide(
        layerAdapterInventory(makeBuiltInSelectedAdapterContributions(logger))
      ),
      // Platform services are discharged here rather than surfaced on the
      // catalog's requirements, the same way harnessWorkspaceMaterializerLayer
      // does in layers.ts: this module is already the built-in composition root.
      Layer.provide(
        layerSessionOwnershipStoreLive.pipe(Layer.provide(nodeServicesLayer))
      ),
      Layer.orDie
    );
  })
);

export {
  builtInSelectedAdapterNames,
  makeBuiltInSelectedAdapterContributions,
  builtInSelectedAdapterCoordinatorLayer,
};
