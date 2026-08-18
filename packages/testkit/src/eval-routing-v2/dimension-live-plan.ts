import type { RoutingAreaCatalog } from "@velum-labs/routekit-eval-contracts";

export type AreaLivePlanEntry = Readonly<{
  areaId: string;
  brief: string;
  probe: string;
  sourceFiles: readonly string[];
}>;

export type AreaLivePlan = Readonly<{
  schemaVersion: 1;
  catalogId: string;
  catalogVersion: number;
  status: "testdrive";
  casesPerArea: 5;
  areas: readonly AreaLivePlanEntry[];
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

export function validateAreaLivePlan(
  value: unknown,
  catalog: RoutingAreaCatalog,
  sourceInventory: readonly string[]
): AreaLivePlan {
  const root = record(value);
  const catalogId = boundedString(root?.catalogId, 1, 128);
  const catalogVersion = root?.catalogVersion;
  if (
    root?.schemaVersion !== 1 ||
    catalogId === undefined ||
    !Number.isSafeInteger(catalogVersion) ||
    (catalogVersion as number) < 1 ||
    root.status !== "testdrive" ||
    root.casesPerArea !== 5 ||
    !Array.isArray(root.areas)
  ) {
    throw new Error("area live plan has invalid metadata");
  }
  const inventory = new Set(sourceInventory);
  const expected = catalog.areas.map((area) => area.id);
  const seen = new Set<string>();
  const areas = root.areas.map((raw): AreaLivePlanEntry => {
    const entry = record(raw);
    const areaId = boundedString(entry?.areaId, 1, 64);
    const brief = boundedString(entry?.brief, 40, 2_000);
    const probe = boundedString(entry?.probe, 12, 512);
    if (
      areaId === undefined ||
      !AREA_ID.test(areaId) ||
      brief === undefined ||
      probe === undefined ||
      !Array.isArray(entry?.sourceFiles) ||
      entry.sourceFiles.length < 1 ||
      entry.sourceFiles.length > 5 ||
      seen.has(areaId)
    ) {
      throw new Error("area live plan contains an invalid area entry");
    }
    const sourceFiles = entry.sourceFiles.map((source) => {
      if (
        typeof source !== "string" ||
        !SOURCE_FILE.test(source) ||
        source.includes("..") ||
        source.split("/").some((segment) => segment.startsWith(".")) ||
        !inventory.has(source)
      ) {
        throw new Error(`area live plan contains an invalid source for ${areaId}`);
      }
      return source;
    });
    if (new Set(sourceFiles).size !== sourceFiles.length) {
      throw new Error(`area live plan contains duplicate sources for ${areaId}`);
    }
    seen.add(areaId);
    return { areaId, brief, probe, sourceFiles };
  });
  if (
    areas.length !== expected.length ||
    expected.some((areaId, index) => areas[index]?.areaId !== areaId)
  ) {
    throw new Error("area live plan must cover the catalog exactly in catalog order");
  }
  return {
    schemaVersion: 1,
    catalogId,
    catalogVersion: catalogVersion as number,
    status: "testdrive",
    casesPerArea: 5,
    areas
  };
}
