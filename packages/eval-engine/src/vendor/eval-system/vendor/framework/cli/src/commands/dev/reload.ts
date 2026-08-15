import { ChangeClass } from "../../../../contracts/internal/src/runtime/reload.ts";
import {
  ROOT_PERSONA_FEATURE_ID,
  ROOT_PERSONA_FILE,
} from "../../../../runloop/local/src/contributions/root-persona.ts";

const EMPTY_COUNT = 0;

const FEATURE_ID_INDEX = 0;

const FIRST_SOURCE_SEGMENT_INDEX = 1;

const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const SCRATCH_SUFFIXES = [".swp", ".swo", ".tmp", "~"];

interface ReloadTrigger {
  readonly changeClass: ChangeClass;
  readonly featureId: string;
  readonly path: string;
}

interface ReloadGenerationAnalysis {
  readonly affectedFeatureIds: readonly string[];
  readonly ignoredPaths: readonly string[];
  readonly triggers: readonly ReloadTrigger[];
}

interface ReloadDependencyGraph {
  readonly dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>;
  readonly features: readonly { readonly id: string }[];
}

const membershipChangeClass = (
  featureId: string,
  previousFeatureIds: ReadonlySet<string>,
  currentFeatureIds: ReadonlySet<string>
): ReloadTrigger["changeClass"] | undefined => {
  if (currentFeatureIds.has(featureId) && !previousFeatureIds.has(featureId)) {
    return ChangeClass.FeatureAdded;
  }
  if (previousFeatureIds.has(featureId) && !currentFeatureIds.has(featureId)) {
    return ChangeClass.FeatureRemoved;
  }
  return undefined;
};

// A bare feature directory (empty source path) is not a reloadable change.
const sourcePathChangeClass = (
  sourcePath: string
): ReloadTrigger["changeClass"] | undefined => {
  if (sourcePath === "feature.json") {
    return ChangeClass.Manifest;
  }
  if (sourcePath === "package.json") {
    return ChangeClass.Package;
  }
  return sourcePath.length === EMPTY_COUNT
    ? undefined
    : ChangeClass.Contribution;
};

// Feature add/remove (membership flips between the previous and current boot)
// take precedence over the manifest/package/contribution classes inferred from
// the source path.
const classifyFeatureChange = (input: {
  readonly currentFeatureIds: ReadonlySet<string>;
  readonly currentFeatureIdsKnown: boolean;
  readonly featureId: string;
  readonly path: string;
  readonly previousFeatureIds: ReadonlySet<string>;
  readonly sourcePath: string;
}): ReloadTrigger | undefined => {
  const {
    currentFeatureIds,
    currentFeatureIdsKnown,
    featureId,
    path,
    previousFeatureIds,
    sourcePath,
  } = input;
  const membershipClass = currentFeatureIdsKnown
    ? membershipChangeClass(featureId, previousFeatureIds, currentFeatureIds)
    : undefined;
  const changeClass = membershipClass ?? sourcePathChangeClass(sourcePath);
  if (changeClass === undefined) {
    return undefined;
  }
  return {
    changeClass,
    featureId,
    path,
  };
};

const classifyReloadTrigger = (input: {
  readonly currentFeatureIds: ReadonlySet<string>;
  readonly currentFeatureIdsKnown: boolean;
  readonly path: string;
  readonly previousFeatureIds: ReadonlySet<string>;
}): ReloadTrigger | undefined => {
  // The workspace-root `routekit-eval.md` persona (RFC 0002 root-persona.md) sits above the feature
  // root, so it has no feature-id segment. It is re-read on every boot, so it
  // affects no individual feature; classify it as its own change class with the
  // synthetic root feature id (which can never collide with a `features/*` id).
  if (input.path === ROOT_PERSONA_FILE) {
    return {
      changeClass: ChangeClass.RootPersona,
      featureId: ROOT_PERSONA_FEATURE_ID,
      path: input.path,
    };
  }

  const segments = input.path.split("/").filter(Boolean);
  const featureId = segments.at(FEATURE_ID_INDEX);
  if (featureId === undefined) {
    return undefined;
  }

  return classifyFeatureChange({
    currentFeatureIds: input.currentFeatureIds,
    currentFeatureIdsKnown: input.currentFeatureIdsKnown,
    featureId,
    path: input.path,
    previousFeatureIds: input.previousFeatureIds,
    sourcePath: segments.slice(FIRST_SOURCE_SEGMENT_INDEX).join("/"),
  });
};

interface DependencyGraphs {
  readonly currentDependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly previousDependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

const formatReloadAnalysis = (analysis: ReloadGenerationAnalysis): string => {
  const triggerText =
    analysis.triggers.length === EMPTY_COUNT
      ? "none"
      : analysis.triggers
          .map(
            (trigger) =>
              `${trigger.path} (${trigger.changeClass}:${trigger.featureId})`
          )
          .join(", ");
  const affectedText =
    analysis.affectedFeatureIds.length === EMPTY_COUNT
      ? "none"
      : analysis.affectedFeatureIds.join(", ");
  return `trigger=${triggerText}; affected=${affectedText}`;
};

const normalizePath = (path: string): string =>
  path.replaceAll("\\", "/").replace(/^\/+/u, "");

const featureIdSet = (
  definition: ReloadDependencyGraph | undefined
): ReadonlySet<string> =>
  definition === undefined
    ? new Set()
    : new Set(definition.features.map((feature) => feature.id));

const dependentsOf = (
  featureId: string,
  dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>
): readonly string[] => {
  const dependents: string[] = [];
  for (const [candidate, dependencies] of dependenciesByFeature) {
    if (dependencies.has(featureId)) {
      dependents.push(candidate);
    }
  }
  return dependents;
};

const normalizeChangedPaths = (paths: readonly string[]): readonly string[] => [
  ...new Set(
    paths.map(normalizePath).filter((path) => path.length !== EMPTY_COUNT)
  ),
];

const matchesIgnorePattern = (path: string, pattern: string): boolean => {
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.length === EMPTY_COUNT) {
    return false;
  }
  if (normalizedPattern.endsWith("/")) {
    return (
      path.startsWith(normalizedPattern) ||
      path.includes(`/${normalizedPattern}`)
    );
  }
  return (
    path === normalizedPattern ||
    path.startsWith(`${normalizedPattern}/`) ||
    path.includes(`/${normalizedPattern}/`)
  );
};

