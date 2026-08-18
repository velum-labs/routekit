import type { RoutingBasis } from "@velum-labs/routekit-eval-contracts";

export type DimensionLivePlanEntry = Readonly<{
  dimensionId: string;
  brief: string;
  probe: string;
  sourceFiles: readonly string[];
}>;

export type DimensionLivePlan = Readonly<{
  schemaVersion: 1;
  basisId: string;
  basisVersion: number;
  status: "testdrive";
  casesPerDimension: 5;
  dimensions: readonly DimensionLivePlanEntry[];
}>;

const AREA_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/u;
const SOURCE_FILE = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:json|md|ts|tsx|yaml|yml)$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, minimum: number, maximum: number): string | undefined {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum
    ? value
    : undefined;
}

export function validateDimensionLivePlan(
  value: unknown,
  basis: RoutingBasis,
  sourceInventory: readonly string[]
): DimensionLivePlan {
  const root = record(value);
  const basisId = boundedString(root?.basisId, 1, 128);
  const basisVersion = root?.basisVersion;
  if (
    root?.schemaVersion !== 1 ||
    basisId === undefined ||
    !Number.isSafeInteger(basisVersion) ||
    (basisVersion as number) < 1 ||
    root.status !== "testdrive" ||
    root.casesPerDimension !== 5 ||
    !Array.isArray(root.dimensions)
  ) {
    throw new Error("dimension live plan has invalid metadata");
  }
  const inventory = new Set(sourceInventory);
  const expected = basis.dimensions.map((dimension) => dimension.id);
  const seen = new Set<string>();
  const dimensions = root.dimensions.map((raw): DimensionLivePlanEntry => {
    const entry = record(raw);
    const dimensionId = boundedString(entry?.dimensionId, 1, 64);
    const brief = boundedString(entry?.brief, 40, 2_000);
    const probe = boundedString(entry?.probe, 12, 512);
    if (
      dimensionId === undefined ||
      !AREA_ID.test(dimensionId) ||
      brief === undefined ||
      probe === undefined ||
      !Array.isArray(entry?.sourceFiles) ||
      entry.sourceFiles.length < 1 ||
      entry.sourceFiles.length > 5 ||
      seen.has(dimensionId)
    ) {
      throw new Error("dimension live plan contains an invalid dimension entry");
    }
    const sourceFiles = entry.sourceFiles.map((source) => {
      if (
        typeof source !== "string" ||
        !SOURCE_FILE.test(source) ||
        source.includes("..") ||
        source.split("/").some((segment) => segment.startsWith(".")) ||
        !inventory.has(source)
      ) {
        throw new Error(`dimension live plan contains an invalid source for ${dimensionId}`);
      }
      return source;
    });
    if (new Set(sourceFiles).size !== sourceFiles.length) {
      throw new Error(`dimension live plan contains duplicate sources for ${dimensionId}`);
    }
    seen.add(dimensionId);
    return { dimensionId, brief, probe, sourceFiles };
  });
  if (
    dimensions.length !== expected.length ||
    expected.some((dimensionId, index) => dimensions[index]?.dimensionId !== dimensionId)
  ) {
    throw new Error("dimension live plan must cover the basis exactly in basis order");
  }
  return {
    schemaVersion: 1,
    basisId,
    basisVersion: basisVersion as number,
    status: "testdrive",
    casesPerDimension: 5,
    dimensions
  };
}