const addTransitiveDependents = (
  affected: Set<string>,
  featureId: string,
  dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>
): void => {
  const queue = [featureId];
  const seen = new Set(queue);
  while (queue.length !== EMPTY_COUNT) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    for (const dependent of dependentsOf(current, dependenciesByFeature)) {
      if (seen.has(dependent)) {
        continue;
      }
      seen.add(dependent);
      affected.add(dependent);
      queue.push(dependent);
    }
  }
};

const isIgnoredReloadPath = (
  path: string,
  ignorePatterns: readonly string[] = []
): boolean => {
  const normalizedPath = normalizePath(path);
  const segments = path.split("/").filter(Boolean);
  if (
    segments.some((segment) => IGNORED_DIRECTORIES.has(segment)) ||
    segments.some((segment) => segment.startsWith(".") && segment !== ".env")
  ) {
    return true;
  }

  const filename = segments.at(-1) ?? "";
  return (
    SCRATCH_SUFFIXES.some((suffix) => filename.endsWith(suffix)) ||
    ignorePatterns.some((pattern) =>
      matchesIgnorePattern(normalizedPath, pattern)
    )
  );
};

const addFeatureAndDependents = (
  affected: Set<string>,
  featureId: string,
  dependenciesByFeature: ReadonlyMap<string, ReadonlySet<string>>
): void => {
  affected.add(featureId);
  addTransitiveDependents(affected, featureId, dependenciesByFeature);
};

const applyTriggerToAffected = (
  affected: Set<string>,
  trigger: ReloadTrigger,
  graphs: DependencyGraphs
): void => {
  switch (trigger.changeClass) {
    case ChangeClass.Contribution:
    case ChangeClass.Manifest: {
      addFeatureAndDependents(
        affected,
        trigger.featureId,
        graphs.currentDependencies
      );
      break;
    }
    case ChangeClass.Package: {
      addFeatureAndDependents(
        affected,
        trigger.featureId,
        graphs.previousDependencies
      );
      addFeatureAndDependents(
        affected,
        trigger.featureId,
        graphs.currentDependencies
      );
      break;
    }
    case ChangeClass.FeatureAdded: {
      addFeatureAndDependents(
        affected,
        trigger.featureId,
        graphs.currentDependencies
      );
      break;
    }
    case ChangeClass.FeatureRemoved: {
      addTransitiveDependents(
        affected,
        trigger.featureId,
        graphs.previousDependencies
      );
      break;
    }
    case ChangeClass.RootPersona: {
      // The root persona is re-read on every boot regardless of the affected
      // set, so it affects no individual feature. An empty affected set is the
      // signal to the reload pipeline to carry every feature's contributions
      // forward unchanged while the persona alone is re-imported.
      break;
    }
    default: {
      trigger.changeClass satisfies never;
      break;
    }
  }
};

export const computeAffectedFeatureIds = (input: {
  readonly current?: ReloadDependencyGraph | undefined;
  readonly previous?: ReloadDependencyGraph | undefined;
  readonly triggers: readonly ReloadTrigger[];
}): readonly string[] => {
  const affected = new Set<string>();
  const previousDependencies = input.previous?.dependenciesByFeature;
  const currentDependencies =
    input.current?.dependenciesByFeature ?? previousDependencies;
  const graphs: DependencyGraphs = {
    currentDependencies: currentDependencies ?? new Map(),
    previousDependencies: previousDependencies ?? new Map(),
  };

  for (const trigger of input.triggers) {
    applyTriggerToAffected(affected, trigger, graphs);
  }

  return [...affected].toSorted();
};

export const analyzeReloadGeneration = (input: {
  readonly changedPaths: readonly string[];
  readonly current?: ReloadDependencyGraph | undefined;
  readonly ignorePatterns?: readonly string[] | undefined;
  readonly previous?: ReloadDependencyGraph | undefined;
}): ReloadGenerationAnalysis => {
  const previousFeatureIds = featureIdSet(input.previous);
  const currentFeatureIds = featureIdSet(input.current);
  const currentFeatureIdsKnown = input.current !== undefined;
  const triggers: ReloadTrigger[] = [];
  const ignoredPaths: string[] = [];

  for (const path of normalizeChangedPaths(input.changedPaths)) {
    if (isIgnoredReloadPath(path, input.ignorePatterns)) {
      ignoredPaths.push(path);
      continue;
    }

    const trigger = classifyReloadTrigger({
      currentFeatureIds,
      currentFeatureIdsKnown,
      path,
      previousFeatureIds,
    });
    if (trigger === undefined) {
      ignoredPaths.push(path);
      continue;
    }
    triggers.push(trigger);
  }

  return {
    affectedFeatureIds: computeAffectedFeatureIds({
      current: input.current,
      previous: input.previous,
      triggers,
    }),
    ignoredPaths: ignoredPaths.toSorted(),
    triggers,
  };
};

export { classifyReloadTrigger, formatReloadAnalysis, isIgnoredReloadPath };
export type { ReloadTrigger, ReloadGenerationAnalysis, ReloadDependencyGraph };
